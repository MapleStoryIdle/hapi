import type { OpenVikingHttpRequest, OpenVikingHttpResponse } from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine, requireSyncEngine } from './guards'

const OPEN_VIKING_ROUTE_PREFIX = '/api/openviking/machines'
const OPEN_VIKING_TOKEN_PARAM = 'hapiOpenVikingToken'
const INTERNAL_QUERY_PARAMS = new Set([OPEN_VIKING_TOKEN_PARAM])

function proxyPrefix(machineId: string): string {
    return `${OPEN_VIKING_ROUTE_PREFIX}/${encodeURIComponent(machineId)}`
}

function getForwardedPath(url: URL, machineId: string): string {
    const prefix = proxyPrefix(machineId)
    const rawPath = url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length)
        : '/'
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    const search = new URLSearchParams(url.search)
    for (const param of INTERNAL_QUERY_PARAMS) {
        search.delete(param)
    }
    const query = search.toString()
    return `${path || '/'}${query ? `?${query}` : ''}`
}

function collectRequestHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {}
    headers.forEach((value, name) => {
        result[name] = value
    })
    return result
}

function appendProxyToken(value: string, token: string | undefined): string {
    if (!value.startsWith(OPEN_VIKING_ROUTE_PREFIX)) return value
    try {
        const parsed = new URL(value, 'http://hapi.local')
        if (token) {
            parsed.searchParams.set(OPEN_VIKING_TOKEN_PARAM, token)
        }
        return `${parsed.pathname}${parsed.search}${parsed.hash}`
    } catch {
        return value
    }
}

function isLocalOpenVikingHost(hostname: string): boolean {
    return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(hostname)
}

function rewriteOpenVikingLocation(
    value: string,
    machineId: string,
    token: string | undefined,
    basePath?: string
): string {
    if (!value || value.startsWith('#')) return value
    const prefix = proxyPrefix(machineId)

    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
        try {
            const parsed = new URL(value)
            if (!isLocalOpenVikingHost(parsed.hostname)) return value
            return appendProxyToken(`${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`, token)
        } catch {
            return value
        }
    }
    if (value.startsWith(OPEN_VIKING_ROUTE_PREFIX)) return appendProxyToken(value, token)
    if (value.startsWith('/')) return appendProxyToken(`${prefix}${value}`, token)
    if (basePath) {
        try {
            const resolved = new URL(value, new URL(basePath, 'http://openviking.local'))
            if (resolved.origin === 'http://openviking.local') {
                return appendProxyToken(`${prefix}${resolved.pathname}${resolved.search}${resolved.hash}`, token)
            }
        } catch {
            return value
        }
    }
    return value
}

function rewriteOpenVikingAttributes(
    text: string,
    machineId: string,
    token: string | undefined,
    basePath?: string
): string {
    return text
        .replace(/\b(src|href|action)=(("([^"]*)")|('([^']*)'))/gi, (match, attr: string, quoted: string, _doubleQuoted: string, doubleValue: string, _singleQuoted: string, singleValue: string) => {
            const value = doubleValue ?? singleValue ?? ''
            const rewritten = rewriteOpenVikingLocation(value, machineId, token, basePath)
            if (rewritten === value) return match
            const quote = quoted.startsWith("'") ? "'" : '"'
            return `${attr}=${quote}${rewritten}${quote}`
        })
        .replace(/\b(srcset)=(("([^"]*)")|('([^']*)'))/gi, (match, attr: string, quoted: string, _doubleQuoted: string, doubleValue: string, _singleQuoted: string, singleValue: string) => {
            const value = doubleValue ?? singleValue ?? ''
            const rewritten = value.split(',').map((entry) => {
                const trimmed = entry.trim()
                const [urlPart, ...rest] = trimmed.split(/\s+/)
                return [rewriteOpenVikingLocation(urlPart ?? '', machineId, token, basePath), ...rest].filter(Boolean).join(' ')
            }).join(', ')
            if (rewritten === value) return match
            const quote = quoted.startsWith("'") ? "'" : '"'
            return `${attr}=${quote}${rewritten}${quote}`
        })
}

function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c')
}

