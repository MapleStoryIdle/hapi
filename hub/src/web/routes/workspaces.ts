import { Hono } from 'hono'
import { z } from 'zod'
import { bodyLimit } from 'hono/body-limit'
import { randomBytes } from 'node:crypto'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

const workspaceSchema = z.object({ name: z.string().trim().min(1).max(64) })
const keySchema = z.object({
    kind: z.enum(['web', 'runner']),
    name: z.string().trim().min(1).max(64),
    expiresInDays: z.number().int().min(1).max(3650).optional()
})

export function createWorkspaceRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const limit = bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'Request too large' }, 413) })
    app.use('/workspaces', limit)
    app.use('/workspaces/*', limit)
    app.use('/workspaces', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
    app.use('/workspaces/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })

    app.get('/workspaces/current', c => {
        const workspace = store.workspaces.get(c.get('workspaceId'))
        if (!workspace) return c.json({ error: 'Workspace not found' }, 404)
        return c.json({ workspace, accessKeys: store.workspaces.listKeys(workspace.id) })
    })

    app.post('/workspaces', async c => {
        const parsed = workspaceSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid workspace' }, 400)
        if (c.get('namespace') !== 'default') return c.json({ error: 'Only the Hub owner workspace can create workspaces' }, 403)
        try {
            const webToken = `spw${randomBytes(32).toString('base64url')}`
            const { workspace, accessKeyId } = store.workspaces.createWithWebKey(parsed.data.name, webToken)
            return c.json({
                workspace,
                credentials: { web: { id: accessKeyId, token: webToken } },
            }, 201)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Unable to create workspace' }, 409)
        }
    })

    app.post('/workspaces/current/access-keys', async c => {
        const parsed = keySchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid access key' }, 400)
        if (parsed.data.kind === 'runner') {
            return c.json({ error: 'Runner keys must use the device authorization flow' }, 400)
        }
        const expiresAt = parsed.data.expiresInDays
            ? Date.now() + parsed.data.expiresInDays * 86_400_000
            : null
        try {
            return c.json(store.workspaces.issueKey(c.get('workspaceId'), parsed.data.kind, parsed.data.name, expiresAt), 201)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Unable to create access key' }, 409)
        }
    })

    app.delete('/workspaces/current/access-keys/:id', c => {
        if (c.req.param('id') === c.get('accessKeyId')) return c.json({ error: 'Cannot revoke the key used by this session' }, 409)
        return store.workspaces.revokeKey(c.get('workspaceId'), c.req.param('id'))
            ? c.json({ ok: true })
            : c.json({ error: 'Access key not found' }, 404)
    })

    return app
}
