/** Disposable Chromium + WebKit sandbox acceptance. No production or user profile.
 * bun scripts/dev/check-local-service-browser.ts
 */
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { LocalServiceManager } from '../../hub/src/localServices/manager'
import { createLocalServiceHandler, type LocalServiceHandler, type LocalServiceWebSocket } from '../../hub/src/localServices/gateway'
import { LocalServiceTunnels } from '../../cli/src/runner/localServiceTunnels'

let handler: LocalServiceHandler | undefined
let outsideRequests = 0
const hub = Bun.serve<LocalServiceWebSocket>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
        const path = new URL(request.url).pathname
        if (path.startsWith('/preview/')) return handler!.fetch(request, server)
        if (path === '/fixture') return new Response('<!doctype html><title>SHAPI test fixture</title><script>localStorage.setItem("hapi-test-login","dummy-login-never-forward");document.cookie="hapi_test=dummy-cookie-never-forward;Path=/";</script>', { headers: { 'content-type': 'text/html' } })
        outsideRequests++
        return new Response('outside the preview', { headers: { 'content-type': 'text/javascript' } })
    },
    websocket: {
        open: (ws) => handler!.websocket.open(ws),
        message: (ws, data) => handler!.websocket.message(ws, data),
        close: (ws) => handler!.websocket.close(ws)
    }
})
const origin = `http://127.0.0.1:${hub.port}`
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === '/socket') { if (server.upgrade(request)) return undefined }
    if (url.pathname === '/assets/early.js') return new Response('window.classicLoaded=true;', { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/assets/module.js') return new Response('import {value} from "./dep.js"; window.moduleLoaded=value;', { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/assets/dep.js') return new Response('export const value=true;', { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/assets/site.css') return new Response('body { --preview-style: loaded; background: url(../image.svg) }', { headers: { 'content-type': 'text/css' } })
    if (url.pathname === '/image.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>', { headers: { 'content-type': 'image/svg+xml' } })
    if (url.pathname === '/events') return new Response('data: ready\n\n', { headers: { 'content-type': 'text/event-stream' } })
    if (url.pathname === '/api/echo') return Response.json({ body: await request.text(), cookie: request.headers.get('cookie'), auth: request.headers.get('authorization') })
    if (url.pathname === '/page') return new Response(`<!doctype html><html><head><title>Local service</title>
<link rel="stylesheet" href="/assets/site.css"><script src="/assets/early.js"></script><script type="module" src="/assets/module.js"></script>
</head><body><img id="image" src="/image.svg"><main id="result">Starting</main>
<script src="${origin}/outside-script"></script><iframe src="${origin}/outside-frame"></iframe>
<script>(async()=>{const result={};
try{result.storage=localStorage.getItem('hapi-test-login')}catch(e){result.storage=e.name}
try{result.cookie=document.cookie}catch(e){result.cookie=e.name}
result.opaque=self.origin;
result.echo=await(await fetch('/api/echo',{method:'POST',headers:{'content-type':'application/json'},body:'hello'})).json();
result.xhr=await new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','/api/echo');x.onload=()=>resolve(x.status);x.onerror=reject;x.send()});
result.ws=await new Promise((resolve,reject)=>{const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/socket');ws.onopen=()=>ws.send('echo');ws.onerror=reject;ws.onmessage=e=>{resolve(e.data);ws.close()}});
result.sse=await new Promise((resolve,reject)=>{const events=new EventSource('/events');events.onmessage=e=>{resolve(e.data);events.close()};events.onerror=()=>{events.close();reject(Error('sse'))}});
try{await navigator.serviceWorker.register('/sw.js');result.sw='unsafe'}catch(e){result.sw='blocked'}
result.classic=window.classicLoaded;result.style=getComputedStyle(document.body).getPropertyValue('--preview-style').trim();
window.fixtureResult=result;document.getElementById('result').textContent='PASS';
})().catch(e=>{window.fixtureError=String(e);document.getElementById('result').textContent='FAIL '+e})</script></body></html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'hapi_test=overwritten; Path=/', 'content-security-policy': 'sandbox allow-same-origin' }
    })
    return new Response('Not found', { status: 404 })
}, websocket: { message(ws, data) { ws.send(data) } } })
const runner = new LocalServiceTunnels()
const manager = new LocalServiceManager({ mode: 'path', appUrl: origin, sshHost: '127.0.0.1', sshListenHost: '127.0.0.1', sshPort: 0,
    canAccessMachine: () => true, openTunnel: (_machine, request) => runner.open(request)
})

try {
    await manager.start()
    handler = createLocalServiceHandler(manager)
    for (const engine of [chromium, webkit]) {
        const executablePath = process.env[engine === chromium ? 'SHAPI_CHECK_CHROMIUM_EXECUTABLE' : 'SHAPI_CHECK_WEBKIT_EXECUTABLE']
        const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
            await page.goto(origin + '/fixture')
            const countBefore = outsideRequests
            const opened = await manager.open({ namespace: 'test', userId: 1 }, 'machine', { type: 'session', sessionId: engine.name() }, `http://localhost:${upstream.port}/page?q=1#part`)
            await page.goto(opened.url)
            await page.waitForURL((url) => /^\/preview\/[a-f0-9]{32}\/[a-f0-9]{64}\/page$/.test(url.pathname))
            await page.waitForFunction('window.fixtureResult || window.fixtureError', undefined, { timeout: 15_000 })
            const result = await page.evaluate('window.fixtureResult || window.fixtureError')
            assert.equal(typeof result, 'object', String(result))
            assert.equal(result.storage, 'SecurityError')
            assert.equal(result.cookie, 'SecurityError')
            assert.equal(result.opaque, 'null')
            assert.deepEqual(result.echo, { body: 'hello', cookie: null, auth: null })
            assert.equal(result.classic, true)
            assert.equal(result.style, 'loaded')
            assert.equal(result.xhr, 200)
            assert.equal(result.ws, 'echo')
            assert.equal(result.sse, 'ready')
            assert.equal(result.sw, 'blocked')
            await page.waitForFunction('window.moduleLoaded === true && document.getElementById("image").naturalWidth === 8')
            assert.equal(outsideRequests, countBefore, 'sandbox must not request Hub scripts/frames outside the lease')
            const previewUrl = page.url()
            assert.equal(new URL(previewUrl).search, '?q=1')
            assert.equal(new URL(previewUrl).hash, '#part')
            // SVG direct navigation must remain sandboxed too, not only HTML.
            const svgUrl = previewUrl.replace(/\/page\?.*$/, '/image.svg')
            await page.goto(svgUrl)
            assert.equal(await page.evaluate('(()=>{try{return localStorage.getItem("hapi-test-login")}catch(e){return e.name}})()'), 'SecurityError')
            // An expired lease is a plain error, never a fallback to the HAPI SPA.
            manager.closeLease(new URL(opened.url).pathname.split('/')[2])
            const expired = await page.goto(previewUrl)
            assert.equal(expired?.status(), 410)
            await page.goto(origin + '/fixture')
            assert.equal(await page.evaluate('localStorage.getItem("hapi-test-login")'), 'dummy-login-never-forward')
            console.log(`PASS ${engine.name()}: mobile viewport; opaque sandbox; credential isolation; HTML/CSS/images/modules; fetch/XHR/SSE/WebSocket; SVG; expiry`)
        } finally { await browser.close() }
    }
} finally {
    handler?.stop()
    await manager.stop()
    runner.dispose()
    upstream.stop(true)
    hub.stop(true)
}
