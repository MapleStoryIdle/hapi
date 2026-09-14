import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Store } from '../../store'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createKanbanOrderRoutes } from './kanbanOrder'

const stores: Store[] = []
const managers: SSEManager[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const sse of managers.splice(0)) sse.stop() })
function setup() {
    const store = new Store(':memory:'); stores.push(store)
    const sse = new SSEManager(0, new VisibilityTracker()); managers.push(sse)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-namespace') ?? 'alice'); await next() })
    app.route('/api', createKanbanOrderRoutes(store, () => sse))
    const request = (body?: unknown, namespace = 'alice') => app.request('/api/kanban-order', { method: body ? 'PUT' : 'GET', headers: { 'content-type': 'application/json', 'x-namespace': namespace }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { store, sse, request }
}
describe('Kanban order API', () => {
    it('isolates namespaces, synchronizes all device subscriptions, and rejects stale edits', async () => {
        const { store, sse, request } = setup()
        const events: string[] = []
        for (const namespace of ['alice', 'bob']) sse.subscribe({ id: namespace, namespace, sessionId: 'viewing', send: event => { if (event.type === 'kanban-order-updated') events.push(namespace) }, sendHeartbeat: () => {} })
        expect((await request({ revision: 0, order: ['recent', 'pinned', 'pending'] })).status).toBe(200)
        expect(store.kanbanOrder.get('alice').order).toEqual(['recent', 'pinned', 'pending'])
        expect(store.kanbanOrder.get('bob').order).toEqual(['pending', 'pinned', 'recent'])
        expect(events).toEqual(['alice'])
        expect((await request({ revision: 0, order: ['pending', 'recent'] })).status).toBe(409)
        expect((await request({ revision: 1, order: [], reset: true })).status).toBe(200)
        expect(store.kanbanOrder.get('alice').order).toEqual(['pending', 'pinned', 'recent'])
    })
    it('retains empty groups, filters unknown IDs, and handles every group disappearing', async () => {
        const { store, request } = setup()
        const empty = store.sessionGroups.create('alice', { name: 'Empty', emoji: '🧩' })
        const occupied = store.sessionGroups.create('alice', { name: 'Work', emoji: '🔧' })
        const initial = store.kanbanOrder.get('alice')
        await request({ revision: initial.revision, order: ['recent', 'pending', 'pinned', `custom:${occupied.id}`, 'custom:deleted'] })
        const state = store.kanbanOrder.get('alice')
        expect(state.order.indexOf(`custom:${empty.id}`)).toBe(initial.order.indexOf(`custom:${empty.id}`))
        expect(state.order).not.toContain('custom:deleted')
        store.sessionGroups.update('alice', occupied.id, { name: 'Renamed' })
        expect(store.kanbanOrder.get('alice')).toEqual(state)
        for (const id of ['processing', 'completed']) expect((await request({ revision: state.revision, order: [id] })).status).toBe(400)
    })
    it('migrates v24 and persists order across restarts; deleted groups cannot return', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-kanban-order-'))
        const path = join(dir, 'test.db')
        let store = new Store(path)
        try {
            const group = store.sessionGroups.create('alice', { name: 'Work', emoji: '🔧' })
            store.close()
            const db = new Database(path)
            db.exec('DROP TABLE kanban_order; PRAGMA user_version=24;'); db.close()
            store = new Store(path)
            store.kanbanOrder.set('alice', { revision: 0, order: ['recent', 'pending', 'pinned', `custom:${group.id}`] })
            store.close()
            store = new Store(path)
            expect(store.kanbanOrder.get('alice').order[0]).toBe('recent')
            store.close()
            const db2 = new Database(path); db2.exec('DELETE FROM session_groups'); db2.close()
            store = new Store(path)
            const current = store.kanbanOrder.get('alice')
            expect(current.order).toEqual(['recent', 'pending', 'pinned'])
            expect(store.kanbanOrder.set('alice', { revision: current.revision, order: [`custom:${group.id}`, 'recent', 'pending'] }).state.order).not.toContain(`custom:${group.id}`)
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
    })
})
