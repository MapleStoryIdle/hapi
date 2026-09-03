import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConfiguration } from '../configuration'
import type { PushService } from '../push/pushService'
import { Store } from '../store'
import type { EmbeddedWebAsset } from './embeddedAssets'
import { createWebApp } from './server'

type StaticMode = 'embedded' | 'filesystem'

const TEST_JWT_SECRET = new TextEncoder().encode('test-secret')
let distDir: string
let store: Store
let embeddedAssetMap: Map<string, EmbeddedWebAsset>

beforeAll(async () => {
    await createConfiguration()

    distDir = mkdtempSync(join(tmpdir(), 'hapi-web-static-'))
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    mkdirSync(join(distDir, 'fonts'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html>SHAPI index</html>')
    writeFileSync(join(distDir, 'assets', 'app-abc123.js'), 'asset-content')
    writeFileSync(join(distDir, 'fonts', 'test.otf'), 'font-content')
    writeFileSync(join(distDir, 'sw.js'), 'service-worker-content')

    embeddedAssetMap = new Map([
        ['/index.html', {
            path: '/index.html',
            sourcePath: join(distDir, 'index.html'),
            mimeType: 'text/html; charset=utf-8'
        }],
        ['/assets/app-abc123.js', {
            path: '/assets/app-abc123.js',
            sourcePath: join(distDir, 'assets', 'app-abc123.js'),
            mimeType: 'text/javascript; charset=utf-8'
        }],
        ['/fonts/test.otf', {
            path: '/fonts/test.otf',
            sourcePath: join(distDir, 'fonts', 'test.otf'),
            mimeType: 'font/otf'
        }],
        ['/sw.js', {
            path: '/sw.js',
            sourcePath: join(distDir, 'sw.js'),
            mimeType: 'text/javascript; charset=utf-8'
        }]
    ])
    store = new Store(':memory:')
})

afterAll(() => {
    store.close()
    rmSync(distDir, { recursive: true, force: true })
})

function createStaticApp(mode: StaticMode) {
    return createWebApp({
        getSyncEngine: () => null,
        getSseManager: () => null,
        getVisibilityTracker: () => null,
        jwtSecret: TEST_JWT_SECRET,
        store,
        vapidPublicKey: 'test-vapid-public-key',
        pushService: {} as PushService,
        corsOrigins: ['*'],
        embeddedAssetMap: mode === 'embedded' ? embeddedAssetMap : null,
        webappDistDir: mode === 'filesystem' ? distDir : undefined
    })
}

for (const mode of ['embedded', 'filesystem'] as const) {
    describe(`${mode} static delivery`, () => {
        test('serves an existing hashed asset with immutable caching', async () => {
            const response = await createStaticApp(mode).request('/assets/app-abc123.js')

            expect(response.status).toBe(200)
            expect(await response.text()).toBe('asset-content')
            expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
        })

        test('returns 404 for a missing asset instead of the SPA index', async () => {
            const response = await createStaticApp(mode).request('/assets/old-hash.js')

            expect(response.status).toBe(404)
            expect(await response.text()).not.toContain('SHAPI index')
        })

        test('keeps SPA routes on the no-cache index document', async () => {
            const response = await createStaticApp(mode).request('/sessions/example')

            expect(response.status).toBe(200)
            expect(await response.text()).toContain('SHAPI index')
            expect(response.headers.get('Cache-Control')).toBe('no-cache')
        })

        test('does not cache the service worker or index document', async () => {
            const serviceWorker = await createStaticApp(mode).request('/sw.js')
            const index = await createStaticApp(mode).request('/index.html')
            const root = await createStaticApp(mode).request('/')

            expect(serviceWorker.status).toBe(200)
            expect(serviceWorker.headers.get('Cache-Control')).toBe('no-cache')
            expect(index.status).toBe(200)
            expect(index.headers.get('Cache-Control')).toBe('no-cache')
            expect(root.status).toBe(200)
            expect(root.headers.get('Cache-Control')).toBe('no-cache')
        })

        test('caches fonts for thirty days', async () => {
            const response = await createStaticApp(mode).request('/fonts/test.otf')

            expect(response.status).toBe(200)
            expect(response.headers.get('Cache-Control')).toBe('public, max-age=2592000')
        })
    })
}
