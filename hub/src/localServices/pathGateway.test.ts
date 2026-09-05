import { afterEach, describe, expect, it, mock } from 'bun:test'
import { gzipSync } from 'node:zlib'
import type { LocalServiceTunnelRequest, LocalServiceTunnelResponse } from '@hapi/protocol/localServices'
import { LocalServiceManager } from './manager'
import { createLocalServiceHandler, type LocalServiceHandler, type LocalServiceWebSocket } from './gateway'

const { LocalServiceTunnels } = await import(new URL('../../../cli/src/runner/localServiceTunnels.ts', import.meta.url).href) as {
    LocalServiceTunnels: new () => { open: (request: LocalServiceTunnelRequest) => Promise<LocalServiceTunnelResponse>; dispose: () => void }
}
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
    let requests = 0
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
        requests++
        const path = new URL(request.url).pathname
        if (request.headers.get('upgrade') === 'websocket') {
            if (server.upgrade(request)) return undefined
        }
        if (path === '/jump') return new Response(null, { status: 302, headers: { location: '../next?q=1#part' } })
        if (path === '/escape') return new Response(null, { status: 302, headers: { location: 'https://external.example/' } })
        if (path === '/html') return new Response(gzipSync('<html><head><script src="/assets/app.js"></script></head><body>hello</body></html>'), {
            headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-security-policy': 'sandbox allow-same-origin', 'set-cookie': 'hub=overwrite; Path=/' }
        })
        if (path === '/sse') {
            let timer: ReturnType<typeof setTimeout>
            cleanup.push(() => clearTimeout(timer))
            return new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('data: first\n\n'))
                timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('data: last\n\n')); controller.close() }, 50)
            }, cancel() { clearTimeout(timer) } }), { headers: { 'content-type': 'text/event-stream' } })
        }
        return Response.json({ path: new URL(request.url).pathname + new URL(request.url).search, headers: Object.fromEntries(request.headers), body: await request.text() })
    }, websocket: { message(ws, data) { ws.send(data) } } })
    cleanup.push(() => { upstream.stop(true) })
    let handler: LocalServiceHandler | null = null
    const hub = Bun.serve<LocalServiceWebSocket>({ hostname: '127.0.0.1', port: 0,
        fetch: (request, server) => handler!.fetch(request, server),
        websocket: {
            open: (ws) => handler!.websocket.open(ws),
            message: (ws, data) => handler!.websocket.message(ws, data),
            close: (ws) => handler!.websocket.close(ws)
        }
    })
    cleanup.push(() => { handler?.stop(); hub.stop(true) })
    const origin = `http://127.0.0.1:${hub.port}`
    const runner = new LocalServiceTunnels()
    cleanup.push(() => runner.dispose())
    const manager = new LocalServiceManager({ mode: 'path', appUrl: origin, sshHost: '127.0.0.1', sshListenHost: '127.0.0.1', sshPort: 0,
        canAccessMachine: () => true, openTunnel: (_machine, request) => runner.open(request)
    })
    cleanup.push(() => manager.stop())
    await manager.start()
    handler = createLocalServiceHandler(manager)
    const open = (path = '/', sessionId = 'session', presentation: 'tab' | 'embed' = 'tab') => manager.open({ namespace: 'owner', userId: 1 }, 'machine', { type: 'session', sessionId }, `http://localhost:${upstream.port}${path}`, presentation)
    const redeem = (url: string) => fetch(url.split('#')[0].replace(/open$/, 'auth'), {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }), proxy: ''
    })
    const enter = async (path = '/', session = 'session') => {
        const opened = await open(path, session)
        const response = await redeem(opened.url)
        expect(response.status).toBe(200)
        const result = await response.json() as { path: string }
        return { opened, path: result.path, base: result.path.split('/').slice(0, 4).join('/') }
    }
    return { manager, origin, open, redeem, enter, get requests() { return requests } }
}

