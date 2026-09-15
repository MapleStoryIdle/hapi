import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { constantTimeEquals } from '../../utils/crypto'
import type { Store } from '../../store'
import { buildRunnerDpopTarget, getRunnerAuthService } from '../../auth/runnerAuth'
import {
    DEVELOPMENT_WEB_SESSION_COOKIE,
    SECURE_WEB_SESSION_COOKIE,
    WEB_SESSION_ABSOLUTE_TTL_MS,
    WEB_SESSION_IDLE_TTL_MS,
    isSameOriginRequest,
    type WebAppEnv,
} from '../middleware/auth'

const DEVICE_AUTHORIZATION_TTL_MS = 10 * 60 * 1000
const WEB_CSRF_COOKIE = 'shapi_csrf'

const registerWorkspaceSchema = z.object({
    name: z.string().trim().min(1).max(64),
    webToken: z.string().min(1).max(128),
}).strict()

const createWebSessionSchema = z.object({
    webToken: z.string().min(1).max(128),
}).strict()

const startDeviceAuthorizationSchema = z.object({
    runnerToken: z.string().min(1).max(128),
    machineId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(100),
    publicJwk: z.string().min(1).max(4096),
    publicKeyThumbprint: z.string().min(1).max(128),
}).strict()

const pollDeviceAuthorizationSchema = z.object({
    deviceCode: z.string().min(1).max(128),
}).strict()

const approveDeviceAuthorizationWithWebTokenSchema = z.object({
    webToken: z.string().min(1).max(128),
}).strict()

const runnerTokenExchangeSchema = z.object({
    machineId: z.string().uuid(),
}).strict()

const userCodeSchema = z.string().regex(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)

function requestAddress(c: Context<WebAppEnv>): string {
    return c.env?.remoteAddress ?? 'unknown'
}

function noStore(c: Context): void {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
}

function rejectsBrowserCrossOrigin(c: Context, trustedOrigin?: string): boolean {
    const origin = c.req.header('origin')
    return Boolean(origin && !isSameOriginRequest(
        c.req.url,
        origin,
        trustedOrigin ? [trustedOrigin] : [],
        c.req.header('sec-fetch-site'),
    ))
}

function isSecureRequest(c: Context, publicUrl?: string): boolean {
    return new URL(publicUrl ?? c.req.url).protocol === 'https:'
}

function setWebSessionCookies(
    c: Context,
    token: string,
    csrfToken: string,
    absoluteExpiresAt: number,
    publicUrl?: string,
): void {
    const secure = isSecureRequest(c, publicUrl)
    const maxAge = Math.max(0, Math.floor((absoluteExpiresAt - Date.now()) / 1000))
    setCookie(
        c,
        secure ? SECURE_WEB_SESSION_COOKIE : DEVELOPMENT_WEB_SESSION_COOKIE,
        token,
        {
            path: '/',
            httpOnly: true,
            sameSite: 'Lax',
            secure,
            maxAge,
        },
    )
    setCookie(c, WEB_CSRF_COOKIE, csrfToken, {
        path: '/',
        httpOnly: false,
        sameSite: 'Strict',
        secure,
        maxAge,
    })
}

function clearWebSessionCookies(c: Context): void {
    deleteCookie(c, DEVELOPMENT_WEB_SESSION_COOKIE, { path: '/' })
    deleteCookie(c, SECURE_WEB_SESSION_COOKIE, { path: '/', secure: true })
    deleteCookie(c, WEB_CSRF_COOKIE, { path: '/' })
}

function parseUserCode(value: string): string | null {
    const normalized = value.trim().toUpperCase()
    return userCodeSchema.safeParse(normalized).success ? normalized : null
}

