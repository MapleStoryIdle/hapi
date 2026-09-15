import { Hono } from 'hono'
import { ManagedSkillReconcileResponseSchema } from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import { ensureManagedSkillCached, managedSkillCatalog, managedSkillMachineState } from '../../managedSkills'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'
import { getManagedSkillDefinition } from '../../managedSkillCatalog'

export function createManagedSkillsRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/managed-skills', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const machines = engine.getMachinesByNamespace(c.get('namespace'))
        return c.json({
            skills: managedSkillCatalog().map((skill) => ({
                ...skill,
                machines: machines.map((machine) => managedSkillMachineState(machine, skill))
            }))
        })
    })

    app.post('/managed-skills/:skillId/machines/:machineId/cache', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const skillId = c.req.param('skillId')
        if (!getManagedSkillDefinition(skillId)) return c.json({ error: 'Skill not found' }, 404)
        const machine = requireMachine(c, engine, c.req.param('machineId'))
        if (machine instanceof Response) return machine
        try {
            await ensureManagedSkillCached(engine, machine, skillId)
            return c.json({ ok: true })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Could not cache skill' }, 409)
        }
    })

    app.delete('/managed-skills/:skillId/machines/:machineId/cache', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)
        const skillId = c.req.param('skillId')
        if (!getManagedSkillDefinition(skillId)) return c.json({ error: 'Skill not found' }, 404)
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
