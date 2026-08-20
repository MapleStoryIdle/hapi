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

describe('OpenViking embedded authentication', () => {
    it('accepts the embedded token from a proxied asset referer', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', createAuthMiddleware(JWT_SECRET))
        app.get('/api/openviking/machines/:id/studio/assets/chunk.js', (c) => (
            c.json({ namespace: c.get('namespace') })
        ))

        const token = await createToken()
        const response = await app.request(
            '/api/openviking/machines/machine-1/studio/assets/chunk.js',
            {
                headers: {
                    referer: `https://hapi.test/api/openviking/machines/machine-1/studio/?hapiOpenVikingToken=${token}`
                }
            }
        )

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ namespace: 'default' })
    })
})
