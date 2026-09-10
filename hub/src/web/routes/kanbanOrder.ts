import { Hono } from 'hono'
import { KanbanOrderInputSchema } from '@hapi/protocol/kanbanOrder'
import type { Store } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'

export function createKanbanOrderRoutes(store: Store, getSseManager: () => SSEManager | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.get('/kanban-order', c => c.json(store.kanbanOrder.get(c.get('namespace'))))
    app.put('/kanban-order', async c => {
        const input = KanbanOrderInputSchema.safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: 'Invalid Kanban order' }, 400)
        const namespace = c.get('namespace')
        const result = store.kanbanOrder.set(namespace, input.data)
        if (result.conflict) return c.json({ error: 'Kanban order changed', ...result.state }, 409)
        getSseManager()?.broadcast({ type: 'kanban-order-updated', namespace })
        return c.json(result.state)
    })
    return app
}
