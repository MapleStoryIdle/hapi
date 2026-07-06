import {
    LocalPreviewCheckRequestSchema,
    LocalPreviewHttpMethodSchema,
    LocalPreviewProtocolSchema,
    type LocalPreviewCandidate,
    type LocalPreviewHttpRequest,
    type LocalPreviewProtocol
} from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const PREVIEW_ROUTE_PREFIX = '/api/preview/sessions'
const INTERNAL_QUERY_PARAMS = new Set(['hapiPreviewToken', 'hapiPreviewProtocol'])

function parsePort(value: string): number | null {
    if (!/^\d+$/.test(value)) return null
    const port = Number(value)
    return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function resolveProtocol(value: string | undefined): LocalPreviewProtocol {
    const parsed = LocalPreviewProtocolSchema.safeParse(value)
    return parsed.success ? parsed.data : 'http'
}

function buildPreviewCandidate(args: {
    sessionId: string
    machineId: string
    protocol: LocalPreviewProtocol
    port: number
    path: string
    sourceUrl?: string
    ok: boolean
    status?: number
    title?: string | null
    error?: string
}): LocalPreviewCandidate {
    return {
        id: `${args.sessionId}:${args.machineId}:${args.protocol}:${args.port}`,
        sessionId: args.sessionId,
        machineId: args.machineId,
        protocol: args.protocol,
        port: args.port,
        path: args.path,
        url: `${args.protocol}://127.0.0.1:${args.port}${args.path}`,
        sourceUrl: args.sourceUrl,
        status: args.ok ? 'online' : 'offline',
        title: args.title ?? null,
        statusCode: args.status,
        error: args.error,
        checkedAt: Date.now()
    }
}

function proxyPrefix(sessionId: string, port: number): string {
    return `${PREVIEW_ROUTE_PREFIX}/${encodeURIComponent(sessionId)}/${port}`
}

function getForwardedPath(url: URL, sessionId: string, port: number): string {
    const prefix = proxyPrefix(sessionId, port)
    const rawPath = url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length)
        : '/'
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const search = new URLSearchParams(url.search)
    for (const param of INTERNAL_QUERY_PARAMS) {
        search.delete(param)
    }
    const qs = search.toString()
    return `${path || '/'}${qs ? `?${qs}` : ''}`
}

function collectRequestHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {}
    headers.forEach((value, name) => {
        result[name] = value
    })
    return result
}

function shouldRewriteBody(contentType: string | null): boolean {
    const type = contentType?.toLowerCase() ?? ''
    return type.includes('text/html')
        || type.includes('text/css')
        || type.includes('javascript')
        || type.includes('ecmascript')
}

function rewriteLocalPreviewLocation(value: string, sessionId: string, port: number): string {
    if (!value || value.startsWith('#')) return value
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
        try {
            const parsed = new URL(value)
            if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(parsed.hostname)) {
                return value
            }
            return `${proxyPrefix(sessionId, port)}${parsed.pathname}${parsed.search}${parsed.hash}`
        } catch {
            return value
        }
    }
    if (value.startsWith('/api/preview/')) return value
    if (value.startsWith('/')) {
        return `${proxyPrefix(sessionId, port)}${value}`
    }
    return value
}

