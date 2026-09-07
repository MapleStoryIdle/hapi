/** Real HTTP → authenticated Hub → existing machine socket → Runner → HTTP smoke check.
 * Uses disposable state and loopback ports; never starts an agent or touches production.
 * Run from the repository root: bun scripts/dev/check-local-services.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LocalServiceSource, OpenLocalServiceResponse } from '../../shared/src/localServices'

const root = resolve(import.meta.dir, '../..')
const state = await mkdtemp(join(tmpdir(), 'shapi-forwarding-check-'))
const token = crypto.randomUUID()
const nativeId = crypto.randomUUID()
const pathMode = Bun.argv.includes('--path')
const children: Array<{ name: string; process: Bun.Subprocess; log: () => string }> = []

async function unusedPort(): Promise<number> {
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    return port
}

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
        for (const child of children) assert.equal(child.process.exitCode, null, `${child.name} stopped unexpectedly`)
        const result = await read().catch(() => undefined)
        if (result !== undefined) return result
        await Bun.sleep(150)
    }
    throw new Error(`Timed out: ${label}`)
}

const hubPort = await unusedPort()
const previewPort = await unusedPort()
const hubUrl = `http://127.0.0.1:${hubPort}`
const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
    HAPI_HOME: state, CODEX_HOME: join(state, 'codex'),
    DB_PATH: join(state, 'test.db'), CLI_API_TOKEN: token,
    HAPI_API_URL: hubUrl, HAPI_PUBLIC_URL: hubUrl,
    HAPI_LISTEN_HOST: '127.0.0.1', HAPI_LISTEN_PORT: String(hubPort),
    ...(pathMode ? { HAPI_LOCAL_SERVICE_MODE: 'path' } : { HAPI_LOCAL_SERVICE_ORIGIN: `http://{id}.localhost:${previewPort}` }),
    HAPI_LOCAL_SERVICE_GATEWAY_PORT: String(previewPort),
    TELEGRAM_NOTIFICATION: 'false'
}

function launch(name: string, cwd: string, args: string[]): void {
    const process = Bun.spawn([Bun.argv[0], '--no-env-file', ...args], { cwd: join(root, cwd), env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    let log = ''
    for (const stream of [process.stdout, process.stderr]) {
        void (async () => {
            for await (const chunk of stream) log = (log + new TextDecoder().decode(chunk)).slice(-8_000)
        })()
    }
    children.push({ name, process, log: () => log.replaceAll(token, '[redacted]') })
}

async function json<T>(path: string, bearer?: string, body?: unknown): Promise<T> {
    const response = await fetch(hubUrl + path, {
        method: body === undefined ? 'GET' : 'POST', proxy: '', signal: AbortSignal.timeout(20_000),
        headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    assert.equal(response.status, 200, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`)
    return await response.json() as T
}

function preview(url: URL, path: string, cookie?: string, ticket?: string): Promise<{ status: number; cookie: string; body: string }> {
    return new Promise((resolve, reject) => {
        const request = httpRequest({
            hostname: '127.0.0.1', port: pathMode ? hubPort : previewPort, path, method: ticket ? 'POST' : 'GET',
            headers: { host: url.host, ...(cookie ? { cookie } : {}), ...(ticket ? { origin: url.origin, 'content-type': 'application/json' } : {}) }
        }, (response) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (chunk: string) => { body += chunk })
            response.on('error', reject)
            response.on('end', () => resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0].split(';')[0] ?? '', body }))
        })
        request.on('error', reject)
        request.setTimeout(10_000, () => request.destroy(new Error('Preview request timed out')))
        request.end(ticket ? JSON.stringify({ ticket }) : undefined)
    })
}

const service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request, server) => {
    if (request.headers.get('upgrade') === 'websocket') { if (server.upgrade(request)) return undefined }
    return Response.json({ path: new URL(request.url).pathname, query: new URL(request.url).search, cookie: request.headers.get('cookie') })
}, websocket: { message(ws, data) { ws.send(data) } } })
try {
    const transcriptDir = join(state, 'codex', 'sessions', '2026', '09', '05')
    await mkdir(transcriptDir, { recursive: true })
    await writeFile(join(transcriptDir, `rollout-2026-09-05T00-00-00-${nativeId}.jsonl`), JSON.stringify({
        type: 'session_meta', timestamp: new Date().toISOString(),
        payload: { id: nativeId, cwd: state, originator: 'codex_cli_rs', cli_version: 'test', source: 'cli' }
    }) + '\n')
    launch('Hub', 'hub', ['src/index.ts'])
    await eventually(async () => (await fetch(hubUrl, { proxy: '', signal: AbortSignal.timeout(1_000) })).ok ? true : undefined, 'Hub startup')
    const auth = await json<{ token: string }>('/api/auth', undefined, { accessToken: token })
    launch('Runner', 'cli', ['src/index.ts', 'runner', 'start-sync', '--workspace-root', state])
    const machine = await eventually(async () => (await json<{ machines: Array<{ id: string }> }>('/api/machines', auth.token)).machines[0], 'Runner registration')
    const created = await json<{ session: { id: string } }>('/cli/sessions', token, {
        tag: 'local-service-smoke', metadata: { machineId: machine.id, path: state, host: 'smoke', name: 'Port forwarding check' }
    })
    const sources: LocalServiceSource[] = [
        { type: 'session', sessionId: created.session.id },
        { type: 'native-codex', sessionId: nativeId, machineId: machine.id }
    ]
    for (const source of sources) {
        const request = { source, url: `http://localhost:${service.port}/settings?q=forwarding#section` }
        const opened = await json<OpenLocalServiceResponse>('/api/local-services/open', auth.token, request)
        const url = new URL(opened.url)
        if (pathMode) assert.equal(url.origin, hubUrl)
        const entryBase = pathMode ? url.pathname.replace('/__shapi_local/open', '') : ''
        const unauthenticated = await preview(url, entryBase + '/settings')
        assert.equal(unauthenticated.status, 401)
        const entered = await preview(url, entryBase + '/__shapi_local/auth', undefined, url.hash.slice(1))
        assert.equal(entered.status, 200)
        const path = (JSON.parse(entered.body) as { path: string }).path
        assert.ok(path.endsWith('/settings?q=forwarding#section'))
        if (!pathMode) assert.equal(path, '/settings?q=forwarding#section')
        const page = await preview(url, path.split('#')[0], entered.cookie)
        assert.equal(page.status, 200)
        assert.deepEqual(JSON.parse(page.body), { path: '/settings', query: '?q=forwarding', cookie: null })
        const reopened = await json<OpenLocalServiceResponse>('/api/local-services/open', auth.token, request)
        assert.equal(new URL(reopened.url).host, url.host)
        assert.equal((await preview(url, entryBase + '/__shapi_local/auth', undefined, url.hash.slice(1))).status, 403)
        const wsBase = pathMode ? path.split('/').slice(0, 4).join('/') : ''
        const wsOrigin = pathMode ? hubUrl : `http://127.0.0.1:${previewPort}`
        const ws = new WebSocket(`${wsOrigin.replace('http', 'ws')}${wsBase}/echo`, {
            headers: { host: url.host, origin: pathMode ? 'null' : url.origin, ...(entered.cookie ? { cookie: entered.cookie } : {}) }
        })
        try {
            const echoed = new Promise<void>((resolve, reject) => {
                ws.onopen = () => ws.send('local-service-smoke')
                ws.onerror = () => reject(new Error('Main Hub WebSocket proxy failed'))
                ws.onmessage = (event) => { try { assert.equal(event.data, 'local-service-smoke'); resolve() } catch (error) { reject(error) } }
            })
            await Promise.race([echoed, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket check timed out')), 5_000); timer.unref() })])
        } finally { ws.close() }
        console.log(`PASS ${pathMode ? 'path' : 'domain'} ${source.type}: authenticated HTTP → existing machine socket → service; ticket isolation; URL preservation; reuse; WebSocket`)
    }
    console.log('PASS complete. No agent was launched; production and existing sessions were untouched.')
} catch (error) {
    for (const child of children) console.error(`${child.name} diagnostic output:\n${child.log()}`)
    throw error
} finally {
    service.stop(true)
    for (const child of children.reverse()) {
        if (child.process.exitCode !== null) continue
        child.process.kill('SIGTERM')
        const forced = setTimeout(() => child.process.kill('SIGKILL'), 4_000)
        await child.process.exited
        clearTimeout(forced)
    }
    await rm(state, { recursive: true, force: true })
}
