import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Store } from '../../store'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createWorkspaceRoutes } from './workspaces'

const SECRET = new TextEncoder().encode('workspace-route-test-secret')

describe('workspace routes', () => {
    it('creates isolated web and runner credentials and never lists their token values', async () => {
        const store = new Store(':memory:')
        const current = store.workspaces.authenticate('legacy-base', 'legacy-base', 'web')!
        const token = await new SignJWT({ uid: 1, wid: current.workspace.id, ns: 'default', aid: current.accessKeyId, kind: 'legacy' })
            .setProtectedHeader({ alg: 'HS256' }).sign(SECRET)
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(SECRET, store))
        app.route('/api', createWorkspaceRoutes(store))

        const created = await app.request('/api/workspaces', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Production' })
        })
        expect(created.status).toBe(201)
        expect(created.headers.get('cache-control')).toBe('no-store')
        const body = await created.json() as { workspace: { id: string }; credentials: { web: { token: string }; runner: { token: string } } }
        expect(body.credentials.web.token).not.toBe(body.credentials.runner.token)
        expect(store.workspaces.authenticate(body.credentials.web.token, 'legacy', 'web')?.workspace.id).toBe(body.workspace.id)
        expect(store.workspaces.authenticate(body.credentials.runner.token, 'legacy', 'runner')?.workspace.id).toBe(body.workspace.id)

        const currentResponse = await app.request('/api/workspaces/current', { headers: { authorization: `Bearer ${token}` } })
        expect(JSON.stringify(await currentResponse.json())).not.toContain(body.credentials.web.token)
        store.close()
    })
})
