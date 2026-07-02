import {
    AcceptRemoteServerCandidateRequestSchema,
    SetSessionRemoteServerRequestSchema,
    UpdateRemoteServerRequestSchema
} from '@hapi/protocol'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function createRemoteServersRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/remote-servers', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        return c.json({ servers: engine.listRemoteServersByNamespace(c.get('namespace')) })
    })

    app.get('/remote-server-candidates', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        return c.json({ candidates: engine.listRemoteServerCandidatesByNamespace(c.get('namespace')) })
    })

    app.patch('/remote-servers/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const body = await c.req.json().catch(() => null)
        const parsed = UpdateRemoteServerRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        try {
            const server = engine.updateRemoteServer(c.req.param('id'), c.get('namespace'), parsed.data)
            if (!server) {
                return c.json({ error: 'Remote server not found' }, 404)
            }
            return c.json({ server })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to update remote server'
            return c.json({ error: message }, 409)
        }
    })

    app.delete('/remote-servers/:id', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const deleted = engine.deleteRemoteServer(c.req.param('id'), c.get('namespace'))
        if (!deleted) {
            return c.json({ error: 'Remote server not found' }, 404)
        }
        return c.json({ ok: true })
    })

    app.post('/remote-server-candidates/:id/accept', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const body = await c.req.json().catch(() => ({}))
        const parsed = AcceptRemoteServerCandidateRequestSchema.safeParse(body ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const result = engine.acceptRemoteServerCandidate(c.req.param('id'), c.get('namespace'), parsed.data)
        if (result.type === 'error') {
            const status = result.code === 'candidate_not_found' ? 404
                : result.code === 'target_conflict' ? 409
                    : 400
            return c.json({ error: result.message, code: result.code }, status)
        }
        return c.json({
            server: result.server,
            candidate: result.candidate,
            created: result.created
        })
    })

    app.post('/remote-server-candidates/:id/dismiss', (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const candidate = engine.dismissRemoteServerCandidate(c.req.param('id'), c.get('namespace'))
        if (!candidate) {
            return c.json({ error: 'Remote server candidate not found' }, 404)
        }
        return c.json({ candidate })
    })

    app.post('/sessions/:id/remote-server', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const body = await c.req.json().catch(() => null)
        const parsed = SetSessionRemoteServerRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const result = engine.setSessionRemoteServerContext(
            sessionResult.sessionId,
            c.get('namespace'),
            parsed.data.remoteServerId
        )
        if (!result.ok) {
            const status = result.code === 'server_not_found' ? 404
                : result.code === 'server_not_verified_for_machine' || result.code === 'unsupported_agent' ? 409
                : result.code === 'access_denied' ? 403
                    : 404
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ session: result.session })
    })

    return app
}
