import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders } from 'node:http'
import { checkServerIdentity } from 'node:tls'
import { parseLocalServiceUrl } from '@hapi/protocol/localServices'
import { LOCAL_SERVICE_ACCESS_MS, type LocalServiceLease, type LocalServiceManager } from './manager'

const MAX_REQUEST_BYTES = 50 * 1024 * 1024
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024
const MAX_WS_BUFFER = 1024 * 1024
const INTERNAL_PREFIX = '/__shapi_local/'
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function cookieName(lease: LocalServiceLease): string {
    return lease.origin.startsWith('https:') ? '__Host-shapi-local' : 'shapi_local_dev'
}

function accessCookie(request: Request, lease: LocalServiceLease): string | undefined {
    const prefix = `${cookieName(lease)}=`
    return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length)
}

function stripHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
    const blocked = new Set([...HOP_HEADERS, ...(headers.connection?.toLowerCase().split(',').map((part) => part.trim()) ?? [])])
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())))
}

export function localServiceRequestHeaders(headers: IncomingHttpHeaders, lease: Pick<LocalServiceLease, 'origin' | 'target'>): IncomingHttpHeaders {
    const result = stripHopHeaders(headers)
    delete result.forwarded
    for (const name of Object.keys(result)) if (name.startsWith('x-forwarded-')) delete result[name]
    const cookies = result.cookie?.split(';').filter((part) => !/^\s*(?:__Host-shapi-local|shapi_local_dev)=/.test(part))
    if (cookies?.length) result.cookie = cookies.join(';')
    else delete result.cookie
    result.host = new URL(lease.target.origin).host
    if (result.origin === lease.origin) result.origin = lease.target.origin
    if (result.referer?.startsWith(`${lease.origin}/`)) result.referer = lease.target.origin + result.referer.slice(lease.origin.length)
    result['x-forwarded-host'] = new URL(lease.origin).host
    result['x-forwarded-proto'] = new URL(lease.origin).protocol.slice(0, -1)
    return result
}

export function localServiceResponseHeaders(headers: IncomingHttpHeaders, lease: Pick<LocalServiceLease, 'origin' | 'target'>): IncomingHttpHeaders {
    const result = stripHopHeaders(headers)
    if (result['set-cookie']) {
        result['set-cookie'] = result['set-cookie']
            .filter((value) => !/^\s*(?:__Host-shapi-local|shapi_local_dev)=/.test(value))
            .map((value) => value.replace(/;\s*domain=[^;]*/gi, ''))
    }
    if (result.location) {
        const target = parseLocalServiceUrl(result.location)
        if (target && target.port === lease.target.port && target.protocol === lease.target.protocol) result.location = lease.origin + target.path + target.hash
    }
    delete result['access-control-allow-origin']
    delete result['access-control-allow-credentials']
    delete result['clear-site-data']
    delete result['service-worker-allowed']
    result['referrer-policy'] = 'no-referrer'
    result['cache-control'] = 'no-store'
    return result
}

function toHeaders(values: IncomingHttpHeaders): Headers {
    const headers = new Headers()
    for (const [name, value] of Object.entries(values)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, value)
    }
    return headers
}

function reply(status: number, text: string): Response {
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}

