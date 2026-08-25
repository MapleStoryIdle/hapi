import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'
import { Hono } from 'hono'
import { createAuthMiddleware, type WebAppEnv } from './auth'

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
