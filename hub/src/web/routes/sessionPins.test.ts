import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SessionPinsResponse } from '@hapi/protocol/sessionPins'
import { Store } from '../../store'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { SyncEvent } from '@hapi/protocol'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionPinRoutes } from './sessionPins'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'alice'); await next() })
    const sse = new SSEManager(0, new VisibilityTracker())
    app.route('/api', createSessionPinRoutes(store, () => sse))
    const request = (path = '', method = 'GET', body?: unknown, namespace = 'alice') => app.request(`/api/session-pins${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-test-namespace': namespace },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { store, request, sse }
}

describe('session pins', () => {
    it('isolates namespaces and native machines and broadcasts without changing session recency', async () => {
        const { store, request, sse } = setup()
        const received: { namespace: string; event: SyncEvent }[] = []
        for (const namespace of ['alice', 'bob']) {
            sse.subscribe({ id: namespace, namespace, sessionId: 'viewed', send: event => { received.push({ namespace, event }) }, sendHeartbeat: () => {} })
        }
        const session = store.sessions.getOrCreateSession('managed', {}, null, 'alice')
        for (const machine of ['m1', 'm2']) store.machines.getOrCreateMachine(machine, {}, null, 'alice')
        const sources = [
            { type: 'managed', sessionId: session.id },
            { type: 'native-codex', machineId: 'm1', codexSessionId: 'same' },
            { type: 'native-codex', machineId: 'm2', codexSessionId: 'same' }
        ]
        for (const source of sources) {
            expect((await request('', 'PUT', { source, pinned: true })).status).toBe(200)
            expect((await request('', 'PUT', { source, pinned: false }, 'bob')).status).toBe(404)
        }
        expect((await request('', 'PUT', { source: sources[1], pinned: false })).status).toBe(200)
        const response = await (await request()).json() as SessionPinsResponse
        expect(response.pins.filter(pin => pin.pinned)).toHaveLength(2)
        expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual({ pins: [] })
        expect(received).toEqual(Array.from({ length: 4 }, () => ({ namespace: 'alice', event: { type: 'session-pins-updated', namespace: 'alice' } })))
        expect(store.sessions.getSessionByNamespace(session.id, 'alice')?.updatedAt).toBe(session.updatedAt)
        sse.stop()
    })

    it('canonicalizes managed Codex identity and never lets stale migration override remote unpins', async () => {
        const { store, request } = setup()
        store.machines.getOrCreateMachine('m1', {}, null, 'alice')
        const session = store.sessions.getOrCreateSession('managed', { flavor: 'codex', machineId: 'm1', agentSessionId: 'native' }, null, 'alice')
        const managed = { type: 'managed', sessionId: session.id }
        const native = { type: 'native-codex' as const, machineId: 'm1', codexSessionId: 'native' }
        expect((await request('/migrate', 'POST', { sources: [managed] })).status).toBe(200)
        expect(store.sessionPins.list('alice')).toEqual({ pins: [{ source: native, pinned: true }] })
        await request('', 'PUT', { source: native, pinned: false })
        await request('/migrate', 'POST', { sources: [managed, native] })
        expect(store.sessionPins.list('alice')).toEqual({ pins: [{ source: native, pinned: false }] })
        await request('/migrate', 'POST', { sources: [managed, native] }, 'bob')
        expect(store.sessionPins.list('bob')).toEqual({ pins: [] })
    })

    it('rejects malformed pins and migrates v23 databases durably', async () => {
        const { request } = setup()
        for (const input of [{ source: {}, pinned: true }, { source: { type: 'managed', sessionId: '' }, pinned: true }, { source: { type: 'managed', sessionId: 'a' }, pinned: 'yes' }]) {
            expect((await request('', 'PUT', input)).status).toBe(400)
        }
        expect((await request('/migrate', 'POST', { sources: Array.from({ length: 501 }, () => ({ type: 'managed', sessionId: 'a' })) })).status).toBe(400)
        const dir = mkdtempSync(join(tmpdir(), 'hapi-session-pins-'))
        const path = join(dir, 'test.db')
        let store = new Store(path)
        try {
            const session = store.sessions.getOrCreateSession('saved', {}, null, 'alice')
            store.close()
            const db = new Database(path)
            db.exec('DROP TABLE session_pins; PRAGMA user_version=23;')
            db.close()
            store = new Store(path)
            store.sessionPins.set('alice', { type: 'managed', sessionId: session.id }, false)
            store.close()
            store = new Store(path)
            store.sessionPins.migrate('alice', [{ type: 'managed', sessionId: session.id }])
            expect(store.sessionPins.list('alice')).toEqual({ pins: [{ source: { type: 'managed', sessionId: session.id }, pinned: false }] })
        } finally {
            store.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('carries pins and unpin tombstones when a managed session gains a native identity later', () => {
        const { store } = setup()
        store.machines.getOrCreateMachine('m1', {}, null, 'alice')
        const session = store.sessions.getOrCreateSession('new', { flavor: 'codex', machineId: 'm1' }, null, 'alice')
        const managed = { type: 'managed' as const, sessionId: session.id }
        const native = { type: 'native-codex' as const, machineId: 'm1', codexSessionId: 'attached' }
        store.sessionPins.set('alice', managed, false)
        store.sessions.updateSessionMetadata(session.id, { flavor: 'codex', machineId: 'm1', agentSessionId: 'attached' }, session.metadataVersion, 'alice')
        store.sessionPins.migrate('alice', [native, managed])
        expect(store.sessionPins.list('alice')).toEqual({ pins: [{ source: native, pinned: false }] })
        store.sessionPins.set('alice', managed, true)
        expect(store.sessionPins.list('alice')).toEqual({ pins: [{ source: native, pinned: true }] })
    })
})
