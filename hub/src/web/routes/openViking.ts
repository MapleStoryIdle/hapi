import {
    OpenVikingContextListRequestSchema,
    OpenVikingContextReadRequestSchema
} from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine, requireSyncEngine } from './guards'

function contextUri(queryUri: string | undefined): string | undefined {
    return queryUri?.trim() || undefined
}

export function createOpenVikingRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/openviking/machines/:id/status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) {
            return c.json({ ok: false, error: 'Runner is offline' }, 409)
        }

        try {
            return c.json(await engine.getOpenVikingStatus(machineId))
        } catch (error) {
            return c.json({
                ok: false,
                error: error instanceof Error ? error.message : 'OpenViking is unavailable'
            }, 502)
        }
    })

    app.get('/openviking/machines/:id/context', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) {
            return c.json({ error: 'Runner is offline' }, 409)
        }

        const parsed = OpenVikingContextListRequestSchema.safeParse({
            uri: contextUri(c.req.query('uri'))
        })
        if (!parsed.success) {
            return c.json({ error: 'Invalid OpenViking context URI' }, 400)
        }

        try {
            const result = await engine.listOpenVikingContext(machineId, parsed.data)
            return c.json(result, result.ok ? 200 : 502)
        } catch (error) {
            return c.json({
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenViking context'
            }, 502)
        }
    })

    app.get('/openviking/machines/:id/context/read', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) {
            return c.json({ error: 'Runner is offline' }, 409)
        }

        const parsed = OpenVikingContextReadRequestSchema.safeParse({
            uri: contextUri(c.req.query('uri'))
        })
        if (!parsed.success) {
            return c.json({ error: 'Invalid OpenViking context URI' }, 400)
        }

        try {
            const result = await engine.readOpenVikingContext(machineId, parsed.data)
            return c.json(result, result.ok ? 200 : 502)
        } catch (error) {
            return c.json({
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to read OpenViking context'
            }, 502)
        }
    })

    return app
}
