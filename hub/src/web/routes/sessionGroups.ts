import { Hono } from 'hono'
import { SessionGroupAssignmentInputSchema, SessionGroupInputSchema, SessionGroupUpdateSchema } from '@hapi/protocol/sessionGroups'
import type { Store } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'

export function createSessionGroupRoutes(store: Store, getSseManager: () => SSEManager | null = () => null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const notify = (namespace: string) => getSseManager()?.broadcast({ type: 'session-groups-updated', namespace })

    app.get('/session-groups', c => c.json(store.sessionGroups.list(c.get('namespace'))))

    app.post('/session-groups', async c => {
        const body = SessionGroupInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'Invalid group name or emoji' }, 400)
        const group = store.sessionGroups.create(c.get('namespace'), body.data)
        notify(c.get('namespace'))
        return c.json({ group }, 201)
    })

    app.patch('/session-groups/:id', async c => {
        const body = SessionGroupUpdateSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'Invalid group name or emoji' }, 400)
        const group = store.sessionGroups.update(c.get('namespace'), c.req.param('id'), body.data)
        if (group) notify(c.get('namespace'))
        return group ? c.json({ group }) : c.json({ error: 'Group not found' }, 404)
    })

    app.put('/session-groups/assignment', async c => {
        const body = SessionGroupAssignmentInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'Invalid session group assignment' }, 400)
        const result = store.sessionGroups.assign(c.get('namespace'), body.data.source, body.data.groupId)
        if (result === 'ok') notify(c.get('namespace'))
        return result === 'ok' ? c.json({ ok: true }) : c.json({ error: result }, 404)
    })

    return app
}