export function createAuthV2PublicRoutes(
    store: Store,
    legacyBaseToken: string,
    jwtSecret: Uint8Array,
    publicUrl?: string,
    registrationSecret?: string | null,
    registrationMode: 'closed' | 'secret' | 'open' = registrationSecret ? 'secret' : 'closed',
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const runnerAuth = getRunnerAuthService(store, jwtSecret)
    const attempts = new Map<string, { count: number; resetAt: number }>()
    const allowAttempt = (c: Context<WebAppEnv>, action: string, limit: number): boolean => {
        const now = Date.now()
        if (attempts.size > 1024) {
            for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key)
            if (attempts.size > 1024) return false
        }
        const key = `${action}:${requestAddress(c)}`
        const current = attempts.get(key)
        if (!current || current.resetAt <= now) {
            attempts.set(key, { count: 1, resetAt: now + 60_000 })
            return true
        }
        current.count += 1
        return current.count <= limit
    }
    const limit = bodyLimit({
        maxSize: 8192,
        onError: c => c.json({ error: 'Request too large' }, 413),
    })
    app.use('/v2/*', limit)
    app.use('/v2/*', async (c, next) => {
        noStore(c)
        await next()
    })

    app.post('/v2/workspaces/register', async c => {
        const suppliedRegistrationSecret = c.req.header('x-hapi-registration-secret')
        if (registrationMode === 'closed') {
            return c.json({ error: 'Workspace registration is disabled' }, 403)
        }
        if (registrationMode === 'secret' && (!registrationSecret
            || !suppliedRegistrationSecret
            || !constantTimeEquals(suppliedRegistrationSecret, registrationSecret))) {
            return c.json({ error: 'Invalid registration secret' }, 403)
        }
        if (!allowAttempt(c, 'register', 5)) return c.json({ error: 'Too many registration attempts' }, 429)
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const parsed = registerWorkspaceSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid workspace registration' }, 400)
        try {
            const { workspace } = store.workspaces.createWithWebKey(
                parsed.data.name,
                parsed.data.webToken,
            )
            return c.json({ workspace }, 201)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Unable to register workspace',
            }, 409)
        }
    })

    app.post('/v2/web-sessions', async c => {
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const parsed = createWebSessionSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid web session request' }, 400)
        const access = store.workspaces.authenticate(
            parsed.data.webToken,
            legacyBaseToken,
            'web',
        )
        if (!access) return c.json({ error: 'Invalid web access key' }, 401)
        const session = store.workspaces.issueWebSession(
            access.workspace.id,
            access.accessKeyId,
            WEB_SESSION_IDLE_TTL_MS,
            WEB_SESSION_ABSOLUTE_TTL_MS,
        )
        setWebSessionCookies(c, session.token, session.csrfToken, session.absoluteExpiresAt, publicUrl)
        return c.json({
            workspace: session.workspace,
            csrfToken: session.csrfToken,
            idleExpiresAt: session.idleExpiresAt,
            absoluteExpiresAt: session.absoluteExpiresAt,
        }, 201)
    })

    app.post('/v2/runner/device-authorizations', async c => {
        if (!allowAttempt(c, 'pair', 20)) return c.json({ error: 'Too many pairing attempts' }, 429)
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const parsed = startDeviceAuthorizationSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid device authorization request' }, 400)
        const now = Date.now()
        try {
            const pairing = store.workspaces.issueRunnerPairing({
                runnerToken: parsed.data.runnerToken,
                runnerMachineId: parsed.data.machineId,
                runnerName: parsed.data.displayName,
                publicJwk: parsed.data.publicJwk,
                publicKeyThumbprint: parsed.data.publicKeyThumbprint,
                expiresAt: now + DEVICE_AUTHORIZATION_TTL_MS,
            }, now)
            return c.json({
                deviceCode: pairing.deviceCode,
                userCode: pairing.humanCode,
                verificationUri: new URL('/pair', publicUrl ?? c.req.url).toString(),
                expiresIn: Math.floor((pairing.expiresAt - now) / 1000),
                interval: Math.ceil(pairing.pollIntervalMs / 1000),
            }, 201)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Unable to start device authorization',
            }, 409)
        }
    })

    app.post('/v2/runner/device-authorizations/token', async c => {
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const parsed = pollDeviceAuthorizationSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid device authorization token request' }, 400)
        const result = store.workspaces.pollPairing(parsed.data.deviceCode)
        if (result.status === 'pending') return c.json({ status: 'pending' })
        if (result.status === 'slow_down') {
            return c.json({
                status: 'slow_down',
                retryAfter: Math.ceil((result.retryAfterMs ?? 0) / 1000),
            })
        }
        if (result.status === 'denied' || result.status === 'expired') {
            return c.json({ status: result.status })
        }

        const pairing = result.status === 'approved'
            ? store.workspaces.consumeApprovedRunnerPairing(parsed.data.deviceCode)
            : store.workspaces.getRunnerPairingByDeviceCode(parsed.data.deviceCode)
        if (!pairing?.workspaceId || !pairing.accessKeyId) {
            return c.json({ status: 'expired' })
        }
        return c.json({
            status: 'approved',
            workspaceId: pairing.workspaceId,
            accessKeyId: pairing.accessKeyId,
            machineId: pairing.runnerMachineId,
        })
    })

    app.post('/v2/runner/device-authorizations/:userCode/approve-with-web-token', async c => {
        if (!allowAttempt(c, 'pair-approve', 20)) return c.json({ error: 'Too many pairing attempts' }, 429)
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const userCode = parseUserCode(c.req.param('userCode'))
        const parsed = approveDeviceAuthorizationWithWebTokenSchema.safeParse(await c.req.json().catch(() => null))
        if (!userCode || !parsed.success) return c.json({ error: 'Invalid runner approval request' }, 400)
        const access = store.workspaces.authenticate(parsed.data.webToken, legacyBaseToken, 'web')
        if (!access) return c.json({ error: 'Invalid web access key' }, 401)
        const pairing = store.workspaces.getRunnerPairingByHumanCode(userCode)
        if (!pairing) return c.json({ error: 'Device authorization not found' }, 404)
        const approved = store.workspaces.approveRunnerPairing(access.workspace.id, pairing.id)
        if (!approved) return c.json({ error: 'Device authorization is no longer pending' }, 409)
        return c.json({ ok: true })
    })

    app.post('/v2/runner/token', async c => {
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const authorization = c.req.header('authorization')
        const runnerToken = authorization?.match(/^DPoP\s+(.+)$/i)?.[1]
        const proof = c.req.header('dpop')
        const parsed = runnerTokenExchangeSchema.safeParse(await c.req.json().catch(() => null))
        if (!runnerToken || !proof || !parsed.success) {
            return c.json({ error: 'Invalid runner token exchange request' }, 400)
        }
        const grant = await runnerAuth.exchangeRunnerCredential({
            runnerToken,
            machineId: parsed.data.machineId,
            proof,
            method: c.req.method,
            targetUrl: buildRunnerDpopTarget(publicUrl ?? c.req.url, c.req.path),
            legacyBaseToken,
        })
        if (!grant) return c.json({ error: 'Invalid runner credential or DPoP proof' }, 401)
        return c.json({
            accessToken: grant.accessToken,
            tokenType: 'DPoP' as const,
            expiresIn: grant.expiresIn,
        })
    })

    app.post('/v2/runner/socket-tickets', async c => {
        if (rejectsBrowserCrossOrigin(c, publicUrl))
            return c.json({ error: 'Cross-origin request rejected' }, 403)
        const authorization = c.req.header('authorization')
        const accessToken = authorization?.match(/^DPoP\s+(.+)$/i)?.[1]
        const proof = c.req.header('dpop')
        if (!accessToken || !proof) {
            return c.json({ error: 'Runner DPoP authorization required' }, 401)
        }
        const identity = await runnerAuth.authenticateRunnerAccess({
            accessToken,
            proof,
            method: c.req.method,
            targetUrl: buildRunnerDpopTarget(publicUrl ?? c.req.url, c.req.path),
        })
        if (!identity) return c.json({ error: 'Invalid runner access token or DPoP proof' }, 401)
        return c.json(runnerAuth.issueSocketTicket(identity), 201)
    })

    return app
}

