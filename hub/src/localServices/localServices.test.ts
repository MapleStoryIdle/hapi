import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { LocalServiceTunnelRequest } from '@hapi/protocol/localServices'
import { LOCAL_SERVICE_ACCESS_MS, LocalServiceManager, validateLocalServiceOrigin } from './manager'
import { createLocalServiceGateway, localServiceRequestHeaders, localServiceResponseHeaders } from './gateway'

import { localServiceSocketFixture } from './socketTransport.fixture'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    return (server.address() as AddressInfo).port
}

type HttpResult = { status: number; headers: IncomingHttpHeaders; text: string }
function request(port: number, host: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const outgoing = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host, ...options.headers } }, (incoming) => {
            let text = ''
            incoming.setEncoding('utf8')
            incoming.on('data', (chunk: string) => { text += chunk })
            incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, text }))
            incoming.once('error', reject)
        })
        outgoing.on('error', reject)
        outgoing.setTimeout(5_000, () => outgoing.destroy(new Error('test request timed out')))
        outgoing.end(options.body)
    })
}

async function fixture(options: { onUploadChunk?: () => void } = {}) {
    const local = createServer(async (incoming, response) => {
        if (incoming.url === '/redirect') { response.writeHead(302, { location: `http://localhost:${localPort}/next?q=1#part` }); response.end(); return }
        if (incoming.url === '/gzip') { response.writeHead(200, { 'content-encoding': 'gzip' }); response.end(gzipSync('compressed service response')); return }
        if (incoming.url === '/sse') {
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.write('data: first\n\n')
            setTimeout(() => response.end('data: last\n\n'), 250)
            return
        }
        let body = ''
        for await (const chunk of incoming) { body += Buffer.from(chunk).toString(); if (incoming.url === '/stream-upload') options.onUploadChunk?.() }
        response.setHeader('set-cookie', ['app_session=demo; HttpOnly; Domain=localhost; Path=/'])
        response.end(JSON.stringify({ path: incoming.url, headers: incoming.headers, body }))
    })
    const localPort = await listen(local)
    const transport = await localServiceSocketFixture('machine-1')
    const runner = transport.runner
    let opens = 0
    const issued: LocalServiceTunnelRequest[] = []
    let online = true
    const manager = new LocalServiceManager({
        originTemplate: 'http://{id}.localhost', appUrl: 'http://localhost:5173',
        canAccessMachine: (identity, machineId) => online && identity.namespace === 'owner' && machineId === 'machine-1',
        openTunnel: (_machineId, input) => { opens += 1; issued.push(input); return transport.openTunnel(_machineId, input) }
    })
    await manager.start()
    cleanup.push(() => manager.stop())
    cleanup.push(() => transport.close())
    const gateway = createLocalServiceGateway(manager)
    cleanup.push(() => { gateway.stop(true) })
    const port = gateway.port!
    const openUrl = (url: string, presentation: 'tab' | 'embed' = 'tab') => manager.open({ namespace: 'owner', userId: 1 }, 'machine-1', { type: 'session', sessionId: 'session-1' }, url, presentation)
    const open = (path = '/', presentation: 'tab' | 'embed' = 'tab') => openUrl(`http://localhost:${localPort}${path}`, presentation)
    const enter = async (url: string) => {
        const link = new URL(url)
        const auth = await request(port, link.host, '/__shapi_local/auth', {
            method: 'POST', headers: { origin: link.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: link.hash.slice(1) })
        })
        expect(auth.status).toBe(200)
        return { host: link.host, origin: link.origin, cookie: auth.headers['set-cookie']![0].split(';')[0], path: (JSON.parse(auth.text) as { path: string }).path }
    }
    return { manager, runner, port, open, openUrl, enter, issued, get opens() { return opens }, offline: () => { online = false } }
}

