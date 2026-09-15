import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Store } from '../../store'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createWorkspaceRoutes } from './workspaces'

const SECRET = new TextEncoder().encode('workspace-route-test-secret')

describe('workspace routes', () => {
    it('creates isolated web credentials and requires device authorization for runners', async () => {
        const store = new Store(':memory:')
        const defaultWorkspace = store.workspaces.getByDataNamespace('default')!
        const ownerKey = store.workspaces.issueKey(defaultWorkspace.id, 'web', 'Owner')
        const current = store.workspaces.authenticate(ownerKey.token, 'legacy-base', 'web')!
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
        const body = await created.json() as { workspace: { id: string }; credentials: { web: { token: string } } }
        expect(store.workspaces.authenticate(body.credentials.web.token, 'legacy', 'web')?.workspace.id).toBe(body.workspace.id)

        const runnerKey = await app.request('/api/workspaces/current/access-keys', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'runner', name: 'Runner' })
        })
        expect(runnerKey.status).toBe(400)

        const currentResponse = await app.request('/api/workspaces/current', { headers: { authorization: `Bearer ${token}` } })
        expect(JSON.stringify(await currentResponse.json())).not.toContain(body.credentials.web.token)
        store.close()
    })
})
