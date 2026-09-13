import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { MonitorConfigSchema } from '@hapi/protocol/monitoring'
import { Store } from '../../store'
import { MonitoringService } from '../../monitoring/service'
import type { WebAppEnv } from '../middleware/auth'
import { createMonitorRoutes, createMonitorWebhookRoutes } from './monitors'
import type { SyncEngine } from '../../sync/syncEngine'

describe('monitor routes', () => {
    it('retrieves owner tokens without caching and deletes a rule with event history', async () => {
        const store = new Store(':memory:')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'a'); await next() })
        app.route('/', createMonitorRoutes(store, () => null, () => null))
        try {
            const config = MonitorConfigSchema.parse({ name: 'rule', kind: 'webhook', machineId: 'm', directory: '/work', prompt: 'Inspect' })
            const created = store.monitors.create('a', config)
            const response = await app.request(`/monitors/${created.id}/token`)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ token: created.token })
            expect(response.headers.get('cache-control')).toBe('no-store')
            for (const enabled of [false, true]) {
                const result = await app.request(`/monitors/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, enabled }) })
                expect(result.status).toBe(200)
                expect(store.monitors.get(created.id)?.config.enabled).toBe(enabled)
            }
            const renamed = await app.request(`/monitors/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, name: 'renamed rule' }) })
            expect(renamed.status).toBe(200)
            expect(store.monitors.get(created.id)?.config.name).toBe('renamed rule')
            store.monitors.acceptWebhook(store.monitors.get(created.id)!, { eventId: '1', summary: 'event', details: '' })
            expect((await app.request(`/monitors/${created.id}`, { method: 'DELETE' })).status).toBe(200)
            expect(store.monitors.detail(created.id, 'a')).toBeNull()
            expect(store.monitors.byToken(created.token!)).toBeNull()
            expect((await app.request(`/monitors/${created.id}/token`)).status).toBe(404)
        } finally { store.close() }
    })
    it('saves the notification switch while Runner is offline without changing the schedule', async () => {
        const store = new Store(':memory:')
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'a'); await next() })
        app.route('/', createMonitorRoutes(store, () => null, () => null))
        try {
            const config = MonitorConfigSchema.parse({ name: 'timer', kind: 'scheduled', machineId: 'm', directory: '/work', prompt: 'Inspect', schedule: { mode: 'daily', timeZone: 'UTC' } })
            const rule = store.monitors.create('a', config)
            const nextRun = store.monitors.get(rule.id)!.nextCheckAt
            for (const enabled of [false, true]) {
                const response = await app.request(`/monitors/${rule.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, notificationsEnabled: enabled }) })
                expect(response.status).toBe(200)
                expect(store.monitors.get(rule.id)?.config.notificationsEnabled).toBe(enabled)
                expect(store.monitors.get(rule.id)?.nextCheckAt).toBe(nextRun)
            }
        } finally { store.close() }
    })
    it('records blocked tests and allows a deferred event to be triggered after the current task closes', async () => {
        const store = new Store(':memory:')
        const service = new MonitoringService(store, () => null, { sendToNamespace: async () => undefined })
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'a'); await next() })
        app.route('/', createMonitorRoutes(store, () => null, () => service))
        try {
            const config = MonitorConfigSchema.parse({ name: 'hook', kind: 'webhook', machineId: 'm', directory: '/work', prompt: 'Inspect' })
            const { id } = store.monitors.create('a', config)
            expect(await (await app.request(`/monitors/${id}/check`, { method: 'POST' })).json()).toEqual({ accepted: true, deferred: false })
            expect(await (await app.request(`/monitors/${id}/check`, { method: 'POST' })).json()).toEqual({ accepted: true, deferred: true })
            const deferred = store.monitors.activities(id).find(activity => activity.outcome === 'deferred')!
            expect((await app.request(`/monitors/${id}/activities/${deferred.id}/retrigger`, { method: 'POST' })).status).toBe(409)
            const current = store.monitors.openForMonitor(id)!
            expect(service.close(store.monitors.get(id)!, current.id)).toBe(true)
            expect((await app.request(`/monitors/${id}/activities/${deferred.id}/retrigger`, { method: 'POST' })).status).toBe(202)
        } finally { await service.stop(); store.close() }
    })
    it('resolves bound environment server-side and prevents retargeting', async () => {
        const store = new Store(':memory:')
        store.machines.getOrCreateMachine('m', {}, {}, 'a')
        const source = { metadata: { path: '/real', machineId: 'm', flavor: 'codex' }, model: 'gpt-test', modelReasoningEffort: 'high', permissionMode: 'default' }
        const engine = { getSessionByNamespace: (id: string, ns: string) => id === 's' && ns === 'a' ? source : null, getOnlineMachinesByNamespace: () => [{ id: 'm' }], checkPathsExist: async () => ({ '/real': true }) } as unknown as SyncEngine
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'a'); await next() })
        app.route('/', createMonitorRoutes(store, () => engine, () => null))
        try {
            const result = await app.request('/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bound', kind: 'webhook', machineId: 'evil', directory: '/evil', model: 'evil', targetSession: { type: 'managed', sessionId: 's' } }) })
            expect(result.status).toBe(201)
            const data = await result.json() as { monitor: { id: string; config: Record<string, unknown> } }
            expect(data.monitor.config).toMatchObject({ machineId: 'm', directory: '/real', model: 'gpt-test', permissionMode: 'default' })
            const updated = await app.request(`/monitors/${data.monitor.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data.monitor.config, name: 'renamed bound', prompt: 'Use this preset every time' }) })
            expect(updated.status).toBe(200)
            expect(store.monitors.get(data.monitor.id)?.config).toMatchObject({ name: 'renamed bound', prompt: 'Use this preset every time' })
            const changed = await app.request(`/monitors/${data.monitor.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data.monitor.config, targetSession: { type: 'managed', sessionId: 'other' } }) })
            expect(changed.status).toBe(400)
            expect((await app.request('/monitors/session-target?type=managed&sessionId=other')).status).toBe(404)
        } finally { store.close() }
    })
    it('rejects invalid/expired tokens uniformly, bounds bodies and keeps routing server-owned', async () => {
        const store = new Store(':memory:')
        const service = new MonitoringService(store, () => null, { sendToNamespace: async () => undefined })
        const app = createMonitorWebhookRoutes(() => service, store)
        try {
            const config = MonitorConfigSchema.parse({ name: 'test', kind: 'webhook', machineId: 'm', directory: '/work', prompt: 'Inspect' })
            const created = store.monitors.create('a', config)
            const path = `/events?token=${created.token}`
            const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'bad', data: { status: 500, region: 'cn' } }) }
            expect((await app.request(path)).status).toBe(405)
            expect((await app.request(path, { ...post, body: JSON.stringify({ prompt: 'bad', machineId: 'other' }) })).status).toBe(400)
            expect((await app.request(path, { ...post, body: '{' })).status).toBe(400)
            expect((await app.request(path, { ...post, headers: { 'content-type': 'text/plain' } })).status).toBe(400)
            expect((await app.request(path, { ...post, body: JSON.stringify({ prompt: 'x'.repeat(33000) }) })).status).toBe(400)
            expect((await app.request(path, { method: 'HEAD' })).status).toBe(405)
            expect((await app.request(path, { ...post, headers: { ...post.headers, 'sec-purpose': 'prefetch' } })).status).toBe(400)
            expect(store.monitors.openForMonitor(created.id)).toBeNull()
            expect((await app.request('/events', post)).status).toBe(503)
            expect((await app.request(path + '&machineId=attacker', post)).status).toBe(400)
            expect((await app.request(path + '&token=another', post)).status).toBe(400)
            const result = await app.request(path, post)
            expect(result.status).toBe(202)
            expect(await result.json()).toEqual({ accepted: true, duplicate: false })
            expect(store.monitors.openForMonitor(created.id)?.details).toBe('{"prompt":"bad","data":{"status":500,"region":"cn"}}')
            expect(result.headers.get('cache-control')).toBe('no-store')
            const duplicate = await app.request(path, post)
            expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true })
            expect((await app.request(path, { ...post, body: JSON.stringify({ prompt: 'x'.repeat(8001) }) })).status).toBe(400)
            store.monitors.update(created.id, 'a', { ...config, expiresAt: 1 })
            expect((await app.request(path, post)).status).toBe(503)
        } finally { await service.stop(); store.close() }
    })
    it('cannot read, rotate, approve or close another namespace monitor', async () => {
        const store = new Store(':memory:')
        try {
            const { id } = store.monitors.create('private', MonitorConfigSchema.parse({ name: 'secret', kind: 'webhook', machineId: 'm', directory: '/secret', prompt: 'Inspect' }))
            const app = new Hono<WebAppEnv>()
            app.use('*', async (c, next) => { c.set('namespace', 'other'); await next() })
            app.route('/', createMonitorRoutes(store, () => null, () => null))
            expect(await (await app.request('/monitors')).json()).toEqual({ monitors: [] })
            for (const [path, method] of [[`/monitors/${id}`, 'GET'], [`/monitors/${id}/token`, 'POST'], [`/monitors/${id}/token`, 'GET'], [`/monitors/${id}`, 'DELETE'], [`/monitors/${id}/incidents/x/approve`, 'POST'], [`/monitors/${id}/incidents/x/close`, 'POST']]) {
                expect((await app.request(path, { method })).status).toBe(404)
            }
        } finally { store.close() }
    })
})
