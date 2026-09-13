import { Hono } from 'hono'
import { SessionLabelInputSchema } from '@hapi/protocol/sessionLabels'
import type { Store } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'

export function createSessionLabelRoutes(store: Store, getSseManager: () => SSEManager | null = () => null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const notify = (namespace: string) => getSseManager()?.broadcast({ type: 'session-labels-updated', namespace })

    app.get('/session-labels', c => c.json(store.sessionLabels.list(c.get('namespace'))))

    app.put('/session-labels', async c => {
        const body = SessionLabelInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'Invalid session label' }, 400)
        const result = store.sessionLabels.set(c.get('namespace'), body.data.source, body.data.label)
        if (result === 'ok') notify(c.get('namespace'))
        return result === 'ok' ? c.json({ ok: true as const }) : c.json({ error: result }, 404)
    })

    return app
}
