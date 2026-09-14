import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import { Hono } from 'hono'
import { createAuthMiddleware, type WebAppEnv } from './auth'
import { Store } from '../../store'

const JWT_SECRET = new TextEncoder().encode('openviking-auth-test-secret')

async function createToken(): Promise<string> {
    return await new SignJWT({ uid: 1, ns: 'default' })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(JWT_SECRET)
}

describe('OpenViking context authentication', () => {
    it('uses the normal bearer token', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        app.get('/api/openviking/machines/:id/context', (c) => (
            c.json({ namespace: c.get('namespace') })
        ))

        const token = await createToken()
        const response = await app.request('/api/openviking/machines/machine-1/context', {
            headers: { authorization: `Bearer ${token}` }
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ namespace: 'default' })
    })

    it('rejects revoked workspace keys and wid/ns confusion', async () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Secure')
        const key = store.workspaces.issueKey(workspace.id, 'web', 'Owner')
        const access = store.workspaces.authenticate(key.token, 'legacy', 'web')!
        const valid = await new SignJWT({ uid: 1, wid: workspace.id, ns: workspace.dataNamespace, aid: access.accessKeyId, kind: 'web' })
            .setProtectedHeader({ alg: 'HS256' }).sign(JWT_SECRET)
        const confused = await new SignJWT({ uid: 1, wid: workspace.id, ns: 'default', aid: access.accessKeyId, kind: 'web' })
            .setProtectedHeader({ alg: 'HS256' }).sign(JWT_SECRET)
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET, store))
        app.get('/protected', c => c.json({ namespace: c.get('namespace') }))

        expect((await app.request('/protected', { headers: { authorization: `Bearer ${valid}` } })).status).toBe(200)
        expect((await app.request('/protected', { headers: { authorization: `Bearer ${confused}` } })).status).toBe(401)
        store.workspaces.revokeKey(workspace.id, key.id)
        expect((await app.request('/protected', { headers: { authorization: `Bearer ${valid}` } })).status).toBe(401)
        store.close()
    })

    it('does not accept the retired Studio query token', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        app.get('/api/openviking/machines/:id/context', (c) => c.json({ ok: true }))

        const token = await createToken()
        const response = await app.request(
            `/api/openviking/machines/machine-1/context?hapiOpenVikingToken=${encodeURIComponent(token)}`
        )

        expect(response.status).toBe(401)
    })
})