function buildOpenVikingBootstrapScript(args: {
    machineId: string
    token: string | undefined
}): string {
    const prefix = proxyPrefix(args.machineId)
    return `<script>(function(){var prefix=${scriptJson(prefix)};var token=${scriptJson(args.token ?? '')};var tokenParam=${scriptJson(OPEN_VIKING_TOKEN_PARAM)};function withToken(value){try{var url=new URL(value,location.href);if(url.origin!==location.origin||url.pathname.indexOf(prefix)!==0)return value;if(token)url.searchParams.set(tokenParam,token);return url.pathname+url.search+url.hash}catch(e){return value}}function toProxyUrl(value){try{var url=new URL(value,location.href);if(url.origin!==location.origin)return value;if(url.pathname.indexOf(prefix)===0)return withToken(url.pathname+url.search+url.hash);if(!(/^\\/(?:api|bot|oauth|studio)(?:\\/|$)|^\\/.well-known(?:\\/|$)|^\\/(?:health|ready)$/.test(url.pathname)))return value;return withToken(prefix+url.pathname+url.search+url.hash)}catch(e){return value}}if(window.fetch){var originalFetch=window.fetch;window.fetch=function(input,init){try{if(typeof input==='string'||input instanceof URL){return originalFetch.call(this,toProxyUrl(String(input)),init)}if(input instanceof Request){return originalFetch.call(this,new Request(toProxyUrl(input.url),input),init)}}catch(e){}return originalFetch.call(this,input,init)}}if(window.XMLHttpRequest){var originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){if(typeof url==='string'||url instanceof URL){arguments[1]=toProxyUrl(String(url))}return originalOpen.apply(this,arguments)}}if(window.history){var originalPushState=window.history.pushState;var originalReplaceState=window.history.replaceState;window.history.pushState=function(state,title,url){return originalPushState.call(this,state,title,url==null?url:withToken(String(url)))};window.history.replaceState=function(state,title,url){return originalReplaceState.call(this,state,title,url==null?url:withToken(String(url)))}}if(navigator.serviceWorker){try{navigator.serviceWorker.register=function(){return Promise.reject(new Error('OpenViking service worker is disabled inside HAPI'))}}catch(e){}}})();</script>`
}

