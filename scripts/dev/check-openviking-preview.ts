/** Read-only actual-site regression through a disposable Hub/Runner transport.
 * No production configuration, user's browser profile, or upstream writes.
 * bun scripts/dev/check-openviking-preview.ts
 */
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { LocalServiceManager } from '../../hub/src/localServices/manager'
import { createLocalServiceHandler, type LocalServiceHandler, type LocalServiceWebSocket } from '../../hub/src/localServices/gateway'
import { localServiceSocketFixture } from '../../hub/src/localServices/socketTransport.fixture'
import { rewritePreviewScript } from '../../hub/src/localServices/previewScript'

let handler: LocalServiceHandler
const gatewayFailures: Array<{ path: string; status: number; json: boolean }> = []
const hub = Bun.serve<LocalServiceWebSocket>({ hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
        if (new URL(request.url).pathname.startsWith('/preview/')) {
            const response = await handler.fetch(request, server)
            if (response && response.status >= 400) gatewayFailures.push({
                path: sanitize(new URL(request.url).pathname), status: response.status,
                json: Boolean(response.headers.get('content-type')?.includes('application/json'))
            })
            return response
        }
        return new Response('<!doctype html><title>SHAPI test host</title><body></body>', { headers: { 'content-type': 'text/html' } })
    }, websocket: {
        open: (ws) => handler.websocket.open(ws), message: (ws, data) => handler.websocket.message(ws, data), close: (ws) => handler.websocket.close(ws)
    }
})
const origin = `http://127.0.0.1:${hub.port}`
const transport = await localServiceSocketFixture()
const manager = new LocalServiceManager({ mode: 'path', appUrl: origin, canAccessMachine: () => true,
    openTunnel: (machine, request) => transport.openTunnel(machine, request, 'owner') })
