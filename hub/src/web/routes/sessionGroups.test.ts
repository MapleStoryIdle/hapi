import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { SessionGroup, SessionGroupsResponse } from '@hapi/protocol/sessionGroups'
import { Store } from '../../store'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { SyncEvent } from '@hapi/protocol'
import type { WebAppEnv } from '../middleware/auth'
import { createSessionGroupRoutes } from './sessionGroups'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'alice'); await next() })
    const sse = new SSEManager(0, new VisibilityTracker())
    app.route('/api', createSessionGroupRoutes(store, () => sse))
    const request = (path: string, method = 'GET', body?: unknown, namespace = 'alice') => app.request(`/api/session-groups${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-test-namespace': namespace },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return { store, request, sse }
}

describe('session groups', () => {
    it('broadcasts only to the owning namespace without touching session recency', async () => {
        const { store, request, sse } = setup()
        const received: { namespace: string; event: SyncEvent }[] = []
        for (const namespace of ['alice', 'bob']) {
            sse.subscribe({ id: namespace, namespace, sessionId: 'viewed', send: event => { received.push({ namespace, event }) }, sendHeartbeat: () => {} })
        }
        const session = store.sessions.getOrCreateSession('managed', {}, null, 'alice')
        const response = await request('', 'POST', { name: 'Work', emoji: '📁' })
        const { group } = await response.json() as { group: SessionGroup }
        await request(`/${group.id}`, 'PATCH', { name: 'Renamed' })
        await request('/assignment', 'PUT', { source: { type: 'managed', sessionId: session.id }, groupId: group.id })
        await request(`/${group.id}`, 'PATCH', { name: 'Not allowed' }, 'bob')
        expect(received).toEqual(Array.from({ length: 3 }, () => ({ namespace: 'alice', event: { type: 'session-groups-updated', namespace: 'alice' } })))
        expect(store.sessions.getSessionByNamespace(session.id, 'alice')?.updatedAt).toBe(session.updatedAt)
        sse.stop()
    })

    it('creates and edits bounded groups without color configuration', async () => {
        const { request } = setup()
        const response = await request('', 'POST', { name: ' Work ', emoji: '📁' })
        expect(response.status).toBe(201)
        const { group } = await response.json() as { group: SessionGroup }
        expect(group.name).toBe('Work')
        expect((await request(`/${group.id}`, 'PATCH', { emoji: '🏠' })).status).toBe(200)
        for (const input of [{ name: '', emoji: '📁' }, { name: 'a'.repeat(81), emoji: '📁' }, { name: 'x', emoji: 'x'.repeat(33) }, { name: 'x', emoji: '📁', color: 'red' }]) {
            expect((await request('', 'POST', input)).status).toBe(400)
        }
        expect((await request(`/${group.id}`, 'PATCH', {})).status).toBe(400)
        expect((await request(`/${group.id}`, 'PATCH', { name: 'stolen' }, 'bob')).status).toBe(404)
        expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual({ groups: [], assignments: [] })
    })

    it('assigns at most one group per source and isolates native machines and namespaces', async () => {
        const { store, request } = setup()
        const a = store.sessionGroups.create('alice', { name: 'A', emoji: '📁' })
        const b = store.sessionGroups.create('alice', { name: 'B', emoji: '🏠' })
        const foreign = store.sessionGroups.create('bob', { name: 'Private', emoji: '🔒' })
        const session = store.sessions.getOrCreateSession('managed', {}, null, 'alice')
        store.machines.getOrCreateMachine('m1', {}, null, 'alice')
        store.machines.getOrCreateMachine('m2', {}, null, 'alice')
        store.machines.getOrCreateMachine('foreign', {}, null, 'bob')
        const managed = { type: 'managed', sessionId: session.id }
        const native = { type: 'native-codex', machineId: 'm1', codexSessionId: 'same-id' }
        for (const source of [managed, native, { ...native, machineId: 'm2' }]) {
            expect((await request('/assignment', 'PUT', { source, groupId: a.id })).status).toBe(200)
        }
        expect((await request('/assignment', 'PUT', { source: native, groupId: b.id })).status).toBe(200)
        const list = await (await request('')).json() as SessionGroupsResponse
        expect(list.assignments).toHaveLength(3)
        expect(list.assignments.find(value => value.source.type === 'native-codex' && value.source.machineId === 'm1')?.groupId).toBe(b.id)
        for (const source of [managed, native]) {
            expect((await request('/assignment', 'PUT', { source, groupId: foreign.id })).status).toBe(404)
            expect((await request('/assignment', 'PUT', { source, groupId: foreign.id }, 'bob')).status).toBe(404)
        }
        expect((await request('/assignment', 'PUT', { source: { ...native, machineId: 'foreign' }, groupId: a.id })).status).toBe(404)
        expect((await request('/assignment', 'PUT', { source: native, groupId: null })).status).toBe(200)
        expect(store.sessionGroups.list('alice').assignments).toHaveLength(2)
        expect((await request('/assignment', 'PUT', { source: { type: 'managed', sessionId: 'missing' }, groupId: a.id })).status).toBe(404)
    })

    it('migrates v22 databases and preserves groups across restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-session-groups-'))
        const path = join(dir, 'test.db')
        let store = new Store(path)
        try {
            const session = store.sessions.getOrCreateSession('existing', { name: 'Unchanged' }, null, 'alice')
            store.close()
            const db = new Database(path)
            db.exec('DROP TABLE session_group_assignments; DROP TABLE session_groups; PRAGMA user_version=22;')
            db.close()
            store = new Store(path)
            const group = store.sessionGroups.create('alice', { name: 'Saved', emoji: '💾' })
            expect(store.sessionGroups.assign('alice', { type: 'managed', sessionId: session.id }, group.id)).toBe('ok')
            store.close()
            store = new Store(path)
            expect(store.sessionGroups.list('alice')).toEqual({ groups: [group], assignments: [{ source: { type: 'managed', sessionId: session.id }, groupId: group.id }] })
            expect(store.sessions.getSessionByNamespace(session.id, 'alice')?.metadata).toEqual({ name: 'Unchanged' })
        } finally {
            store.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