describe('local service access over the existing Hub socket', () => {
    it('keeps isolated-origin workers available while refusing service workers', async () => {
        const f = await fixture()
        const auth = await f.enter((await f.open()).url)
        for (const destination of ['worker', 'sharedworker']) {
            expect((await request(f.port, auth.host, '/worker.js', { headers: { cookie: auth.cookie, 'sec-fetch-dest': destination } })).status).toBe(200)
        }
        expect((await request(f.port, auth.host, '/sw.js', { headers: { cookie: auth.cookie, 'sec-fetch-dest': 'serviceworker' } })).status).toBe(403)
    })

    it('opens arbitrary local ports, preserves URLs and application auth, and hides the gateway credential', async () => {
        const f = await fixture()
        const opened = await f.open('/settings?a=1#model')
        const auth = await f.enter(opened.url)
        expect(auth.path).toBe('/settings?a=1#model')
        const result = await request(f.port, auth.host, '/settings?a=1', {
            method: 'POST', body: 'hello', headers: { cookie: `${auth.cookie}; app_session=abc`, authorization: 'Bearer app-key', origin: auth.origin }
        })
        expect(result.status).toBe(200)
        const data = JSON.parse(result.text) as { path: string; headers: Record<string, string>; body: string }
        expect(data.path).toBe('/settings?a=1')
        expect(data.body).toBe('hello')
        expect(data.headers.cookie.trim()).toBe('app_session=abc')
        expect(data.headers.authorization).toBe('Bearer app-key')
        expect(result.text).not.toContain(auth.cookie)
        expect(result.headers['set-cookie']![0]).not.toContain('Domain=')
    })

    it('does not allow a bare link, another host, cross-origin writes, or ticket replay', async () => {
        const f = await fixture()
        const opened = new URL((await f.open()).url)
        expect((await request(f.port, opened.host, '/')).status).toBe(401)
        expect((await request(f.port, 'unknown.localhost', '/')).status).toBe(410)
        const auth = await f.enter(opened.href)
        const replay = await request(f.port, opened.host, '/__shapi_local/auth', {
            method: 'POST', headers: { origin: opened.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: opened.hash.slice(1) })
        })
        expect(replay.status).toBe(403)
        expect((await request(f.port, auth.host, '/', { method: 'POST', headers: { cookie: auth.cookie, origin: 'https://attacker.example' } })).status).toBe(403)
        await expect(f.manager.open({ namespace: 'other', userId: 1 }, 'machine-1', { type: 'session', sessionId: 'session-1' }, 'http://localhost:3000')).rejects.toThrow('offline')
    })

    it('reuses one tunnel under concurrent clicks, renews it, and rebuilds it once after expiry', async () => {
        const f = await fixture()
        const opened = await Promise.all([f.open(), f.open(), f.open()])
        expect(new Set(opened.map((value) => new URL(value.url).host)).size).toBe(1)
        expect(f.opens).toBe(1)
        const oldHost = new URL(opened[0].url).host
        const lease = f.manager.findHost(oldHost)!
        lease.expiresAt = Date.now() + 500
        await f.open()
        expect(lease.expiresAt - Date.now()).toBeGreaterThan(60_000)
        lease.expiresAt = Date.now() - 1
        const rebuilt = await Promise.all([f.open(), f.open(), f.open()])
        expect(new Set(rebuilt.map((value) => new URL(value.url).host)).size).toBe(1)
        expect(new URL(rebuilt[0].url).host).not.toBe(oldHost)
        expect(f.opens).toBe(2)
        expect((await request(f.port, oldHost, '/')).status).toBe(410)
    })

    it('streams the first SSE event before the response finishes', async () => {
        const f = await fixture()
        const auth = await f.enter((await f.open('/sse')).url)
        await new Promise<void>((resolve, reject) => {
            const outgoing = httpRequest({ hostname: '127.0.0.1', port: f.port, path: '/sse', headers: { host: auth.host, cookie: auth.cookie } }, (incoming) => {
                incoming.once('data', (chunk: Buffer) => {
                    try { expect(chunk.toString()).toBe('data: first\n\n'); resolve() } catch (error) { reject(error) }
                })
                incoming.once('end', () => outgoing.destroy())
                incoming.on('error', reject)
            })
            outgoing.on('error', reject)
            outgoing.end()
        })
    })

    it('streams an upload to the local service before the browser finishes sending', async () => {
        let received!: () => void
        const first = new Promise<void>((resolve) => { received = resolve })
        const f = await fixture({ onUploadChunk: received })
        const auth = await f.enter((await f.open('/stream-upload')).url)
        const client = connect({ host: '127.0.0.1', port: f.port })
        cleanup.push(() => { client.destroy() })
        client.on('error', () => {})
        client.resume()
        await new Promise<void>((resolve) => client.once('connect', resolve))
        client.write(`POST /stream-upload HTTP/1.1\r\nHost: ${auth.host}\r\nCookie: ${auth.cookie}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nfirst\r\n`)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([first, new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Upload was buffered')), 1_000) })])
        } finally {
            clearTimeout(timer)
            const response = new Promise<void>((resolve) => client.once('data', () => resolve()))
            client.write('0\r\n\r\n')
            await response
            client.destroy()
        }
    })

    it('rejects reuse of an already registered lease identity', async () => {
        const f = await fixture()
        await f.open()
        expect((await f.runner.open(f.issued[0])).ok).toBe(false)
    })

    it('revokes access when the Runner goes offline', async () => {
        const f = await fixture()
        const auth = await f.enter((await f.open()).url)
        f.offline()
        f.manager.sweep()
        expect((await request(f.port, auth.host, '/', { headers: { cookie: auth.cookie } })).status).toBe(410)
    })

    it('rewrites local redirects without following them on the Hub', async () => {
        const f = await fixture()
        const auth = await f.enter((await f.open('/redirect')).url)
        const result = await request(f.port, auth.host, '/redirect', { headers: { cookie: auth.cookie } })
        expect(result.status).toBe(302)
        expect(result.headers.location).toBe(`${auth.origin}/next?q=1#part`)
    })

    it('keeps compressed responses consistent with Content-Encoding', async () => {
        const f = await fixture()
        const auth = await f.enter((await f.open('/gzip')).url)
        const result = await fetch(`http://127.0.0.1:${f.port}/gzip`, { headers: { host: auth.host, cookie: auth.cookie }, decompress: false, proxy: '' })
        expect(result.headers.get('content-encoding')).toBe('gzip')
        expect(gunzipSync(Buffer.from(await result.arrayBuffer())).toString()).toBe('compressed service response')
    })

    it('consumes a browser ticket once under simultaneous redemption', async () => {
        const f = await fixture()
        const opened = new URL((await f.open()).url)
        const redeem = () => request(f.port, opened.host, '/__shapi_local/auth', {
            method: 'POST', headers: { origin: opened.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ticket: opened.hash.slice(1) })
        })
        expect((await Promise.all([redeem(), redeem(), redeem()])).map((result) => result.status).sort()).toEqual([200, 403, 403])
    })

    it.each([false, true])('proxies authenticated WebSocket messages and closes them on lease revocation (binary=%s)', async (binary) => {
        const echo = Bun.serve({
            hostname: '127.0.0.1', port: 0,
            fetch(request, server) { return server.upgrade(request, { headers: new Headers({ 'sec-websocket-protocol': 'shapi-test' }) }) ? undefined : new Response('upgrade required', { status: 426 }) },
            websocket: { message(socket, data) { socket.send(data) } }
        })
        cleanup.push(() => { echo.stop(true) })
        const f = await fixture()
        const auth = await f.enter((await f.openUrl(`http://127.0.0.1:${echo.port}/echo`)).url)
        const client = new WebSocket(`ws://127.0.0.1:${f.port}/echo`, { protocols: ['shapi-test'], headers: { host: auth.host, origin: auth.origin, cookie: auth.cookie } })
        client.binaryType = 'arraybuffer'
        cleanup.push(() => client.close())
        const message = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('WebSocket timed out')), 3_000)
            client.onopen = () => client.send(binary ? Buffer.from('hello through Hub') : 'hello through Hub')
            client.onmessage = (event) => { clearTimeout(timeout); resolve(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString()) }
            client.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket failed')) }
        })
        expect(message).toBe('hello through Hub')
        expect(client.protocol).toBe('shapi-test')
        const closed = new Promise<void>((resolve) => { client.onclose = () => resolve() })
        f.manager.closeLease(auth.host.split('.')[0])
        await closed
    })

    it('does not follow WebSocket redirects out of the fixed target', async () => {
        let reachedTrap = false
        const trap = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { reachedTrap = true; return new Response('denied') } })
        const redirect = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${trap.port}/trap` } }) } })
        cleanup.push(() => { trap.stop(true); redirect.stop(true) })
        const f = await fixture()
        const auth = await f.enter((await f.openUrl(`http://127.0.0.1:${redirect.port}/`)).url)
        const client = new WebSocket(`ws://127.0.0.1:${f.port}/`, { headers: { host: auth.host, origin: auth.origin, cookie: auth.cookie } })
        cleanup.push(() => client.close())
        await new Promise<void>((resolve) => { client.onerror = () => resolve(); client.onclose = () => resolve() })
        expect(reachedTrap).toBe(false)
    })

    it('expires active streams at the browser grant deadline, not only on the next request', async () => {
        const f = await fixture()
        const opened = new URL((await f.open()).url)
        const lease = f.manager.findHost(opened.host)!
        const grant = f.manager.redeem(lease, opened.hash.slice(1))!
        let destroyed = false
        expect(f.manager.authorize(lease, grant.cookie, { destroy: () => { destroyed = true }, once: () => {} })).toBe(true)
        const now = spyOn(Date, 'now').mockReturnValue(Date.now() + LOCAL_SERVICE_ACCESS_MS + 1)
        try {
            f.manager.sweep()
            expect(destroyed).toBe(true)
            expect(f.manager.authorize(lease, grant.cookie)).toBe(false)
        } finally { now.mockRestore() }
    })

    it('keeps bootstrap navigation on the preview origin, even for a double-slash path', async () => {
        const f = await fixture()
        const opened = new URL((await f.open('//external.example/path')).url)
        const page = await request(f.port, opened.host, opened.pathname)
        expect(page.text).toContain('location.replace(location.origin+result.path)')
        const auth = await f.enter(opened.href)
        expect(auth.path).toBe('//external.example/path')
    })
})

