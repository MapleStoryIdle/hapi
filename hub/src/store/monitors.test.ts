import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MonitorConfigSchema } from '@hapi/protocol/monitoring'
import { Store } from './index'
import { MONITOR_WEEK_MS } from './monitors'

const config = () => MonitorConfigSchema.parse({ name: 'API', kind: 'webhook', directory: '/work', machineId: 'm', prompt: 'Investigate' })

describe('monitor store', () => {
    it('defaults webhook ignore keywords for existing configurations', () => {
        expect(config().webhookIgnoreKeywords).toBe('')
        expect(config().deliveryMode).toBe('current-session')
    })
    it('persists encrypted tokens, migrates legacy hashes without rotation and fails closed without the key', () => {
        const dir = mkdtempSync(join(tmpdir(), 'monitor-token-'))
        const path = join(dir, 'test.db')
        let store = new Store(path)
        try {
            const created = store.monitors.create('a', config())
            expect(store.monitors.readToken(created.id, 'a')).toBe(created.token)
            expect(store.monitors.readToken(created.id, 'b')).toBeNull()
            const db = new Database(path)
            expect(JSON.stringify(db.query('SELECT * FROM monitor_tokens').all())).not.toContain(created.token!)
            expect(statSync(path + '.monitor-key').mode & 0o777).toBe(0o600)
            store.close()
            store = new Store(path)
            expect(store.monitors.readToken(created.id, 'a')).toBe(created.token)
            const rotated = store.monitors.rotateToken(created.id, 'a')
            expect(store.monitors.byToken(created.token!)).toBeNull()
            expect(store.monitors.readToken(created.id, 'a')).toBe(rotated)
            store.close()
            renameSync(path + '.monitor-key', path + '.saved-key')
            store = new Store(path)
            expect(() => store.monitors.readToken(created.id, 'a')).toThrow()
            expect(() => store.monitors.rotateToken(created.id, 'a')).toThrow()
            expect(store.monitors.byToken(rotated)?.id).toBe(created.id)
            renameSync(path + '.saved-key', path + '.monitor-key')
            db.exec('DROP TABLE monitor_tokens; PRAGMA user_version=20')
            db.close()
            store.close()
            store = new Store(path)
            expect(store.monitors.readToken(created.id, 'a')).toBeNull()
            expect(store.monitors.byToken(rotated)?.id).toBe(created.id)
            expect(store.monitors.delete(created.id, 'b')).toBe(false)
            expect(store.monitors.delete(created.id, 'a')).toBe(true)
            expect(store.monitors.byToken(rotated)).toBeNull()
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
    })
    it('isolates namespaces, hashes/rotates tokens and deduplicates events', () => {
        const store = new Store(':memory:')
        try {
            const created = store.monitors.create('a', config())
            expect(created.token).toHaveLength(43)
            expect(store.monitors.list('b')).toHaveLength(0)
            expect(store.monitors.get(created.id, 'b')).toBeNull()
            const monitor = store.monitors.get(created.id, 'a')!
            const event = { eventId: '1', summary: 'Failure', details: 'Evidence' }
            const first = store.monitors.acceptWebhook(monitor, event)
            expect(first.created).toBe(true)
            expect(store.monitors.acceptWebhook(monitor, event).duplicate).toBe(true)
            expect(store.monitors.acceptWebhook(monitor, { ...event, eventId: '2' }).created).toBe(false)
            const detail = store.monitors.detail(created.id, 'a')!
            expect(detail.incidents).toHaveLength(1)
            // Every valid call is counted, even when its event is deduplicated.
            expect(detail.buckets[0].total).toBe(3)
            expect(detail.callStats).toMatchObject({ total: 3, dispatched: 1, deferred: 1, duplicate: 1 })
            expect(detail.activities.map(activity => activity.outcome)).toEqual(['deferred', 'duplicate', 'dispatched'])
            expect(store.monitors.list('a')[0]?.lastActivity).toMatchObject({ outcome: 'deferred', summary: 'Failure' })
            expect(store.monitors.list('a')[0]?.lastActivity).not.toHaveProperty('details')
            expect(store.monitors.list('a')[0]?.lastDelivery).toBeNull()
            const deferred = detail.activities.find(activity => activity.outcome === 'deferred')!
            expect(store.monitors.retriggerActivity(monitor, deferred.id)).toBeNull()
            expect(store.monitors.transition(first.incidentId, 'queued', 'closed')).toBe(true)
            const retriggered = store.monitors.retriggerActivity(monitor, deferred.id)!
            expect(retriggered.created).toBe(true)
            expect(store.monitors.activities(created.id).find(activity => activity.id === deferred.id)?.outcome).toBe('dispatched')
            expect(store.monitors.transition(retriggered.incidentId, 'queued', 'completed')).toBe(true)
            const afterCompletion = store.monitors.acceptWebhook(monitor, { ...event, eventId: '3' })
            expect(afterCompletion.created).toBe(false)
            expect(store.monitors.openForMonitor(created.id)?.state).toBe('completed')
            expect(store.monitors.transition(retriggered.incidentId, 'completed', 'closed')).toBe(true)
            expect(store.monitors.retriggerActivity(monitor, store.monitors.activities(created.id).find(activity => activity.summary === 'Failure' && activity.outcome === 'deferred')!.id)?.created).toBe(true)
            expect(JSON.stringify(detail)).not.toContain(created.token!)
            expect(detail.incidents[0]).not.toHaveProperty('config')
            const token = store.monitors.rotateToken(created.id, 'a')
            expect(store.monitors.byToken(created.token!)).toBeNull()
            expect(store.monitors.byToken(token)?.id).toBe(created.id)
        } finally { store.close() }
    })
    it('limits event storms and preserves one open incident while pruning old metrics', () => {
        const store = new Store(':memory:')
        try {
            const { id } = store.monitors.create('a', config())
            const m = store.monitors.get(id)!
            for (let i = 0; i < 10; i++) store.monitors.acceptWebhook(m, { eventId: String(i), summary: 'bad', details: '' }, 1000)
            expect(() => store.monitors.acceptWebhook(m, { eventId: '11', summary: 'bad', details: '' }, 1000)).toThrow('rate limit')
            store.monitors.prune(MONITOR_WEEK_MS + 3600_001)
            expect(store.monitors.detail(id, 'a')?.buckets).toHaveLength(0)
            expect(store.monitors.openForMonitor(id)).not.toBeNull()
        } finally { store.close() }
    })
    it('never retries an ambiguous spawn after restart and atomically claims states', () => {
        const store = new Store(':memory:')
        try {
            const { id } = store.monitors.create('a', config())
            const event = store.monitors.openIncident(store.monitors.get(id)!, 'bad', '')
            expect(store.monitors.transition(event.incidentId, 'queued', 'starting')).toBe(true)
            expect(store.monitors.transition(event.incidentId, 'queued', 'starting')).toBe(false)
            store.monitors.recoverInterrupted()
            expect(store.monitors.getIncident(event.incidentId)?.state).toBe('needs_attention')
        } finally { store.close() }
    })
    it('keeps the bound source link available when delivery needs attention', () => {
        const store = new Store(':memory:')
        try {
            const targetConfig = MonitorConfigSchema.parse({
                ...config(),
                targetSession: { type: 'native-codex', sessionId: 'native-thread' }
            })
            const { id } = store.monitors.create('a', targetConfig)
            const event = store.monitors.openIncident(store.monitors.get(id)!, 'bad', '')
            expect(store.monitors.transition(event.incidentId, 'queued', 'starting', { sessionId: 'native-thread' })).toBe(true)
            expect(store.monitors.transition(event.incidentId, 'starting', 'needs_attention', { error: 'delivery failed' })).toBe(true)
            expect(store.monitors.detail(id, 'a')?.incident?.deliverySession).toEqual({
                type: 'native-codex',
                sessionId: 'native-thread',
                machineId: 'm'
            })
        } finally { store.close() }
    })
    it('includes the latest delivered incident in monitor list summaries', () => {
        const store = new Store(':memory:')
        try {
            const { id } = store.monitors.create('a', config())
            const event = store.monitors.openIncident(store.monitors.get(id)!, 'delivered event', '')
            expect(store.monitors.transition(event.incidentId, 'queued', 'starting')).toBe(true)
            expect(store.monitors.transition(event.incidentId, 'starting', 'investigating', {
                sessionId: 'session-1',
                deliveredAt: 1234
            })).toBe(true)
            expect(store.monitors.list('a')[0]?.lastDelivery).toMatchObject({
                id: event.incidentId,
                summary: 'delivered event',
                deliveredAt: 1234
            })
        } finally { store.close() }
    })
    it('migrates V18 without changing existing sessions', () => {
        const dir = mkdtempSync(join(tmpdir(), 'shapi-monitor-migration-'))
        const path = join(dir, 'test.db')
        try {
            const original = new Store(path)
            const session = original.sessions.getOrCreateSession('test', { path: '/work' }, null, 'a')
            original.close()
            const db = new Database(path)
            db.exec('DROP TABLE monitor_receipts; DROP TABLE monitor_incidents; DROP TABLE monitor_buckets; DROP TABLE monitors; PRAGMA user_version=18;')
            db.close()
            const migrated = new Store(path)
            expect(migrated.sessions.getSessionByNamespace(session.id, 'a')?.id).toBe(session.id)
            expect(migrated.monitors.list('a')).toEqual([])
            migrated.close()
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
    it('retains 100 closed incidents independently of the open incident', () => {
        const store = new Store(':memory:')
        try {
            const { id } = store.monitors.create('a', config())
            const monitor = store.monitors.get(id)!
            for (let i = 0; i < 101; i++) {
                const event = store.monitors.openIncident(monitor, 'bad', '')
                store.monitors.transition(event.incidentId, 'queued', 'closed')
            }
            store.monitors.openIncident(monitor, 'still open', '')
            store.monitors.prune()
            const detail = store.monitors.detail(id, 'a')!
            expect(detail.incidents.filter(i => i.state === 'closed')).toHaveLength(100)
            expect(detail.incident?.summary).toBe('still open')
        } finally { store.close() }
    })
    it('migrates V19 to Bark settings while retaining monitor and session data', () => {
        const dir = mkdtempSync(join(tmpdir(), 'shapi-bark-migration-'))
        const path = join(dir, 'test.db')
        try {
            const original = new Store(path)
            const session = original.sessions.getOrCreateSession('kept', { path: '/work' }, null, 'a')
            const rule = original.monitors.create('a', config())
            original.close()
            const db = new Database(path)
            db.exec('DROP TABLE bark_settings; PRAGMA user_version=19;')
            db.close()
            const migrated = new Store(path)
            try {
                expect(migrated.monitors.get(rule.id, 'a')?.config.name).toBe('API')
                expect(migrated.sessions.getSessionByNamespace(session.id, 'a')?.id).toBe(session.id)
                expect(migrated.push.getBarkKey('a')).toBeNull()
                migrated.push.setBarkKey('a', 'TEST_DEVICE_KEY')
                expect(migrated.push.getBarkKey('a')).toBe('TEST_DEVICE_KEY')
            } finally { migrated.close() }
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
    it('migrates V25 with monitor activity history support', () => {
        const dir = mkdtempSync(join(tmpdir(), 'shapi-monitor-v25-'))
        const path = join(dir, 'test.db')
        let store = new Store(path)
        try {
            const rule = store.monitors.create('a', config())
            store.close()
            const db = new Database(path)
            db.exec('DROP TABLE monitor_events; PRAGMA user_version=25;')
            db.close()
            store = new Store(path)
            expect(store.monitors.get(rule.id, 'a')?.config.name).toBe('API')
            expect(store.monitors.detail(rule.id, 'a')?.activities).toEqual([])
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
    })
})
