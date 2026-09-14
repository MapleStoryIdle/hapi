import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createOpenVikingRoutes } from './openViking'
import { Store } from '../../store'

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

function createApp(engine: Partial<SyncEngine>, store?: Store) {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createOpenVikingRoutes(() => engine as SyncEngine, store))
    return app
}

describe('OpenViking context routes', () => {
    it('returns a machine-scoped status result', async () => {
        const machine = createMachine()
        const calls: string[] = []
        const app = createApp({
            getMachine: () => machine,
            getOpenVikingStatus: async (machineId: string) => {
                calls.push(machineId)
                return { ok: true, version: '0.4.14', authMode: 'trusted' }
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/status')

        expect(response.status).toBe(200)
        expect(calls).toEqual(['machine-1'])
        expect(await response.json()).toEqual({ ok: true, version: '0.4.14', authMode: 'trusted' })
    })

    it('persists the plugin switch per namespace and blocks disabled plugin calls', async () => {
        const store = new Store(':memory:')
        let statusCalls = 0
        const app = createApp({
            getMachine: () => createMachine(),
            getOpenVikingStatus: async () => {
                statusCalls += 1
                return { ok: true }
            }
        }, store)

        expect(await (await app.request('/api/plugins/openviking')).json()).toEqual({ enabled: true })
        const update = await app.request('/api/plugins/openviking', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false })
        })
        expect(await update.json()).toEqual({ enabled: false })

        const blocked = await app.request('/api/openviking/machines/machine-1/status')
        expect(blocked.status).toBe(409)
        expect(statusCalls).toBe(0)
        expect(await blocked.json()).toEqual({ error: 'OpenViking plugin is disabled' })
        store.close()
    })

    it('lists the full OpenViking root when no URI is given', async () => {
        const requests: Array<{ machineId: string; uri: string }> = []
        const app = createApp({
            getMachine: () => createMachine(),
            listOpenVikingContext: async (machineId: string, request: { uri: string }) => {
                requests.push({ machineId, uri: request.uri })
                return {
                    ok: true,
                    entries: [{ name: 'user', uri: 'viking://user/', isDir: true }]
                }
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/context')

        expect(response.status).toBe(200)
        expect(requests).toEqual([{ machineId: 'machine-1', uri: 'viking://' }])
        expect(await response.json()).toEqual({
            ok: true,
            entries: [{ name: 'user', uri: 'viking://user/', isDir: true }]
        })
    })

    it('reads arbitrary Viking URIs without narrowing them to a memory prefix', async () => {
        const requests: Array<{ machineId: string; uri: string }> = []
        const app = createApp({
            getMachine: () => createMachine(),
            readOpenVikingContext: async (machineId: string, request: { uri: string }) => {
                requests.push({ machineId, uri: request.uri })
                return { ok: true, content: '# shared skill' }
            }
        })

        const uri = 'viking://agent/skills/search-web/SKILL.md'
        const response = await app.request(
            `/api/openviking/machines/machine-1/context/read?uri=${encodeURIComponent(uri)}`
        )

        expect(response.status).toBe(200)
        expect(requests).toEqual([{ machineId: 'machine-1', uri }])
        expect(await response.json()).toEqual({ ok: true, content: '# shared skill' })
    })

    it('rejects non-Viking context URIs before RPC', async () => {
        const app = createApp({
            getMachine: () => createMachine(),
            listOpenVikingContext: async () => {
                throw new Error('should not run')
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/context?uri=https%3A%2F%2Fexample.com')

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'Invalid OpenViking context URI' })
    })

    it('does not expose the OpenViking Studio proxy', async () => {
        const app = createApp({ getMachine: () => createMachine() })

        const response = await app.request('/api/openviking/machines/machine-1/studio/')

        expect(response.status).toBe(404)
    })

    it('does not expose a machine from another namespace', async () => {
        const app = createApp({
            getMachine: () => createMachine({ namespace: 'other' }),
            listOpenVikingContext: async () => {
                throw new Error('should not run')
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/context')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Machine access denied' })
    })

    it('runs a validated machine-scoped retrieval test', async () => {
        const calls: unknown[] = []
        const app = createApp({
            getMachine: () => createMachine(),
            searchOpenViking: async (machineId: string, request: unknown) => {
                calls.push({ machineId, request })
                return { ok: true, total: 0, hits: [], durationMs: 8 }
            }
        })

        const response = await app.request('/api/openviking/machines/machine-1/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'deployment preference', limit: 5 })
        })

        expect(response.status).toBe(200)
        expect(calls).toEqual([{ machineId: 'machine-1', request: { query: 'deployment preference', limit: 5 } }])
    })

    it('rejects an empty retrieval test before RPC', async () => {
        const app = createApp({ getMachine: () => createMachine() })
        const response = await app.request('/api/openviking/machines/machine-1/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '' })
        })
        expect(response.status).toBe(400)
    })
})
