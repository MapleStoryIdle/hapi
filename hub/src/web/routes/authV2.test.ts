import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createAuthV2ProtectedRoutes, createAuthV2PublicRoutes } from './authV2'

const JWT_SECRET = new TextEncoder().encode('auth-v2-route-test-secret')
const LEGACY_TOKEN = 'legacy-test-token'
const ENROLLMENT_SECRET = 'test-enrollment-secret'
const MACHINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MACHINE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function opaque(prefix: 'spw' | 'spr', byte: string): string {
    return `${prefix}${Buffer.alloc(32, byte).toString('base64url')}`
}

function runnerPublicKey(): { publicJwk: string; publicKeyThumbprint: string } {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const exported = publicKey.export({ format: 'jwk' })
    const canonical = JSON.stringify({
        crv: 'P-256',
        kty: 'EC',
        x: exported.x!,
        y: exported.y!,
    })
    return {
        publicJwk: canonical,
        publicKeyThumbprint: createHash('sha256').update(canonical).digest('base64url'),
    }
}

function createApp(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.route('/api', createAuthV2PublicRoutes(store, LEGACY_TOKEN, JWT_SECRET, undefined, ENROLLMENT_SECRET))
    app.use('/api/*', createAuthMiddleware(JWT_SECRET, store))
    app.route('/api', createAuthV2ProtectedRoutes(store))
    return app
}

async function registerAndLogin(app: Hono<WebAppEnv>, webToken: string): Promise<{
    cookie: string
    csrfToken: string
    workspaceId: string
}> {
    const registration = await app.request('http://localhost/api/v2/workspaces/register', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-hapi-registration-secret': ENROLLMENT_SECRET,
        },
        body: JSON.stringify({ name: 'Alice', webToken }),
    })
    expect(registration.status).toBe(201)
    const registered = await registration.json() as { workspace: { id: string } }
    const login = await app.request('http://localhost/api/v2/web-sessions', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'http://localhost',
        },
        body: JSON.stringify({ webToken }),
    })
    expect(login.status).toBe(201)
    const setCookie = login.headers.get('set-cookie')!
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('shapi_csrf=')
    expect(setCookie).toContain('SameSite=Strict')
    const cookie = setCookie.split(';', 1)[0]
    const session = await login.json() as { csrfToken: string }
    return { cookie, csrfToken: session.csrfToken, workspaceId: registered.workspace.id }
}