function rewriteOpenVikingHtml(
    html: string,
    machineId: string,
    token: string | undefined,
    basePath: string
): string {
    const attributesRewritten = html.replace(/<[^>]+>/g, (tag) => (
        rewriteOpenVikingAttributes(tag, machineId, token, basePath)
    ))
    const bootstrap = buildOpenVikingBootstrapScript({ machineId, token })
    if (/<head[\s>]/i.test(attributesRewritten)) {
        return attributesRewritten.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`)
    }
    if (/<html[\s>]/i.test(attributesRewritten)) {
        return attributesRewritten.replace(/<html([^>]*)>/i, `<html$1>${bootstrap}`)
    }
    return `${bootstrap}${attributesRewritten}`
}

function rewriteOpenVikingCss(
    css: string,
    machineId: string,
    token: string | undefined,
    basePath: string
): string {
    return css.replace(/url\(\s*(["']?)(?![a-z][a-z0-9+.-]*:|\/\/|#|var\()([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => (
        `url(${quote}${rewriteOpenVikingLocation(value, machineId, token, basePath)}${quote})`
    ))
}

function rewriteOpenVikingJavaScript(
    source: string,
    machineId: string,
    token: string | undefined,
    basePath: string
): string {
    const studioPrefix = `${proxyPrefix(machineId)}/studio/`
    const rewriteModuleSpecifier = (value: string): string => (
        rewriteOpenVikingLocation(value, machineId, token, basePath)
    )

    return source
        // Module resolution discards the query string of the importing module.
        // Keep the embedded HAPI token on Vite's relative chunks instead of
        // relying on a browser Referer header to authenticate each request.
        .replace(/(\bimport\s*\(\s*)(["'])((?:\.{1,2}\/|\/studio\/)[^"']*)\2/g, (
            _match,
            prefix: string,
            quote: string,
            value: string
        ) => `${prefix}${quote}${rewriteModuleSpecifier(value)}${quote}`)
        .replace(/(\b(?:from|import)\s*)(["'])((?:\.{1,2}\/|\/studio\/)[^"']*)\2/g, (
            _match,
            prefix: string,
            quote: string,
            value: string
        ) => `${prefix}${quote}${rewriteModuleSpecifier(value)}${quote}`)
        .replaceAll('"/studio/', `"${studioPrefix}`)
        .replaceAll("'/studio/", `'${studioPrefix}`)
}

function responseHeaders(headers: Record<string, string>, machineId: string, token: string | undefined, basePath: string): Headers {
    const result = new Headers(headers)
    const location = result.get('location')
    if (location) {
        result.set('location', rewriteOpenVikingLocation(location, machineId, token, basePath))
    }
    result.delete('content-length')
    return result
}

function isHtml(contentType: string | null): boolean {
    return contentType?.toLowerCase().includes('text/html') ?? false
}

function isCss(contentType: string | null): boolean {
    return contentType?.toLowerCase().includes('text/css') ?? false
}

function isJavaScript(contentType: string | null): boolean {
    const value = contentType?.toLowerCase() ?? ''
    return value.includes('javascript') || value.includes('ecmascript')
}

async function getBodyBase64(request: Request, method: string): Promise<string | undefined> {
    if (method === 'GET' || method === 'HEAD') return undefined
    const body = await request.arrayBuffer()
    if (body.byteLength === 0) return undefined
    return Buffer.from(body).toString('base64')
}

function proxyErrorStatus(result: OpenVikingHttpResponse): 400 | 403 | 502 {
    return result.status === 400 || result.status === 403 ? result.status : 502
}

export function createOpenVikingRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/openviking/machines/:id/status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) {
            return c.json({ ok: false, error: 'Runner is offline' }, 409)
        }

        try {
            return c.json(await engine.getOpenVikingStatus(machineId))
        } catch (error) {
            return c.json({
                ok: false,
                error: error instanceof Error ? error.message : 'OpenViking is unavailable'
            }, 502)
        }
    })

    const handleProxy = async (c: Context<WebAppEnv>) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) return machine
        if (!machine.active) {
            return c.text('Runner is offline', 409)
        }

        const url = new URL(c.req.url)
        const forwardedPath = getForwardedPath(url, machineId)
        const request: OpenVikingHttpRequest = {
            path: forwardedPath,
            method: c.req.method as OpenVikingHttpRequest['method'],
            headers: collectRequestHeaders(c.req.raw.headers),
            bodyBase64: await getBodyBase64(c.req.raw, c.req.method.toUpperCase())
        }

        let result: OpenVikingHttpResponse
        try {
            result = await engine.proxyOpenVikingRequest(machineId, request)
        } catch (error) {
            return c.text(error instanceof Error ? error.message : 'OpenViking request failed', 502)
        }
        if (!result.ok) {
            return c.text(result.error ?? 'OpenViking request failed', proxyErrorStatus(result))
        }

        const token = c.req.query(OPEN_VIKING_TOKEN_PARAM)
        const headers = responseHeaders(result.headers, machineId, token, forwardedPath)
        const bytes = Buffer.from(result.bodyBase64, 'base64')
        const contentType = headers.get('content-type')

        if (isHtml(contentType)) {
            const text = new TextDecoder().decode(bytes)
            return new Response(rewriteOpenVikingHtml(text, machineId, token, forwardedPath), {
                status: result.status,
                statusText: result.statusText,
                headers
            })
        }
        if (isCss(contentType)) {
            const text = new TextDecoder().decode(bytes)
            return new Response(rewriteOpenVikingCss(text, machineId, token, forwardedPath), {
                status: result.status,
                statusText: result.statusText,
                headers
            })
        }
        if (isJavaScript(contentType)) {
            const text = new TextDecoder().decode(bytes)
            return new Response(rewriteOpenVikingJavaScript(text, machineId, token, forwardedPath), {
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

    app.all('/openviking/machines/:id', handleProxy)
    app.all('/openviking/machines/:id/*', handleProxy)

    return app
}