const sanitize = (text: string) => text
    .replace(/\/preview\/[a-f0-9]{32}\/__shapi_local\/embed\/[a-f0-9]{64}/g, '/preview/[lease]/[grant]')
    .replace(/\/preview\/[a-f0-9][^\s"']+/g, '/preview/[redacted]')
try {
    await manager.start()
    handler = createLocalServiceHandler(manager)
    for (const engine of [chromium, webkit]) {
        gatewayFailures.length = 0
        const executablePath = process.env[engine === chromium ? 'SHAPI_CHECK_CHROMIUM_EXECUTABLE' : 'SHAPI_CHECK_WEBKIT_EXECUTABLE']
        const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
            page.setDefaultTimeout(15_000)
            const errors: string[] = []
            const responses: Array<{ path: string; status: number }> = []
            page.on('pageerror', (error) => errors.push(sanitize(error.message)))
            page.on('console', (message) => { if (message.type() === 'error') errors.push(sanitize(message.text())) })
            page.on('response', (response) => responses.push({ path: sanitize(new URL(response.url()).pathname), status: response.status() }))
            await page.route('**/*', (route) => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort())
            await page.goto(origin)
            await page.evaluate(() => {
                localStorage.setItem('hapi_access_token::test', 'dummy-hapi-secret')
                document.cookie = 'hapi_test=dummy-cookie;path=/'
            })
            const metadata: Array<{ title: string; icon: string }> = []
            await page.exposeFunction('capturePreviewMetadata', (value: { title: string; icon: string }) => metadata.push(value))
            await page.evaluate(() => window.addEventListener('message', (event) => {
                if (event.data?.type === 'shapi:preview-metadata') {
                    void (window as unknown as { capturePreviewMetadata: (value: unknown) => Promise<void> }).capturePreviewMetadata(event.data)
                }
            }))
            const opened = await manager.open({ namespace: 'owner', userId: 1 }, 'machine', { type: 'session', sessionId: 'readonly-diagnostic' }, 'http://127.0.0.1:1933/', 'embed')
            await page.evaluate((url) => {
                const frame = document.createElement('iframe')
                frame.sandbox.value = 'allow-scripts allow-forms'
                frame.src = url
                frame.style.cssText = 'width:100%;height:650px'
                document.body.append(frame)
            }, opened.url)
            const frame = await (await page.waitForSelector('iframe'))!.contentFrame()
            assert.ok(frame)
            await frame.waitForLoadState('networkidle', { timeout: 20_000 })
            const body = await frame.locator('body').innerText()
            console.log(JSON.stringify({ engine: engine.name(), title: await frame.title(), routeError: body.includes('页面发生错误'), notFound: body.includes('Not Found'), errors, failedRequests: responses.filter((response) => response.status >= 400) }))
            assert.ok(!body.includes('页面发生错误') && !body.includes('Not Found'), 'The actual Studio route must render')
            assert.equal(await frame.title(), 'OpenViking Studio')
            assert.deepEqual(errors, [])
            const access = await frame.evaluate(() => {
                let parentAccess = ''
                try { parentAccess = parent.document.title } catch (error) { parentAccess = (error as Error).name }
                return { parentAccess, stored: localStorage.getItem('hapi_access_token::test'), cookie: document.cookie }
            })
            assert.equal(access.parentAccess, 'SecurityError')
            assert.equal(access.stored, null)
            assert.ok(!access.cookie.includes('dummy-cookie'))
            assert.ok(responses.some((response) => response.path.endsWith('/health') && response.path.startsWith('/preview/') && response.status === 200), 'Health must use the existing proxy')
            assert.ok(metadata.some((value) => value.title === 'OpenViking Studio' && value.icon.endsWith('/studio/favicon-32.png')), 'Title and icon must reach the drawer')
            // Exercise the real SPA router and its lazy-loaded route assets.
            // These pages only read configuration/health; do not submit changes.
            for (const route of ['/studio/settings', '/studio/home']) {
                const link = frame.locator(`a[href$="${route}"]`)
                if (!await link.isVisible()) await frame.getByRole('button', { name: 'Toggle Sidebar', exact: true }).click()
                await link.click()
                await frame.waitForFunction(rewritePreviewScript(`window.location.pathname === ${JSON.stringify(route)}`))
                await frame.waitForLoadState('networkidle')
                assert.ok(!await frame.getByText('页面发生错误', { exact: true }).count(), 'Navigation must not crash the Studio router')
                assert.ok(!await frame.getByText('Not Found', { exact: true }).count(), 'Navigation must keep the Studio base path')
            }
            // A clean browser has no OpenViking API key. Keep its own JSON 401
            // unchanged; distinguish it from a failed SHAPI capability/plain 401.
            for (const failure of gatewayFailures) {
                const api = failure.path.slice(failure.path.indexOf('/api/'))
                assert.ok(failure.status === 401 && failure.json && api.startsWith('/api/'), JSON.stringify(failure))
                const direct = await fetch('http://127.0.0.1:1933' + api)
                assert.equal(direct.status, 401, 'Only the local service itself may require its own API login')
                await direct.body?.cancel()
            }
            assert.deepEqual(errors.filter((error) => !/^Failed to load resource:.*\b401\b/.test(error)), [])
            // Check navigation against the same compiled globals used by the site.
            const originalRoute = await frame.evaluate(rewritePreviewScript('window.location.pathname')) as string
            const physicalUrl = frame.url()
            await frame.evaluate(rewritePreviewScript('history.pushState({test:true}, "", "/studio/preview-navigation-check?q=1")'))
            assert.equal(await frame.evaluate(rewritePreviewScript('window.location.pathname')), '/studio/preview-navigation-check')
            assert.equal(frame.url(), physicalUrl, 'WebKit must not need a forbidden physical URL rewrite')
            await frame.evaluate('history.back()')
            await frame.waitForFunction(rewritePreviewScript(`window.location.pathname === ${JSON.stringify(originalRoute)}`))
            await frame.evaluate(() => {
                localStorage.clear()
                localStorage.setItem('hapi_access_token::test', 'preview-only')
                document.cookie = 'hapi_test=preview-only;path=/'
            })
            assert.equal(await page.evaluate(() => localStorage.getItem('hapi_access_token::test')), 'dummy-hapi-secret')
            assert.ok((await page.evaluate(() => document.cookie)).includes('hapi_test=dummy-cookie'))
            console.log(`PASS ${engine.name()}: actual OpenViking route, proxy API, isolated login and parent access`)
        } finally { await browser.close() }
    }
} catch (error) {
    console.error(sanitize(error instanceof Error ? error.stack ?? error.message : String(error)))
    process.exitCode = 1
} finally {
    handler!?.stop()
    await manager.stop()
    await transport.close()
    hub.stop(true)
}
