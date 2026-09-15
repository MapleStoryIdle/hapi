import { Hono } from 'hono'
import { ManagedSkillReconcileResponseSchema } from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import {
    ensureManagedSkillCached,
    isManagedSkillEnabled,
    managedSkillCatalog,
    managedSkillMachineState,
    setManagedSkillEnabled
} from '../../managedSkills'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'
import type { Store } from '../../store'
import { z } from 'zod'
import { validateManagedSkillDefinition } from '../../managedSkillBundles'

const ManagedSkillSettingsRequestSchema = z.object({ enabled: z.boolean() }).strict()

export function createManagedSkillsRoutes(getSyncEngine: () => SyncEngine | null, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/managed-skills', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machines = engine.getMachinesByNamespace(c.get('namespace'))
        return c.json({
            skills: managedSkillCatalog(store, c.get('namespace')).map((skill) => ({
                ...skill,
                enabled: isManagedSkillEnabled(store, c.get('namespace'), skill.id),
                machines: machines.map((machine) => managedSkillMachineState(machine, skill))
            }))
        })
    })

    app.post('/managed-skills/personal', async (c) => {
        try {
            const definition = validateManagedSkillDefinition(await c.req.json())
            const result = store.managedSkillPackages.publish(definition, { namespace: c.get('namespace') })
            return c.json({
                created: result.created,
                active: result.active,
                id: result.definition.id,
                version: result.definition.version,
                sha256: result.sha256,
                visibility: 'personal' as const
            }, result.created ? 201 : 200)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Invalid Skill package' }, 400)
        }
    })

    app.get('/managed-skills/personal/:skillId/versions', (c) => {
        return c.json({ versions: store.managedSkillPackages.listVersions(c.req.param('skillId'), c.get('namespace')) })
    })

    app.post('/managed-skills/personal/:skillId/versions/:version/activate', (c) => {
        try {
            const definition = store.managedSkillPackages.activate(
                c.req.param('skillId'),
                c.req.param('version'),
                c.get('namespace')
            )
            return c.json({ ok: true, id: definition.id, version: definition.version })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Skill version not found' }, 404)
        }
    })

    app.patch('/managed-skills/:skillId', async (c) => {
        const skillId = c.req.param('skillId')
        if (!store.managedSkillPackages.getActive(skillId, c.get('namespace'))) return c.json({ error: 'Skill not found' }, 404)
        const parsed = ManagedSkillSettingsRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        setManagedSkillEnabled(store, c.get('namespace'), skillId, parsed.data.enabled)
        return c.json({ ok: true, enabled: parsed.data.enabled })
    })

    app.post('/managed-skills/:skillId/machines/:machineId/cache', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const skillId = c.req.param('skillId')
        if (!store.managedSkillPackages.getActive(skillId, c.get('namespace'))) return c.json({ error: 'Skill not found' }, 404)
        if (!isManagedSkillEnabled(store, c.get('namespace'), skillId)) return c.json({ error: 'Skill is disabled' }, 409)
        const machine = requireMachine(c, engine, c.req.param('machineId'))
        if (machine instanceof Response) return machine
        try {
            await ensureManagedSkillCached(engine, machine, skillId, store, c.get('namespace'))
            return c.json({ ok: true })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Could not cache skill' }, 409)
        }
    })

    app.delete('/managed-skills/:skillId/machines/:machineId/cache', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const skillId = c.req.param('skillId')
        if (!store.managedSkillPackages.getActive(skillId, c.get('namespace'))) return c.json({ error: 'Skill not found' }, 404)
        const machine = requireMachine(c, engine, c.req.param('machineId'))
        if (machine instanceof Response) return machine
        try {
            const result = ManagedSkillReconcileResponseSchema.parse(await engine.removeManagedSkill(machine.id, skillId))
            return c.json(result, result.success ? 200 : 409)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Could not clear skill cache' }, 409)
        }
    })

    return app
}