export function createAuthV2ProtectedRoutes(store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const limit = bodyLimit({
        maxSize: 4096,
        onError: c => c.json({ error: 'Request too large' }, 413),
    })
    app.use('/v2/*', limit)
    app.use('/v2/*', async (c, next) => {
        noStore(c)
        await next()
    })

    app.get('/v2/web-sessions/current', c => {
        return c.json({
            workspace: store.workspaces.get(c.get('workspaceId')),
            authMethod: c.get('authMethod'),
        })
    })

    app.delete('/v2/web-sessions/current', c => {
        const sessionId = c.get('webSessionId')
        if (sessionId) store.workspaces.revokeWebSession(c.get('workspaceId'), sessionId)
        clearWebSessionCookies(c)
        return c.json({ ok: true })
    })

    app.get('/v2/runner/device-authorizations/:userCode', c => {
        const userCode = parseUserCode(c.req.param('userCode'))
        if (!userCode) return c.json({ error: 'Device authorization not found' }, 404)
        const pairing = store.workspaces.getRunnerPairingByHumanCode(userCode)
        if (!pairing) return c.json({ error: 'Device authorization not found' }, 404)
        return c.json({
            userCode: pairing.humanCode,
            displayName: pairing.runnerName,
            machineId: pairing.runnerMachineId,
            publicKeyThumbprint: pairing.publicKeyThumbprint,
            state: pairing.state,
            expiresAt: pairing.expiresAt,
        })
    })

    app.post('/v2/runner/device-authorizations/:userCode/approve', c => {
        if (c.get('authMethod') !== 'cookie') {
            return c.json({ error: 'A web session is required to approve a runner' }, 403)
        }
        const userCode = parseUserCode(c.req.param('userCode'))
        if (!userCode) return c.json({ error: 'Device authorization not found' }, 404)
        const pairing = store.workspaces.getRunnerPairingByHumanCode(userCode)
        if (!pairing) return c.json({ error: 'Device authorization not found' }, 404)
        const approved = store.workspaces.approveRunnerPairing(c.get('workspaceId'), pairing.id)
        if (!approved) return c.json({ error: 'Device authorization is no longer pending' }, 409)
        return c.json({ ok: true })
    })

    app.post('/v2/runner/device-authorizations/:userCode/deny', c => {
        if (c.get('authMethod') !== 'cookie') {
            return c.json({ error: 'A web session is required to deny a runner' }, 403)
        }
        const userCode = parseUserCode(c.req.param('userCode'))
        if (!userCode) return c.json({ error: 'Device authorization not found' }, 404)
        const pairing = store.workspaces.getRunnerPairingByHumanCode(userCode)
        if (!pairing) return c.json({ error: 'Device authorization not found' }, 404)
        if (!store.workspaces.denyRunnerPairing(pairing.id)) {
            return c.json({ error: 'Device authorization is no longer pending' }, 409)
        }
        return c.json({ ok: true })
    })

    return app
}
