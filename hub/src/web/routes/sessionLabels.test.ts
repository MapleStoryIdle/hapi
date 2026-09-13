import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SessionLabelsResponse } from '@hapi/protocol/sessionLabels'
import type { SyncEvent } from '@hapi/protocol'
import { Store } from '../../store'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionLabelRoutes } from './sessionLabels'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'alice'); await next() })
    const sse = new SSEManager(0, new VisibilityTracker())
    app.route('/api', createSessionLabelRoutes(store, () => sse))
    const request = (method = 'GET', body?: unknown, namespace = 'alice') => app.request('/api/session-labels', {
        method,
        headers: { 'content-type': 'application/json', 'x-test-namespace': namespace },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { store, request, sse }
}

describe('session labels', () => {
    it('stores one label per owned session, isolates namespaces and broadcasts changes', async () => {
        const { store, request, sse } = setup()
        const events: SyncEvent[] = []
        sse.subscribe({ id: 'alice', namespace: 'alice', sessionId: 'viewed', send: event => { events.push(event) }, sendHeartbeat: () => {} })
        const managed = store.sessions.getOrCreateSession('managed', {}, null, 'alice')
        store.machines.getOrCreateMachine('machine', {}, null, 'alice')
        const managedSource = { type: 'managed' as const, sessionId: managed.id }
        const nativeSource = { type: 'native-codex' as const, machineId: 'machine', codexSessionId: 'native' }

        expect((await request('PUT', { source: managedSource, label: '前端' })).status).toBe(200)
        expect((await request('PUT', { source: nativeSource, label: 'Review' })).status).toBe(200)
        expect((await request('PUT', { source: managedSource, label: 'Changed' })).status).toBe(200)
        expect((await request('PUT', { source: managedSource, label: null })).status).toBe(200)
        expect((await request('PUT', { source: nativeSource, label: 'Nope' }, 'bob')).status).toBe(404)

        expect(await (await request()).json() as SessionLabelsResponse).toEqual({ labels: [{ source: nativeSource, label: 'Review' }] })
        expect(await (await request('GET', undefined, 'bob')).json()).toEqual({ labels: [] })
        expect(events).toEqual(Array.from({ length: 4 }, () => ({ type: 'session-labels-updated', namespace: 'alice' })))
        sse.stop()
    })

    it('enforces the compact label limit and migrates a v26 database', async () => {
        const { store, request } = setup()
        const session = store.sessions.getOrCreateSession('managed', {}, null, 'alice')
        const source = { type: 'managed', sessionId: session.id }
        expect((await request('PUT', { source, label: '一二三四五六七八' })).status).toBe(200)
        expect((await request('PUT', { source, label: '一二三四五六七八九' })).status).toBe(400)
        expect((await request('PUT', { source, label: 'abcdefghijklmnop' })).status).toBe(200)
        expect((await request('PUT', { source, label: 'abcdefghijklmnopq' })).status).toBe(400)

        const dir = mkdtempSync(join(tmpdir(), 'hapi-session-labels-'))
        const path = join(dir, 'test.db')
        let persisted = new Store(path)
        try {
            const saved = persisted.sessions.getOrCreateSession('saved', {}, null, 'alice')
            persisted.close()
            const db = new Database(path)
            db.exec('DROP TABLE session_labels; PRAGMA user_version=26;')
            db.close()
            persisted = new Store(path)
            expect(persisted.sessionLabels.set('alice', { type: 'managed', sessionId: saved.id }, 'Ready')).toBe('ok')
            expect(persisted.sessionLabels.list('alice').labels[0]?.label).toBe('Ready')
        } finally {
            persisted.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