describe('same-domain path gateway through real Runner SSH', () => {
    it('redeems once, preserves URL and strips Hub credentials in both directions', async () => {
        const f = await fixture()
        const entry = await f.enter('/settings?q=1#part')
        expect(new URL(entry.opened.url).origin).toBe(f.origin)
        expect(entry.path.endsWith('/settings?q=1#part')).toBe(true)
        expect((await f.redeem(entry.opened.url)).status).toBe(403)
        const response = await fetch(f.origin + entry.path, {
            method: 'POST', headers: { origin: 'null', cookie: 'hub=secret', authorization: 'Bearer hub-secret' }, body: 'payload', proxy: ''
        })
        expect(response.status).toBe(200)
        const result = await response.json() as { path: string; headers: Record<string, string>; body: string }
        expect(result.path).toBe('/settings?q=1')
        expect(result.body).toBe('payload')
        expect(result.headers.cookie).toBeUndefined()
        expect(result.headers.authorization).toBeUndefined()
        expect(response.headers.has('set-cookie')).toBe(false)
        expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-forms;')
    })

    it('does not authorize bare/wrong/cross-lease paths or arbitrary browser origins', async () => {
        const f = await fixture()
        const a = await f.enter()
        const b = await f.enter('/', 'another-session')
        const original = new URL(a.opened.url).pathname.replace('/__shapi_local/open', '/')
        expect((await fetch(f.origin + original, { proxy: '' })).status).toBe(401)
        expect((await fetch(f.origin + a.base.replace(a.base.split('/')[3], '0'.repeat(64)) + '/', { proxy: '' })).status).toBe(401)
        expect((await fetch(f.origin + b.base.replace(b.base.split('/')[3], a.base.split('/')[3]) + '/', { proxy: '' })).status).toBe(401)
        expect((await fetch(f.origin + a.path, { headers: { origin: 'https://evil.example' }, proxy: '' })).status).toBe(403)
        expect((await fetch(f.origin + a.path, { headers: { 'sec-fetch-dest': 'serviceworker' }, proxy: '' })).status).toBe(403)
        expect((await fetch(f.origin + a.path, { headers: { 'sec-fetch-dest': 'worker' }, proxy: '' })).status).toBe(403)
        expect((await fetch(f.origin + a.path, { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' }, proxy: '' })).status).toBe(403)
        expect(f.requests).toBe(0)
    })

    it('handles opaque-origin preflights without forwarding them', async () => {
        const f = await fixture()
        const entry = await f.enter('/api/data')
        const response = await fetch(f.origin + entry.path, { method: 'OPTIONS', proxy: '', headers: {
            origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-example'
        } })
        expect(response.status).toBe(204)
        expect(response.headers.get('access-control-allow-origin')).toBe('null')
        expect(response.headers.get('access-control-allow-headers')).toBe('content-type,x-example')
        expect(f.requests).toBe(0)
    })

    it('rewrites compressed HTML and safe redirects, blocks redirect escapes', async () => {
        const f = await fixture()
        const entry = await f.enter('/html')
        const response = await fetch(f.origin + entry.path, { proxy: '', decompress: false })
        expect(response.headers.has('content-encoding')).toBe(false)
        expect(response.headers.has('set-cookie')).toBe(false)
        expect(await response.text()).toContain(`${f.origin}${entry.base}/assets/app.js`)
        const jump = await fetch(`${f.origin}${entry.base}/jump`, { redirect: 'manual', proxy: '' })
        expect(jump.status).toBe(302)
        expect(jump.headers.get('location')).toBe(`${f.origin}${entry.base}/next?q=1#part`)
        const escape = await fetch(`${f.origin}${entry.base}/escape`, { redirect: 'manual', proxy: '' })
        expect(escape.status).toBe(502)
        expect(escape.headers.has('location')).toBe(false)
    })

    it('streams SSE and relays sandbox WebSocket messages, closing the socket on revocation', async () => {
        const f = await fixture()
        const entry = await f.enter('/sse')
        const response = await fetch(f.origin + entry.path, { proxy: '' })
        const reader = response.body!.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: last\n\n')
        expect((await reader.read()).done).toBe(true)
        const socket = new WebSocket(`${f.origin.replace('http', 'ws')}${entry.base}/echo`, { headers: { origin: 'null' } })
        cleanup.push(() => socket.close())
        await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject })
        const echoed = new Promise((resolve) => { socket.onmessage = (event) => resolve(event.data) })
        socket.send('sandbox echo')
        expect(await echoed).toBe('sandbox echo')
        const closed = new Promise<void>((resolve) => { socket.onclose = () => resolve() })
        f.manager.closeLease(entry.base.split('/')[2])
        await closed
        expect((await fetch(f.origin + entry.path, { proxy: '' })).status).toBe(410)
    })
})

describe('shared-listener preview backpressure', () => {
    it.each([-1, 0])('revokes on a queued/dropped server send (%s), without draining the rest', (sendResult) => {
        const handler = createLocalServiceHandler({} as LocalServiceManager)
        const destroy = mock(() => {})
        const send = mock(() => sendResult)
        const peer = {
            data: { lifetime: { controller: new AbortController(), destroy }, pending: ['one', 'two'], pendingBytes: 6 }, send
        } as unknown as Bun.ServerWebSocket<LocalServiceWebSocket>
        handler.websocket.open(peer)
        expect(send).toHaveBeenCalledTimes(1)
        expect(destroy).toHaveBeenCalledTimes(1)
        expect(peer.data.pending).toEqual([])
    })

    it('checks upstream buffering after the first large send, without needing a second message', () => {
        const handler = createLocalServiceHandler({} as LocalServiceManager)
        const destroy = mock(() => {})
        const upstream = { bufferedAmount: 0, send: mock(() => { upstream.bufferedAmount = 2 * 1024 * 1024 }) }
        const peer = { data: { lifetime: { destroy }, upstream } } as unknown as Bun.ServerWebSocket<LocalServiceWebSocket>
        handler.websocket.message(peer, 'data')
        expect(upstream.send).toHaveBeenCalledTimes(1)
        expect(destroy).toHaveBeenCalledTimes(1)
    })
})

it('embedded grants load directly, are sandboxed, cannot become tab grants, and revoke with the lease', async () => {
    const f = await fixture()
    const embedded = await f.open('/html?x=1#part', 'session', 'embed')
    expect(embedded.url).toContain('/__shapi_local/embed/')
    const url = new URL(embedded.url)
    const response = await fetch(url, { proxy: '' })
    expect(response.status).toBe(200)
    const csp = response.headers.get('content-security-policy')!
    expect(csp).toContain('frame-ancestors ' + f.origin)
    expect(csp).toContain('sandbox allow-scripts allow-forms;')
    expect(csp).not.toContain('allow-same-origin')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(response.headers.has('x-frame-options')).toBe(false)
    expect(await response.text()).toContain(url.pathname.replace('/html', '/assets/app.js'))
    const downgraded = embedded.url.replace('/__shapi_local/embed/', '/')
    expect((await fetch(downgraded, { proxy: '' })).status).toBe(401)
    const normal = await f.enter('/html')
    expect((await fetch(f.origin + normal.path.replace(normal.base, normal.base.replace(/\/([a-f0-9]{64})$/, '/__shapi_local/embed/$1')), { proxy: '' })).status).toBe(401)
    expect((await fetch(embedded.url, { headers: { origin: 'https://evil.example' }, proxy: '' })).status).toBe(403)
    f.manager.closeLease(url.pathname.split('/')[2])
    expect((await fetch(embedded.url, { proxy: '' })).status).toBe(410)
})

it('reuses one iframe grant per service across repeated drawer opens', async () => {
    const f = await fixture()
    const first = await f.open('/one', 'session', 'embed')
    const base = first.url.slice(0, first.url.lastIndexOf('/'))
    for (let index = 0; index < 35; index++) {
        const next = await f.open('/two?attempt=' + index, 'session', 'embed')
        expect(next.url).toBe(base + '/two?attempt=' + index)
    }
    expect((await fetch(first.url, { proxy: '' })).status).toBe(200)
})
