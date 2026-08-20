import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
    }
}

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string()
})

function getEmbeddedTokenFromReferer(
    referer: string | undefined,
    routePrefix: string,
    tokenParam: string
): string | undefined {
    if (!referer) return undefined
    try {
        const url = new URL(referer)
        return url.pathname.startsWith(routePrefix)
            ? url.searchParams.get(tokenParam) ?? undefined
            : undefined
    } catch {
        return undefined
    }
}

export function createAuthMiddleware(jwtSecret: Uint8Array): MiddlewareHandler<WebAppEnv> {
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
                : path.startsWith('/api/openviking/')
                    ? c.req.query().hapiOpenVikingToken
                : undefined
        const tokenFromReferer = path.startsWith('/api/preview/')
            ? getEmbeddedTokenFromReferer(c.req.header('referer'), '/api/preview/', 'hapiPreviewToken')
            : path.startsWith('/api/openviking/')
                ? getEmbeddedTokenFromReferer(c.req.header('referer'), '/api/openviking/', 'hapiOpenVikingToken')
                : undefined
        const token = tokenFromHeader ?? tokenFromQuery ?? tokenFromReferer

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        try {
            const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return c.json({ error: 'Invalid token payload' }, 401)
            }

            c.set('userId', parsed.data.uid)
            c.set('namespace', parsed.data.ns)
            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}
