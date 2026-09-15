import { describe, expect, it } from 'bun:test'
import type { Machine } from '@hapi/protocol'
import type { SyncEngine } from './sync/syncEngine'
import { Store } from './store'
import { ensureManagedSkillCached, managedSkillCatalog, mergeEnabledManagedSkills } from './managedSkills'

function machine(managedSkills?: NonNullable<Machine['metadata']>['managedSkills']): Machine {
    return {
        id: 'runner-1', namespace: 'default', seq: 1, createdAt: 1, updatedAt: 1,
        active: true, activeAt: 1, metadataVersion: 1, runnerState: null, runnerStateVersion: 1,
        metadata: {
            host: 'runner', platform: 'test', happyCliVersion: '1.0.0', runnerVersion: '1.1.2', managedSkills
        }
    }
}

describe('managed skills', () => {
    it('skips transfer when the Runner cache has the current Hub version and digest', async () => {
        const skill = managedSkillCatalog()[0]!
        let calls = 0
        const engine = { reconcileManagedSkill: async () => { calls += 1 } } as unknown as SyncEngine

        await ensureManagedSkillCached(engine, machine({
            [skill.id]: { version: skill.version, sha256: skill.sha256, state: 'ready' }
        }), skill.id)

        expect(calls).toBe(0)
    })

    it('refreshes a stale Runner cache from the Hub library', async () => {
        const skill = managedSkillCatalog()[0]!
        const payloads: unknown[] = []
        const engine = {
            reconcileManagedSkill: async (_machineId: string, payload: unknown) => {
                payloads.push(payload)
                return {
                    success: true,
                    status: { id: skill.id, version: skill.version, sha256: skill.sha256, state: 'ready' }
                }
            }
        } as unknown as SyncEngine

        await ensureManagedSkillCached(engine, machine({
            [skill.id]: { version: '0.9.0', sha256: '0'.repeat(64), state: 'ready' }
        }), skill.id)

        expect(payloads).toHaveLength(1)
        expect(payloads[0]).toMatchObject({ id: skill.id, version: skill.version, sha256: skill.sha256 })
        expect(payloads[0]).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: 'SKILL.md' })]) })
    })

    it('lets an enabled Hub Skill replace a same-named Runner Skill', () => {
        const store = new Store(':memory:')
        try {
            store.pluginSettings.setEnabled('workspace-a', 'managed-skill:agent-team', true)
            const result = mergeEnabledManagedSkills([
                { name: 'agent-team', description: 'Local copy', scope: 'user' as const },
                { name: 'other', description: 'Other', scope: 'user' as const }
            ], store, 'workspace-a')
            expect(result).toContainEqual(expect.objectContaining({ name: 'agent-team', scope: 'hub' }))
            expect(result).not.toContainEqual(expect.objectContaining({ name: 'agent-team', description: 'Local copy' }))
            expect(result).toContainEqual(expect.objectContaining({ name: 'other', scope: 'user' }))
        } finally {
            store.close()
        }
    })
})
