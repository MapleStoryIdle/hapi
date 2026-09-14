import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'
import type { Store } from '../../store'
import type { WorkspaceAccessKind } from '../../store/workspaces'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
        workspaceId: string
        accessKeyId: string
        accessKind: WorkspaceAccessKind
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

export function createAuthMiddleware(jwtSecret: Uint8Array, store?: Store): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (path === '/api/auth' || path === '/api/bind') {
            await next()
            return
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
            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}
