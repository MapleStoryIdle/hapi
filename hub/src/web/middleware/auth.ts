import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { jwtVerify } from 'jose'
import type { Store } from '../../store'
import type { WorkspaceAccessKind } from '../../store/workspaces'

export type WebAppEnv = {
    Bindings: {
        remoteAddress?: string
    }
    Variables: {
        userId: number
        namespace: string
        workspaceId: string
        accessKeyId: string
        accessKind: WorkspaceAccessKind
        authMethod: 'bearer' | 'cookie'
        webSessionId: string | null
    }
}

export const SECURE_WEB_SESSION_COOKIE = '__Host-shapi_session'
export const DEVELOPMENT_WEB_SESSION_COOKIE = 'shapi_session'
export const WEB_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const WEB_SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function isSameOriginRequest(
    requestUrl: string,
    origin: string | undefined,
    trustedOrigins: string[] = [],
    fetchSite?: string,
): boolean {
    if (!origin || origin === 'null') return false
    // A same-origin browser request can cross a development or TLS-terminating
    // reverse proxy that rewrites Host. Fetch Metadata preserves its browser-side
    // origin relationship without trusting arbitrary forwarded headers.
    if (fetchSite === 'same-origin') return true
    try {
        const normalized = new URL(origin).origin
        return normalized === new URL(requestUrl).origin
            || trustedOrigins.some(value => {
                try {
                    return new URL(value).origin === normalized
                } catch {
                    return false
                }
            })
    } catch {
        return false
    }
}

const jwtPayloadSchema = z.object({
    uid: z.number(),
    wid: z.string().optional(),
    ns: z.string().optional(),
    aid: z.string().optional(),
    kind: z.enum(['legacy', 'web', 'runner']).optional()
}).refine((value) => Boolean(value.wid || value.ns))

export async function verifyWorkspaceJwt(token: string, jwtSecret: Uint8Array, store: Store): Promise<{
    userId: number
    namespace: string
    workspaceId: string
    accessKeyId: string
    accessKind: WorkspaceAccessKind
} | null> {
    try {
        const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
        const parsed = jwtPayloadSchema.safeParse(verified.payload)
        if (!parsed.success || !parsed.data.wid || !parsed.data.aid) return null
        const workspace = store.workspaces.get(parsed.data.wid)
        if (!workspace || parsed.data.ns && workspace.dataNamespace !== parsed.data.ns) return null
        if (parsed.data.aid !== 'telegram' && !store.workspaces.isKeyActive(workspace.id, parsed.data.aid, 'web')) return null
        return {
            userId: parsed.data.uid,
            namespace: workspace.dataNamespace,
            workspaceId: workspace.id,
            accessKeyId: parsed.data.aid,
            accessKind: parsed.data.kind ?? 'web'
        }
    } catch {
        return null
    }
}

function getPreviewTokenFromReferer(referer: string | undefined): string | undefined {
    if (!referer) return undefined
    try {
        const url = new URL(referer)
        return url.pathname.startsWith('/api/preview/')
            ? url.searchParams.get('hapiPreviewToken') ?? undefined
            : undefined
    } catch {
        return undefined
    }
}

export function createAuthMiddleware(
    jwtSecret: Uint8Array,
    store?: Store,
    trustedSessionOrigins: string[] = [],
): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (path === '/api/auth' || path === '/api/bind') {
            await next()
            return
        }


        if (store) {
            const sessionToken = getCookie(c, SECURE_WEB_SESSION_COOKIE)
                ?? getCookie(c, DEVELOPMENT_WEB_SESSION_COOKIE)
            if (sessionToken) {
                const session = store.workspaces.authenticateWebSession(sessionToken, WEB_SESSION_IDLE_TTL_MS)
                if (session) {
                    if (UNSAFE_METHODS.has(c.req.method)) {
                        if (!isSameOriginRequest(
                            c.req.url,
                            c.req.header('origin'),
                            trustedSessionOrigins,
                            c.req.header('sec-fetch-site'),
                        )) {
                            return c.json({ error: 'Cross-origin session request rejected' }, 403)
                        }
                        const csrfToken = c.req.header('x-csrf-token')
                        if (!csrfToken || !store.workspaces.verifyWebSessionCsrf(session.id, csrfToken)) {
                            return c.json({ error: 'Invalid CSRF token' }, 403)
                        }
                    }
                    c.set('userId', 1)
                    c.set('namespace', session.workspace.dataNamespace)
                    c.set('workspaceId', session.workspace.id)
                    c.set('accessKeyId', session.accessKeyId)
                    c.set('accessKind', 'web')
                    c.set('authMethod', 'cookie')
                    c.set('webSessionId', session.id)
                    await next()
                    return
                }
            }
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        const tokenFromQuery = path === '/api/events'
            ? c.req.query().token
            : path.startsWith('/api/preview/')
                ? c.req.query().hapiPreviewToken
                : undefined
        const tokenFromReferer = path.startsWith('/api/preview/')
            ? getPreviewTokenFromReferer(c.req.header('referer'))
            : undefined
        const token = tokenFromHeader ?? tokenFromQuery ?? tokenFromReferer

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        if (store) {
            const identity = await verifyWorkspaceJwt(token, jwtSecret, store)
            if (!identity) return c.json({ error: 'Invalid token' }, 401)
            c.set('userId', identity.userId)
            c.set('namespace', identity.namespace)
            c.set('workspaceId', identity.workspaceId)
            c.set('accessKeyId', identity.accessKeyId)
            c.set('accessKind', identity.accessKind)
            c.set('authMethod', 'bearer')
            c.set('webSessionId', null)
            await next()
            return
        }

        try {
            const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return c.json({ error: 'Invalid token payload' }, 401)
            }

            const namespace = parsed.data.ns
            if (!namespace) return c.json({ error: 'Workspace not found' }, 401)
            c.set('userId', parsed.data.uid)
            c.set('namespace', namespace)
            c.set('workspaceId', parsed.data.wid ?? namespace)
            c.set('accessKeyId', parsed.data.aid ?? 'legacy-jwt')
            c.set('accessKind', parsed.data.kind ?? 'legacy')
            c.set('authMethod', 'bearer')
            c.set('webSessionId', null)
            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}