describe('auth v2 routes', () => {
    it('requires a configured and matching enrollment secret', async () => {
        const disabledStore = new Store(':memory:')
        const disabledApp = new Hono<WebAppEnv>()
        disabledApp.route('/api', createAuthV2PublicRoutes(disabledStore, LEGACY_TOKEN, JWT_SECRET))
        const body = JSON.stringify({ name: 'Alice', webToken: opaque('spw', 'z') })
        const disabledCount = disabledStore.workspaces.count()

        const disabled = await disabledApp.request('https://hub.example.test/api/v2/workspaces/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-hapi-registration-secret': ENROLLMENT_SECRET,
            },
            body,
        })
        expect(disabled.status).toBe(403)
        expect(disabledStore.workspaces.count()).toBe(disabledCount)
        disabledStore.close()

        const protectedStore = new Store(':memory:')
        const protectedApp = new Hono<WebAppEnv>()
        protectedApp.route('/api', createAuthV2PublicRoutes(
            protectedStore,
            LEGACY_TOKEN,
            JWT_SECRET,
            undefined,
            'enrollment-secret',
        ))
        const protectedCount = protectedStore.workspaces.count()
        const wrong = await protectedApp.request('https://hub.example.test/api/v2/workspaces/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-hapi-registration-secret': 'wrong',
            },
            body,
        })
        expect(wrong.status).toBe(403)

        const allowed = await protectedApp.request('https://hub.example.test/api/v2/workspaces/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-hapi-registration-secret': 'enrollment-secret',
            },
            body,
        })
        expect(allowed.status).toBe(201)
        expect(protectedStore.workspaces.count()).toBe(protectedCount + 1)
        protectedStore.close()
    })

    it('allows self-registration without a secret in open mode', async () => {
        const store = new Store(':memory:')
        const app = new Hono<WebAppEnv>()
        app.route('/api', createAuthV2PublicRoutes(
            store,
            LEGACY_TOKEN,
            JWT_SECRET,
            'https://hub.example.test',
            null,
            'open',
        ))

        const response = await app.request('https://hub.example.test/api/v2/workspaces/register', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Alice', webToken: opaque('spw', 'o') }),
        })

        expect(response.status).toBe(201)
        expect(store.workspaces.count()).toBe(2)
        store.close()
    })

    it('does not trust forwarded client-address headers for registration limits', async () => {
        const store = new Store(':memory:')
        const app = new Hono<WebAppEnv>()
        app.route('/api', createAuthV2PublicRoutes(
            store,
            LEGACY_TOKEN,
            JWT_SECRET,
            undefined,
            ENROLLMENT_SECRET,
        ))
        for (let index = 0; index < 5; index += 1) {
            const response = await app.request('https://hub.example.test/api/v2/workspaces/register', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-forwarded-for': `203.0.113.${index}`,
                    'x-hapi-registration-secret': ENROLLMENT_SECRET,
                },
                body: JSON.stringify({ name: `Workspace ${index}`, webToken: opaque('spw', String(index)) }),
            })
            expect(response.status).toBe(201)
        }

        const limited = await app.request('https://hub.example.test/api/v2/workspaces/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-forwarded-for': '198.51.100.1',
                'x-hapi-registration-secret': ENROLLMENT_SECRET,
            },
            body: JSON.stringify({ name: 'Limited', webToken: opaque('spw', 'y') }),
        })
        expect(limited.status).toBe(429)
        store.close()
    })

    it('atomically self-registers a workspace and rejects a reused spw', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const token = opaque('spw', 'a')
        const first = await app.request('http://localhost/api/v2/workspaces/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-hapi-registration-secret': ENROLLMENT_SECRET,
            },
            body: JSON.stringify({ name: 'Alice', webToken: token }),
        })
        expect(first.status).toBe(201)
        expect(store.workspaces.authenticate(token, LEGACY_TOKEN, 'web')?.workspace.name).toBe('Alice')
        const countAfterFirst = store.workspaces.count()

        const duplicate = await app.request('http://localhost/api/v2/workspaces/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-hapi-registration-secret': ENROLLMENT_SECRET,
            },
            body: JSON.stringify({ name: 'Orphan', webToken: token }),
        })
        expect(duplicate.status).toBe(409)
        expect(store.workspaces.count()).toBe(countAfterFirst)
        store.close()
    })

    it('uses an HttpOnly cookie and enforces Origin plus CSRF on writes', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const { cookie, csrfToken, workspaceId } = await registerAndLogin(app, opaque('spw', 'b'))
        expect(cookie).toStartWith('shapi_session=')

        const current = await app.request('http://localhost/api/v2/web-sessions/current', {
            headers: { cookie },
        })
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({
            workspace: { id: workspaceId },
            authMethod: 'cookie',
        })

        const missingCsrf = await app.request('http://localhost/api/v2/web-sessions/current', {
            method: 'DELETE',
            headers: { cookie, origin: 'http://localhost' },
        })
        expect(missingCsrf.status).toBe(403)
        const wrongOrigin = await app.request('http://localhost/api/v2/web-sessions/current', {
            method: 'DELETE',
            headers: { cookie, origin: 'https://evil.test', 'x-csrf-token': csrfToken },
        })
        expect(wrongOrigin.status).toBe(403)
        const logout = await app.request('http://localhost/api/v2/web-sessions/current', {
            method: 'DELETE',
            headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrfToken },
        })
        expect(logout.status).toBe(200)
        expect((await app.request('http://localhost/api/v2/web-sessions/current', {
            headers: { cookie },
        })).status).toBe(401)
        store.close()
    })

    it('approves and denies runner device authorizations inside the signed-in workspace', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const { cookie, csrfToken, workspaceId } = await registerAndLogin(app, opaque('spw', 'c'))
        const key = runnerPublicKey()
        const runnerToken = opaque('spr', 'd')
        const start = await app.request('http://localhost/api/v2/runner/device-authorizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                runnerToken,
                machineId: MACHINE_A,
                displayName: 'Laptop',
                ...key,
            }),
        })
        expect(start.status).toBe(201)
        const authorization = await start.json() as {
            deviceCode: string
            userCode: string
            verificationUri: string
            expiresIn: number
            interval: number
        }
        expect(authorization.verificationUri).toBe('http://localhost/pair')
        expect(authorization.expiresIn).toBe(600)
        expect(authorization.interval).toBe(5)

        const duplicatePending = await app.request('http://localhost/api/v2/runner/device-authorizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                runnerToken,
                machineId: MACHINE_A,
                displayName: 'Duplicate',
                ...key,
            }),
        })
        expect(duplicatePending.status).toBe(409)

        const inspect = await app.request(
            `http://localhost/api/v2/runner/device-authorizations/${authorization.userCode}`,
            { headers: { cookie } },
        )
        expect(inspect.status).toBe(200)
        expect(await inspect.json()).toMatchObject({ displayName: 'Laptop', machineId: MACHINE_A, state: 'pending' })

        const noCsrf = await app.request(
            `http://localhost/api/v2/runner/device-authorizations/${authorization.userCode}/approve`,
            { method: 'POST', headers: { cookie, origin: 'http://localhost' } },
        )
        expect(noCsrf.status).toBe(403)
        const approve = await app.request(
            `http://localhost/api/v2/runner/device-authorizations/${authorization.userCode}/approve`,
            {
                method: 'POST',
                headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrfToken },
            },
        )
        expect(approve.status).toBe(200)

        const pairing = store.workspaces.getRunnerPairingByDeviceCode(authorization.deviceCode)!
        store.workspaces.consumeApprovedRunnerPairing(authorization.deviceCode)
        const poll = await app.request('http://localhost/api/v2/runner/device-authorizations/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceCode: authorization.deviceCode }),
        })
        expect(await poll.json()).toEqual({
            status: 'approved',
            workspaceId,
            accessKeyId: store.workspaces.getRunnerPairing(pairing.id)!.accessKeyId,
            machineId: MACHINE_A,
        })
        expect(store.workspaces.authenticate(runnerToken, LEGACY_TOKEN, 'runner', MACHINE_A)?.workspace.id).toBe(workspaceId)

        const deniedRunnerToken = opaque('spr', 'e')
        const deniedRunnerKey = runnerPublicKey()
        const deniedStart = await app.request('http://localhost/api/v2/runner/device-authorizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                runnerToken: deniedRunnerToken,
                machineId: MACHINE_B,
                displayName: 'Desktop',
                ...deniedRunnerKey,
            }),
        })
        const deniedAuthorization = await deniedStart.json() as { deviceCode: string; userCode: string }
        const deny = await app.request(
            `http://localhost/api/v2/runner/device-authorizations/${deniedAuthorization.userCode}/deny`,
            {
                method: 'POST',
                headers: { cookie, origin: 'http://localhost', 'x-csrf-token': csrfToken },
            },
        )
        expect(deny.status).toBe(200)
        const deniedPoll = await app.request('http://localhost/api/v2/runner/device-authorizations/token', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceCode: deniedAuthorization.deviceCode }),
        })
        expect(await deniedPoll.json()).toEqual({ status: 'denied' })
        const retryAfterDenial = await app.request('http://localhost/api/v2/runner/device-authorizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                runnerToken: deniedRunnerToken,
                machineId: MACHINE_B,
                displayName: 'Desktop',
                ...deniedRunnerKey,
            }),
        })
        expect(retryAfterDenial.status).toBe(201)
        store.close()
    })

    it('lets the installer approve its own runner with an spw credential', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        const webToken = opaque('spw', 'i')
        const { workspaceId } = await registerAndLogin(app, webToken)
        const start = await app.request('http://localhost/api/v2/runner/device-authorizations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                runnerToken: opaque('spr', 'j'),
                machineId: MACHINE_A,
                displayName: 'Installer laptop',
                ...runnerPublicKey(),
            }),
        })
        const authorization = await start.json() as { deviceCode: string; userCode: string }

        const invalid = await app.request(
            `http://localhost/api/v2/runner/device-authorizations/${authorization.userCode}/approve-with-web-token`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ webToken: opaque('spw', 'x') }),
            },
        )
        expect(invalid.status).toBe(401)

        const approve = await app.request(
            `http://localhost/api/v2/runner/device-authorizations/${authorization.userCode}/approve-with-web-token`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ webToken }),
            },
        )
        expect(approve.status).toBe(200)
        const pairing = store.workspaces.getRunnerPairingByDeviceCode(authorization.deviceCode)
        expect(pairing).toMatchObject({ state: 'approved', workspaceId })
        store.close()
    })
})