function bootstrap(): Response {
    const nonce = randomBytes(16).toString('base64')
    return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>SHAPI</title><style>body{font:16px system-ui;margin:0;min-height:100dvh;display:grid;place-items:center}p{padding:24px;text-align:center}</style></head><body><p id="state">Opening local service…</p><script nonce="${nonce}">
    (async()=>{
        const node=document.getElementById('state');
        const zh=navigator.language.startsWith('zh');
        node.textContent=zh?'正在打开本地服务…':'Opening local service…';
        const ticket=location.hash.slice(1);
        history.replaceState(null,'',location.pathname);
        try{
            const response=await fetch('${INTERNAL_PREFIX}auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket}),credentials:'same-origin'});
            if(!response.ok)throw Error();
            const result=await response.json();
            if(typeof result.path!=='string'||!result.path.startsWith('/'))throw Error();
            location.replace(location.origin+result.path);
        }catch{node.textContent=zh?'访问已过期，请返回 SHAPI 再次点击原链接。':'Access expired. Return to SHAPI and open the original link again.'}
    })();</script></body></html>`, { headers: {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
        'x-content-type-options': 'nosniff'
    } })
}

function limitedBody(body: ReadableStream<Uint8Array>, maximum: number, finish?: () => void): ReadableStream<Uint8Array> {
    const reader = body.getReader()
    let size = 0
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await reader.read()
                if (chunk.done) { controller.close(); finish?.(); return }
                size += chunk.value.byteLength
                if (size > maximum) throw new Error('Transfer too large')
                controller.enqueue(chunk.value)
            } catch (error) { controller.error(error); void reader.cancel().catch(() => {}); finish?.() }
        },
        cancel() { finish?.(); return reader.cancel().catch(() => {}) }
    })
}

function tlsOptions(lease: LocalServiceLease) {
    const hostname = lease.target.hostname.replace(/^\[|\]$/g, '')
    return { serverName: hostname, rejectUnauthorized: true, checkServerIdentity: (_host: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(hostname, certificate) }
}

class AccessLifetime extends EventEmitter {
    readonly controller = new AbortController()
    destroy(): void { if (!this.controller.signal.aborted) { this.controller.abort(); this.emit('close') } }
}

type WsRelay = { upstream: WebSocket; lifetime: AccessLifetime; peer?: Bun.ServerWebSocket<WsRelay>; pending: Array<string | ArrayBuffer>; pendingBytes: number }

/** Dedicated preview origin; Bun-native WS avoids node:http upgrade incompatibilities. */
export function createLocalServiceGateway(manager: LocalServiceManager, port = 0): Bun.Server<WsRelay> {
    const live = new Set<AccessLifetime>()
    const server = Bun.serve<WsRelay>({
        hostname: '127.0.0.1', port, maxRequestBodySize: MAX_REQUEST_BYTES, idleTimeout: 0,
        async fetch(request, server) {
            const lease = manager.findHost(request.headers.get('host') ?? undefined)
            if (!lease) return reply(410, 'Local service access expired / 本地服务访问已过期，请从 SHAPI 重新打开。')
            const url = new URL(request.url)
            const path = url.pathname + url.search
            if (path === `${INTERNAL_PREFIX}open` && request.method === 'GET') return bootstrap()
            if (path === `${INTERNAL_PREFIX}auth` && request.method === 'POST') {
                if (request.headers.get('origin') !== lease.origin || !request.headers.get('content-type')?.startsWith('application/json')) return reply(403, 'Access denied')
                try {
                    const body = request.body ? await new Response(limitedBody(request.body, 1_024)).text() : ''
                    const value: unknown = JSON.parse(body)
                    const ticket = value && typeof value === 'object' && 'ticket' in value ? value.ticket : null
                    const grant = typeof ticket === 'string' ? manager.redeem(lease, ticket) : null
                    if (!grant) return reply(403, 'Access expired')
                    const secure = lease.origin.startsWith('https:') ? '; Secure' : ''
                    return Response.json({ path: grant.path }, { headers: { 'cache-control': 'no-store',
                        'set-cookie': `${cookieName(lease)}=${grant.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOCAL_SERVICE_ACCESS_MS / 1_000}${secure}` } })
                } catch { return reply(400, 'Invalid access request') }
            }
            if (path.startsWith(INTERNAL_PREFIX)) return reply(404, 'Not found')
            if (live.size >= 200) return reply(429, 'Too many connections')
            const lifetime = new AccessLifetime()
            if (!manager.authorize(lease, accessCookie(request, lease), lifetime)) return reply(401, 'Open this service from SHAPI / 请从 SHAPI 打开此服务。')
            live.add(lifetime)
            lifetime.once('close', () => live.delete(lifetime))
            const deny = (status: number, message: string) => { lifetime.destroy(); return reply(status, message) }
            if ((request.headers.has('origin') && request.headers.get('origin') !== lease.origin)
                || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) return deny(403, 'Access denied')
            if (request.headers.get('sec-fetch-dest') === 'serviceworker') return deny(403, 'Service workers are unavailable in temporary previews')
            if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES) return deny(413, 'Request too large')
            const headers = toHeaders(localServiceRequestHeaders(Object.fromEntries(request.headers.entries()), lease))
            const destination = `${lease.target.protocol}//127.0.0.1:${lease.port}${path}`
            if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
                if (request.method !== 'GET' || request.headers.get('origin') !== lease.origin) return deny(403, 'Access denied')
                for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) headers.delete(name)
                const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map((value) => value.trim())
                try {
                    const upstream = new WebSocket(destination.replace(/^http/, 'ws'), { headers: Object.fromEntries(headers.entries()), protocols, tls: tlsOptions(lease) })
                    upstream.binaryType = 'arraybuffer'
                    const relay: WsRelay = { upstream, lifetime, pending: [], pendingBytes: 0 }
                    lifetime.once('close', () => { upstream.close(); relay.peer?.close(1001, 'Access ended') })
                    upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
                        if (relay.peer) {
                            if (relay.peer.send(event.data) === 0) lifetime.destroy()
                        } else {
                            relay.pendingBytes += typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength
                            if (relay.pendingBytes > MAX_WS_BUFFER) lifetime.destroy()
                            else relay.pending.push(event.data)
                        }
                    }
                    await new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => { lifetime.destroy(); reject(new Error('WebSocket timed out')) }, 15_000)
                        upstream.onopen = () => { clearTimeout(timeout); resolve() }
                        upstream.onerror = () => { clearTimeout(timeout); lifetime.destroy(); reject(new Error('WebSocket failed')) }
                        upstream.onclose = () => { clearTimeout(timeout); lifetime.destroy(); reject(new Error('WebSocket closed')) }
                    })
                    if (lifetime.controller.signal.aborted || !server.upgrade(request, {
                        data: relay,
                        ...(upstream.protocol ? { headers: new Headers({ 'sec-websocket-protocol': upstream.protocol }) } : {})
                    })) return deny(502, 'WebSocket unavailable')
                    return undefined
                } catch { return deny(502, 'WebSocket unavailable') }
            }
            const timeout = setTimeout(() => lifetime.destroy(), 60_000)
            try {
                // No environment HTTP proxy, redirect follow, decompression, or body buffering.
                const incoming = await fetch(destination, { method: request.method, headers,
                    body: request.body ? limitedBody(request.body, MAX_REQUEST_BYTES) : undefined,
                    signal: AbortSignal.any([request.signal, lifetime.controller.signal]),
                    redirect: 'manual', decompress: false, proxy: '', tls: tlsOptions(lease) })
                clearTimeout(timeout)
                const outgoing = localServiceResponseHeaders({ ...Object.fromEntries(incoming.headers.entries()), 'set-cookie': incoming.headers.getSetCookie() }, lease)
                const body = incoming.body ? limitedBody(incoming.body, MAX_RESPONSE_BYTES, () => lifetime.destroy()) : null
                if (!body) lifetime.destroy()
                return new Response(body, { status: incoming.status, headers: toHeaders(outgoing) })
            } catch { return deny(502, 'Local service is unavailable / 本地服务暂时无法访问。') }
            finally { clearTimeout(timeout) }
        },
        websocket: {
            maxPayloadLength: 8 * 1024 * 1024, backpressureLimit: MAX_WS_BUFFER, closeOnBackpressureLimit: true,
            open(peer) {
                peer.data.peer = peer
                if (peer.data.lifetime.controller.signal.aborted) { peer.close(); return }
                for (const data of peer.data.pending) if (peer.send(data) === 0) { peer.data.lifetime.destroy(); break }
                peer.data.pending = []
                peer.data.pendingBytes = 0
            },
            message(peer, data) {
                if (peer.data.upstream.bufferedAmount > MAX_WS_BUFFER) { peer.data.lifetime.destroy(); return }
                peer.data.upstream.send(data)
            },
            close(peer) { peer.data.lifetime.destroy() }
        }
    })
    const stop = server.stop.bind(server)
    server.stop = (closeActive) => { for (const lifetime of live) lifetime.destroy(); return stop(closeActive) }
    return server
}
