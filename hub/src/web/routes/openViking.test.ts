import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createOpenVikingRoutes } from './openViking'

function createMachine(overrides?: Partial<Machine>): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: '1.0.0'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        ...overrides
    }
}

function createApp(engine: Partial<SyncEngine>) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createOpenVikingRoutes(() => engine as SyncEngine))
    return app
}

describe('OpenViking routes', () => {
    it('returns a machine-scoped status result', async () => {
        const machine = createMachine()
        const calls: string[] = []
        const app = createApp({
            getMachine: () => machine,
            getOpenVikingStatus: async (machineId: string) => {
                calls.push(machineId)
                return { ok: true, version: '0.4.14', authMode: 'dev' }
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/status')

        expect(response.status).toBe(200)
        expect(calls).toEqual(['machine-1'])
        expect(await response.json()).toEqual({ ok: true, version: '0.4.14', authMode: 'dev' })
    })

    it('keeps the Studio under the authenticated proxy prefix', async () => {
        const machine = createMachine()
        const requests: Array<{ machineId: string; path: string }> = []
        const app = createApp({
            getMachine: () => machine,
            proxyOpenVikingRequest: async (machineId: string, request: { path: string }) => {
                requests.push({ machineId, path: request.path })
                return {
                    ok: true,
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                    bodyBase64: Buffer.from('<html><head><script src="/studio/assets/app.js"></script></head></html>').toString('base64')
                }
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/studio/?hapiOpenVikingToken=jwt-token')
        const body = await response.text()

        expect(response.status).toBe(200)
        expect(requests).toEqual([{ machineId: 'machine-1', path: '/studio/' }])
        expect(body).toContain('/api/openviking/machines/machine-1/studio/assets/app.js?hapiOpenVikingToken=jwt-token')
        expect(body).toContain('OpenViking service worker is disabled inside HAPI')
    })

    it('rewrites Studio JavaScript paths and module chunks through the authenticated proxy', async () => {
        const machine = createMachine()
        const app = createApp({
            getMachine: () => machine,
            proxyOpenVikingRequest: async () => ({
                ok: true,
                status: 200,
                headers: { 'content-type': 'application/javascript' },
                bodyBase64: Buffer.from([
                    'const studioBase = "/studio/"',
                    'const page = () => import("./page.js")',
                    'import { helper } from "./helper.js"'
                ].join('\n')).toString('base64')
            })
        })

        const response = await app.request('/api/openviking/machines/machine-1/studio/assets/app.js?hapiOpenVikingToken=jwt-token')

        expect(await response.text()).toBe([
            'const studioBase = "/api/openviking/machines/machine-1/studio/"',
            'const page = () => import("/api/openviking/machines/machine-1/studio/assets/page.js?hapiOpenVikingToken=jwt-token")',
            'import { helper } from "/api/openviking/machines/machine-1/studio/assets/helper.js?hapiOpenVikingToken=jwt-token"'
        ].join('\n'))
    })

    it('does not proxy a machine from another namespace', async () => {
        const app = createApp({
            getMachine: () => createMachine({ namespace: 'other' }),
            proxyOpenVikingRequest: async () => {
                throw new Error('should not run')
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/studio/')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Machine access denied' })
    })
})
