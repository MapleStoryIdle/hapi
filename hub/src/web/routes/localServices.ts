import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { OpenLocalServiceSchema } from '@hapi/protocol/localServices'
import type { SyncEngine } from '../../sync/syncEngine'
import { LocalServiceError, type LocalServiceManager } from '../../localServices/manager'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine, requireSession, requireSyncEngine } from './guards'

export function createLocalServiceRoutes(
    getSyncEngine: () => SyncEngine | null,
    getManager: () => LocalServiceManager | null
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('/local-services/*', bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ error: 'Request too large' }, 413) }))
    app.post('/local-services/open', async (c) => {
        if (Number(c.req.header('content-length') ?? 0) > 16_384) return c.json({ error: 'Request too large' }, 413)
        const parsed = OpenLocalServiceSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid local service URL or session', code: 'local_service_invalid_url' }, 400)
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const { source, url } = parsed.data
        let machineId: string
        if (source.type === 'session') {
            const access = requireSession(c, engine, source.sessionId)
            if (access instanceof Response) return access
            const boundMachine = access.session.metadata?.machineId
            if (!boundMachine) return c.json({ error: 'Session has no runner', code: 'local_service_offline' }, 409)
            machineId = boundMachine
        } else machineId = source.machineId
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) return c.json({ error: 'Runner is offline', code: 'local_service_offline' }, 409)
        const manager = getManager()
        if (!manager) return c.json({ error: 'Local service access is not configured', code: 'local_service_not_configured' }, 503)
        try {
            if (source.type === 'native-codex') {
                const status = await engine.getCodexLocalSessionStatus(machineId, source.sessionId)
                if (!status.success) return c.json({ error: 'Native session not found', code: 'local_service_session_missing' }, 404)
            }
            const opened = await manager.open({ namespace: c.get('namespace'), userId: c.get('userId') }, machineId, source, url)
            c.header('Cache-Control', 'no-store')
            return c.json(opened)
        } catch (error) {
            if (error instanceof LocalServiceError) {
                return c.json({ error: error.message, code: error.code }, error.code === 'local_service_busy' ? 429 : 502)
            }
            return c.json({ error: 'Could not connect to the local service runner', code: 'local_service_connect_failed' }, 502)
        }
    })
    return app
}
