import { describe, expect, it } from 'bun:test'
import type { Machine } from '@hapi/protocol'
import type { SyncEngine } from './sync/syncEngine'
import { ensureManagedSkillCached, managedSkillCatalog } from './managedSkills'

function machine(managedSkills?: NonNullable<Machine['metadata']>['managedSkills']): Machine {
    return {
        id: 'runner-1', namespace: 'default', seq: 1, createdAt: 1, updatedAt: 1,
        active: true, activeAt: 1, metadataVersion: 1, runnerState: null, runnerStateVersion: 1,
        metadata: {
            host: 'runner', platform: 'test', happyCliVersion: '1.0.0', runnerVersion: '1.1.0', managedSkills
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
    })
})