describe('preview origin isolation', () => {
    it('requires HTTPS and a preview origin outside the application hostname', () => {
        expect(() => validateLocalServiceOrigin('https://{id}.preview.example.com', 'https://hapi.example.com')).not.toThrow()
        for (const template of ['https://hapi.example.com', 'https://{id}.hapi.example.com', 'http://{id}.preview.example.com', 'https://{id}.preview.example.com/path']) {
            expect(() => validateLocalServiceOrigin(template, 'https://hapi.example.com')).toThrow()
        }
    })

    it('never accepts gateway cookies from upstream or forwards internal credentials', () => {
        const lease = { origin: 'https://abc.preview.example.com', target: { protocol: 'http:' as const, hostname: 'localhost' as const, port: 3000, origin: 'http://localhost:3000', path: '/', hash: '' } }
        const headers = localServiceRequestHeaders({ cookie: '__Host-shapi-local=secret; app=ok', connection: 'x-secret', 'x-secret': 'bad' }, lease)
        expect(headers.cookie?.trim()).toBe('app=ok')
        expect(headers['x-secret']).toBeUndefined()
        expect(localServiceResponseHeaders({ location: 'http://localhost:3000/path?a=1#x', 'set-cookie': ['__Host-shapi-local=evil; Path=/', 'app=ok; Domain=example.com'] }, lease)).toMatchObject({
            location: 'https://abc.preview.example.com/path?a=1#x', 'set-cookie': ['app=ok']
        })
    })
})