function rewriteLocalPreviewText(text: string, sessionId: string, port: number): string {
    return text
        .replace(/\b(src|href|action)=("([^"]*)"|'([^']*)')/gi, (match, attr: string, quoted: string, doubleValue?: string, singleValue?: string) => {
            const value = doubleValue ?? singleValue ?? ''
            const rewritten = rewriteLocalPreviewLocation(value, sessionId, port)
            if (rewritten === value) return match
            const quote = quoted.startsWith("'") ? "'" : '"'
            return `${attr}=${quote}${rewritten}${quote}`
        })
        .replace(/\b(srcset)=("([^"]*)"|'([^']*)')/gi, (match, attr: string, quoted: string, doubleValue?: string, singleValue?: string) => {
            const value = doubleValue ?? singleValue ?? ''
            const rewritten = value.split(',').map((entry) => {
                const trimmed = entry.trim()
                const [urlPart, ...rest] = trimmed.split(/\s+/)
                return [rewriteLocalPreviewLocation(urlPart ?? '', sessionId, port), ...rest].filter(Boolean).join(' ')
            }).join(', ')
            if (rewritten === value) return match
            const quote = quoted.startsWith("'") ? "'" : '"'
            return `${attr}=${quote}${rewritten}${quote}`
        })
        .replace(/url\(\s*(["']?)(\/(?!\/)[^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
            return `url(${quote}${rewriteLocalPreviewLocation(value, sessionId, port)}${quote})`
        })
        .replace(/(["'`])\/(?!\/|api\/preview\/)([^"'`\s<>)]+)\1/g, (_match, quote: string, path: string) => {
            return `${quote}${proxyPrefix(sessionId, port)}/${path}${quote}`
        })
}

function responseHeadersWithLocationRewrite(headers: Record<string, string>, sessionId: string, port: number): Headers {
    const result = new Headers(headers)
    const location = result.get('location')
    if (location) {
        result.set('location', rewriteLocalPreviewLocation(location, sessionId, port))
    }
    result.delete('content-length')
    return result
}

async function getBodyBase64(request: Request, method: string): Promise<string | undefined> {
    if (['GET', 'HEAD'].includes(method)) return undefined
    const body = await request.arrayBuffer()
    if (body.byteLength === 0) return undefined
    return Buffer.from(body).toString('base64')
}

export function createLocalPreviewRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions/:id/previews/check', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const machineId = sessionResult.session.metadata?.machineId
        if (!machineId) {
            return c.json({ error: 'Session is not bound to a runner machine' }, 409)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = LocalPreviewCheckRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const result = await engine.checkLocalPreview(machineId, {
            protocol: parsed.data.protocol,
            port: parsed.data.port,
            path: parsed.data.path
        })

        return c.json({
            candidate: buildPreviewCandidate({
                sessionId: sessionResult.sessionId,
                machineId,
                protocol: parsed.data.protocol,
                port: parsed.data.port,
                path: parsed.data.path,
                sourceUrl: parsed.data.sourceUrl,
                ok: result.ok,
                status: result.status,
                title: result.title,
                error: result.error
            })
        })
    })

    const handleProxy = async (c: Context<WebAppEnv>) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult

        const machineId = sessionResult.session.metadata?.machineId
        if (!machineId) {
            return c.text('Session is not bound to a runner machine', 409)
        }

        const port = parsePort(c.req.param('port'))
        if (!port) {
            return c.text('Invalid preview port', 400)
        }

        const protocol = resolveProtocol(c.req.query('hapiPreviewProtocol'))
        const method = c.req.method.toUpperCase()
        const methodParsed = LocalPreviewHttpMethodSchema.safeParse(method)
        if (!methodParsed.success) {
            return c.text('Unsupported preview method', 405)
        }

        const url = new URL(c.req.url)
        const request: LocalPreviewHttpRequest = {
            protocol,
            port,
            path: getForwardedPath(url, sessionResult.sessionId, port),
            method: methodParsed.data,
            headers: collectRequestHeaders(c.req.raw.headers),
            bodyBase64: await getBodyBase64(c.req.raw, method)
        }

        const result = await engine.proxyLocalPreviewRequest(machineId, request)
        if (!result.ok) {
            return c.text(result.error ?? 'Local preview request failed', result.status === 403 ? 403 : 502)
        }

        const headers = responseHeadersWithLocationRewrite(result.headers, sessionResult.sessionId, port)
        const bytes = Buffer.from(result.bodyBase64, 'base64')
        const contentType = headers.get('content-type')
        if (shouldRewriteBody(contentType)) {
            const text = new TextDecoder().decode(bytes)
            const rewritten = rewriteLocalPreviewText(text, sessionResult.sessionId, port)
            headers.delete('content-length')
            return new Response(rewritten, {
                status: result.status,
                statusText: result.statusText,
                headers
            })
        }

        return new Response(bytes, {
            status: result.status,
            statusText: result.statusText,
            headers
        })
    }

    app.all('/preview/sessions/:id/:port', handleProxy)
    app.all('/preview/sessions/:id/:port/*', handleProxy)

    return app
}
