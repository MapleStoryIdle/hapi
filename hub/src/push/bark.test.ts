import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../store'
import type { WebAppEnv } from '../web/middleware/auth'
import { createPushRoutes } from '../web/routes/push'
import { parseBarkKey, sendBark } from './bark'

afterEach(() => mock.restore())
describe('Bark settings and delivery', () => {
    it('tests only the saved namespace key and safely handles missing configuration and failures', async () => {
        const store = new Store(':memory:')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'a'); await next() })
        app.route('/', createPushRoutes(store, 'public'))
        const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":200}'))
        try {
            expect((await app.request('/push/bark/test', { method: 'POST' })).status).toBe(409)
            expect(fetcher).not.toHaveBeenCalled()
            store.push.setBarkKey('a', 'TEST_DEVICE_KEY')
            expect((await app.request('/push/bark/test', { method: 'POST', headers: { 'x-test-namespace': 'b' } })).status).toBe(409)
            const response = await app.request('/push/bark/test', { method: 'POST' })
            expect(await response.json()).toEqual({ ok: true })
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).device_key).toBe('TEST_DEVICE_KEY')
            fetcher.mockRejectedValue(new Error('SECRET_KEY_INVALID'))
            const failed = await app.request('/push/bark/test', { method: 'POST' })
            expect(failed.status).toBe(502)
            expect(await failed.text()).not.toContain('SECRET')
            expect(store.push.getBarkKey('a')).toBe('TEST_DEVICE_KEY')
            await app.request('/push/bark', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' })
            expect(store.push.isBarkEnabled('a')).toBe(false)
            expect(store.push.getBarkKey('a')).toBe('TEST_DEVICE_KEY')
            await app.request('/push/bark', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' })
            expect(store.push.isBarkEnabled('a')).toBe(true)
            expect(store.push.getBarkKey('a')).toBe('TEST_DEVICE_KEY')
        } finally { store.close() }
    })
    it('accepts a pasted sample URL but rejects arbitrary hosts and credential tricks', () => {
        expect(parseBarkKey('https://api.day.app/TEST_DEVICE_KEY/title/body')).toBe('TEST_DEVICE_KEY')
        for (const url of ['http://api.day.app/TEST_DEVICE_KEY', 'https://127.0.0.1/TEST_DEVICE_KEY', 'https://api.day.app.evil.test/TEST_DEVICE_KEY', 'https://user@api.day.app/TEST_DEVICE_KEY']) expect(() => parseBarkKey(url)).toThrow()
    })
    it('stores credentials by namespace and never returns the key', async () => {
        const store = new Store(':memory:')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'a'); await next() })
        app.route('/', createPushRoutes(store, 'public'))
        try {
            expect(await (await app.request('/push/bark')).json()).toEqual({ configured: false, enabled: false })
            const response = await app.request('/push/bark', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://api.day.app/TEST_DEVICE_KEY/title/body' }) })
            expect(await response.text()).not.toContain('TEST_DEVICE_KEY')
            expect(store.push.getBarkKey('a')).toBe('TEST_DEVICE_KEY')
            expect(await (await app.request('/push/bark', { headers: { 'x-test-namespace': 'b' } })).json()).toEqual({ configured: false, enabled: false })
            await app.request('/push/bark', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"url":""}' })
            expect(store.push.getBarkKey('a')).toBeNull()
        } finally { store.close() }
    })
    it('posts key in JSON, uses fixed host, disables redirects and adds a deep link', async () => {
        const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":200}'))
        await sendBark('TEST_DEVICE_KEY', { title: 'Monitor', body: 'Ready', data: { type: 'monitor', url: '/monitors/id' } }, 'https://shapi.example')
        const [url, init] = fetcher.mock.calls[0]!
        expect(url).toBe('https://api.day.app/push')
        expect(init?.redirect).toBe('error')
        expect(JSON.parse(String(init?.body))).toMatchObject({ device_key: 'TEST_DEVICE_KEY', url: 'https://shapi.example/monitors/id' })
    })
    it('rejects application errors even when HTTP succeeds, without exposing their body', async () => {
        spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"code":400,"message":"SECRET_KEY_INVALID"}'))
        await expect(sendBark('TEST_DEVICE_KEY', { title: 'Monitor', body: 'Ready' })).rejects.toThrow('Bark delivery failed')
    })
})
