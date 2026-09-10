import { Hono } from 'hono'
import { SessionPinInputSchema, SessionPinMigrationSchema } from '@hapi/protocol/sessionPins'
import type { Store } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'

export function createSessionPinRoutes(store: Store, getSseManager: () => SSEManager | null = () => null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const notify = (namespace: string) => getSseManager()?.broadcast({ type: 'session-pins-updated', namespace })
    app.get('/session-pins', c => c.json(store.sessionPins.list(c.get('namespace'))))
    app.put('/session-pins', async c => {
        const body = SessionPinInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'Invalid session pin' }, 400)
        const namespace = c.get('namespace')
        if (!store.sessionPins.set(namespace, body.data.source, body.data.pinned)) return c.json({ error: 'Source not found' }, 404)
        notify(namespace)
        return c.json(store.sessionPins.list(namespace))
    })
    app.post('/session-pins/migrate', async c => {
        const body = SessionPinMigrationSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'Invalid session pins' }, 400)
        const namespace = c.get('namespace')
        store.sessionPins.migrate(namespace, body.data.sources)
        notify(namespace)
        return c.json(store.sessionPins.list(namespace))
    })
    return app
}