it('domain-mode embeds use isolated URL grants rather than third-party cookies', async () => {
    const f = await fixture()
    const tab = new URL((await f.open('/page')).url)
    const tabGrant = await f.enter(tab.href)
    const opened = new URL((await f.open('/page?q=1#part', 'embed')).url)
    expect(opened.origin).not.toBe(tab.origin)
    expect((await request(f.port, opened.host, '/page', { headers: { cookie: tabGrant.cookie } })).status).toBe(401)
    const result = await request(f.port, opened.host, opened.pathname + opened.search, {
        headers: { origin: 'null', cookie: 'shapi_local_dev=wrong; app=secret', authorization: 'Bearer secret' }
    })
    expect(result.status).toBe(200)
    expect(result.headers['content-security-policy']).toContain('frame-ancestors http://localhost:5173')
    expect(result.headers['content-security-policy']).toContain('sandbox allow-scripts allow-forms;')
    expect(result.headers['set-cookie']).toBeUndefined()
    const data = JSON.parse(result.text)
    expect(data.path).toBe('/page?q=1')
    expect(data.headers.cookie).toBeUndefined()
    expect(data.headers.authorization).toBeUndefined()
    const capability = opened.pathname.split('/')[3]
    expect((await request(f.port, opened.host, '/page', { headers: { cookie: 'shapi_local_dev=' + capability } })).status).toBe(401)
    f.offline()
    expect((await request(f.port, opened.host, opened.pathname)).status).toBe(410)
})
