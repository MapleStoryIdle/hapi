import {
    OpenVikingContextListRequestSchema,
    OpenVikingContextReadRequestSchema,
    OpenVikingSearchRequestSchema
} from '@hapi/protocol/apiTypes'
import { Hono, type Context } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine, requireSyncEngine } from './guards'

function contextUri(queryUri: string | undefined): string | undefined {
    return queryUri?.trim() || undefined
}

export function createOpenVikingRoutes(getSyncEngine: () => SyncEngine | null, store?: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const isEnabled = (namespace: string): boolean => store?.pluginSettings.isEnabled(namespace, 'openviking') ?? true
    const requireEnabled = (c: Context<WebAppEnv>): Response | null => {
        return isEnabled(c.get('namespace')) ? null : c.json({ error: 'OpenViking plugin is disabled' }, 409)
    }

    app.get('/plugins/openviking', c => c.json({ enabled: isEnabled(c.get('namespace')) }))
    app.put('/plugins/openviking', async c => {
        if (!store) return c.json({ error: 'Plugin settings are unavailable' }, 503)
        const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null
        if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'Invalid plugin setting' }, 400)
        store.pluginSettings.setEnabled(c.get('namespace'), 'openviking', body.enabled)
        return c.json({ enabled: body.enabled })
    })

    app.get('/openviking/machines/:id/status', async (c) => {
        const disabled = requireEnabled(c)
        if (disabled) return disabled
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
        const disabled = requireEnabled(c)
        if (disabled) return disabled
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
        const disabled = requireEnabled(c)
        if (disabled) return disabled
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

    app.get('/openviking/machines/:id/metrics', async (c) => {
        const disabled = requireEnabled(c)
        if (disabled) return disabled
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) return c.json({ ok: false, error: 'Runner is offline' }, 409)
        try {
            const result = await engine.getOpenVikingMetrics(machineId)
            return c.json(result, result.ok ? 200 : 502)
        } catch (error) {
            return c.json({ ok: false, error: error instanceof Error ? error.message : 'Failed to read OpenViking metrics' }, 502)
        }
    })

    app.post('/openviking/machines/:id/search', async (c) => {
        const disabled = requireEnabled(c)
        if (disabled) return disabled
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) return c.json({ ok: false, error: 'Runner is offline' }, 409)
        const parsed = OpenVikingSearchRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ ok: false, error: 'Invalid OpenViking search request' }, 400)
        try {
            const result = await engine.searchOpenViking(machineId, parsed.data)
            return c.json(result, result.ok ? 200 : 502)
        } catch (error) {
            return c.json({ ok: false, error: error instanceof Error ? error.message : 'OpenViking search failed' }, 502)
        }
    })

    app.post('/openviking/machines/:id/quality', async (c) => {
        const disabled = requireEnabled(c)
        if (disabled) return disabled
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) return c.json({ ok: false, error: 'Runner is offline' }, 409)
        try {
            const result = await engine.getOpenVikingQuality(machineId)
            return c.json(result, result.ok ? 200 : 502)
        } catch (error) {
            return c.json({ ok: false, error: error instanceof Error ? error.message : 'OpenViking quality scan failed' }, 502)
        }
    })

    return app
}
