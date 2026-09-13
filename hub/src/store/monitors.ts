import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Monitor, MonitorActivity, MonitorActivityOutcome, MonitorActivitySource, MonitorBucket, MonitorCallStats, MonitorConfig, MonitorDetail, MonitorHealth, MonitorIncident, MonitorIncidentState, MonitorWebhook } from '@hapi/protocol/monitoring'
import { nextMonitorRun } from '../monitoring/schedule'
import { MonitorTokenCipher } from './monitorTokenCipher'

export const MONITOR_WEEK_MS = 7 * 86400_000
export const MONITOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS monitors (
    id TEXT PRIMARY KEY, namespace TEXT NOT NULL, config TEXT NOT NULL,
    token_hash TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    health TEXT NOT NULL DEFAULT 'unknown', last_checked_at INTEGER, last_latency_ms INTEGER,
    last_error TEXT, next_check_at INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_monitors_namespace ON monitors(namespace);
CREATE TABLE IF NOT EXISTS monitor_buckets (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    at INTEGER NOT NULL, total INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(monitor_id, at)
);
CREATE TABLE IF NOT EXISTS monitor_incidents (
    id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_incidents_monitor ON monitor_incidents(monitor_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_incidents_open ON monitor_incidents(monitor_id)
    WHERE state NOT IN ('closed', 'completed');
CREATE TABLE IF NOT EXISTS monitor_receipts (
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    event_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(monitor_id, event_hash)
);
CREATE INDEX IF NOT EXISTS idx_monitor_receipts_time ON monitor_receipts(monitor_id, created_at);
CREATE TABLE IF NOT EXISTS monitor_tokens (
    monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
    ciphertext TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_events (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_monitor_events_monitor_time ON monitor_events(monitor_id, created_at DESC);
`

type MonitorRow = {
    id: string; namespace: string; config: string; token_hash: string | null
    created_at: number; updated_at: number; health: MonitorHealth
    last_checked_at: number | null; last_latency_ms: number | null
    last_error: string | null; next_check_at: number; consecutive_failures: number
}
export type MonitorDispatchConfig = Pick<MonitorConfig, 'machineId' | 'directory' | 'agent' | 'model' | 'reasoningEffort' | 'permissionMode' | 'prompt' | 'targetSession'>
type IncidentData = Omit<MonitorIncident, 'id' | 'monitorId' | 'createdAt' | 'updatedAt' | 'state'> & { details: string; config: MonitorDispatchConfig }
type IncidentRow = { id: string; monitor_id: string; state: MonitorIncidentState; created_at: number; updated_at: number; data: string }
export type StoredMonitor = { id: string; namespace: string; config: MonitorConfig; health: MonitorHealth; nextCheckAt: number; consecutiveFailures: number }
export type StoredMonitorIncident = MonitorIncident & { details: string; config: MonitorDispatchConfig }
export function monitorTokenHash(token: string): string { return createHash('sha256').update(token).digest('hex') }

function incident(row: IncidentRow): StoredMonitorIncident {
    return { ...JSON.parse(row.data) as IncidentData, id: row.id, monitorId: row.monitor_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at }
}
function publicIncident(value: StoredMonitorIncident): MonitorIncident {
    const { details: _details, config: _config, ...result } = value
    return { ...result, ...(_config ? { approvalContext: monitorApprovalContext(_config) } : {}) }
}

export function monitorApprovalContext(config: MonitorDispatchConfig) {
    const { machineId, directory, agent, model, reasoningEffort, permissionMode } = config
    return { machineId, directory, agent, model, reasoningEffort, permissionMode }
}

export class MonitorStore {
    private readonly cipher: MonitorTokenCipher
    constructor(private readonly db: Database, dbPath = ':memory:') { this.cipher = new MonitorTokenCipher(dbPath) }

    private saveToken(id: string, namespace: string, token: string): void {
        const hasTokens = Boolean(this.db.query('SELECT 1 FROM monitor_tokens LIMIT 1').get())
        const ciphertext = this.cipher.encrypt(token, JSON.stringify([namespace, id]), !hasTokens)
        this.db.query('INSERT OR REPLACE INTO monitor_tokens(monitor_id,ciphertext) VALUES(?,?)').run(id, ciphertext)
    }

    readToken(id: string, namespace: string): string | null {
        if (!this.get(id, namespace)) return null
        const row = this.db.query('SELECT ciphertext FROM monitor_tokens WHERE monitor_id=?').get(id) as { ciphertext: string } | null
        return row ? this.cipher.decrypt(row.ciphertext, JSON.stringify([namespace, id])) : null
    }

    delete(id: string, namespace: string): boolean {
        return this.db.query('DELETE FROM monitors WHERE id=? AND namespace=?').run(id, namespace).changes > 0
    }

    create(namespace: string, config: MonitorConfig, now = Date.now()): { id: string; token: string | null } {
        return this.db.transaction(() => {
            const total = this.db.query('SELECT COUNT(*) AS count FROM monitors').get() as { count: number }
            const owned = this.db.query('SELECT COUNT(*) AS count FROM monitors WHERE namespace = ?').get(namespace) as { count: number }
            if (total.count >= 200 || owned.count >= 50) throw new Error('Monitor limit reached')
            const id = randomUUID()
            const token = config.kind === 'webhook' ? randomBytes(32).toString('base64url') : null
            this.db.query('INSERT INTO monitors(id,namespace,config,token_hash,created_at,updated_at,next_check_at) VALUES(?,?,?,?,?,?,?)')
                .run(id, namespace, JSON.stringify(config), token ? monitorTokenHash(token) : null, now, now, config.kind === 'scheduled' && config.schedule ? nextMonitorRun(config.schedule, now) : now)
            if (token) this.saveToken(id, namespace, token)
            return { id, token }
        })()
    }

    get(id: string, namespace?: string): StoredMonitor | null {
        const row = this.db.query('SELECT * FROM monitors WHERE id = ?').get(id) as MonitorRow | null
        if (!row || namespace !== undefined && row.namespace !== namespace) return null
        return { id: row.id, namespace: row.namespace, config: JSON.parse(row.config) as MonitorConfig, health: row.health, nextCheckAt: row.next_check_at, consecutiveFailures: row.consecutive_failures }
    }

    byToken(token: string): StoredMonitor | null {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
        const row = this.db.query('SELECT id FROM monitors WHERE token_hash = ?').get(monitorTokenHash(token)) as { id: string } | null
        return row ? this.get(row.id) : null
    }

    all(): StoredMonitor[] {
        const rows = this.db.query('SELECT id FROM monitors ORDER BY next_check_at, id LIMIT 200').all() as { id: string }[]
        return rows.map(r => this.get(r.id)!)
    }

    setNotificationsEnabled(id: string, namespace: string, enabled: boolean): boolean {
        const monitor = this.get(id, namespace)
        if (!monitor) return false
        return this.db.query('UPDATE monitors SET config=?,updated_at=? WHERE id=? AND namespace=?')
            .run(JSON.stringify({ ...monitor.config, notificationsEnabled: enabled }), Date.now(), id, namespace).changes > 0
    }

    update(id: string, namespace: string, config: MonitorConfig, now = Date.now()): boolean {
        return this.db.query('UPDATE monitors SET config = ?, updated_at = ?, next_check_at = ? WHERE id = ? AND namespace = ?')
            .run(JSON.stringify(config), now, config.kind === 'scheduled' && config.schedule ? nextMonitorRun(config.schedule, now) : now, id, namespace).changes === 1
    }

    rotateToken(id: string, namespace: string): string {
        return this.db.transaction(() => {
        const token = randomBytes(32).toString('base64url')
        if (this.db.query('UPDATE monitors SET token_hash = ?, updated_at = ? WHERE id = ? AND namespace = ?')
            .run(monitorTokenHash(token), Date.now(), id, namespace).changes !== 1) throw new Error('Monitor not found')
        this.saveToken(id, namespace, token)
        return token
        })()
    }

    list(namespace: string, now = Date.now()): Monitor[] {
        const rows = this.db.query('SELECT id FROM monitors WHERE namespace = ? ORDER BY created_at DESC LIMIT 50').all(namespace) as { id: string }[]
        return rows.map(r => { const { incidents: _incidents, activities: _activities, ...value } = this.detail(r.id, namespace, now, false)!; return value })
    }

    detail(id: string, namespace: string, now = Date.now(), includeHistory = true): MonitorDetail | null {
        const row = this.db.query('SELECT * FROM monitors WHERE id = ? AND namespace = ?').get(id, namespace) as MonitorRow | null
        if (!row) return null
        const buckets = this.db.query('SELECT at,total,ok,failures,latency_ms AS latencyMs FROM monitor_buckets WHERE monitor_id = ? AND at >= ? ORDER BY at')
            .all(id, Math.floor((now - MONITOR_WEEK_MS) / 3600_000) * 3600_000) as MonitorBucket[]
        const open = this.openForMonitor(id)
        const config = JSON.parse(row.config) as MonitorConfig
        const recent = this.db.query("SELECT * FROM monitor_incidents WHERE monitor_id=? AND json_extract(data,'$.sessionId') IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(id) as IncidentRow | null
        const last = recent ? incident(recent) : null
        const relatedSession: Monitor['relatedSession'] = config.targetSession
            ? { ...config.targetSession, machineId: config.machineId }
            : last?.sessionId ? { type: 'managed', sessionId: last.repairSessionId ?? last.sessionId } : undefined
        // List screens must not read every historical plan or copy credentials.
        const incidents = includeHistory ? (this.db.query(`SELECT id,monitor_id,state,created_at,updated_at,
            json_set(json_remove(data,'$.config','$.details'),'$.plan',NULL,'$.planHash',NULL) AS data
            FROM monitor_incidents WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 101`).all(id) as IncidentRow[])
            .map(r => publicIncident(incident(r))) : []
        const activities = includeHistory ? this.activities(id) : []
        const statsRow = includeHistory ? this.db.query(`SELECT COUNT(*) AS total,
            SUM(outcome='ok') AS ok, SUM(outcome='failed') AS failed,
            SUM(outcome='dispatched') AS dispatched, SUM(outcome='deferred') AS deferred,
            SUM(outcome='duplicate') AS duplicate
            FROM monitor_events WHERE monitor_id=? AND source!='manual' AND created_at>=?`).get(id, now - MONITOR_WEEK_MS) as Record<keyof MonitorCallStats, number | null> : null
        const callStats: MonitorCallStats = {
            total: statsRow?.total ?? 0,
            ok: statsRow?.ok ?? 0,
            failed: statsRow?.failed ?? 0,
            dispatched: statsRow?.dispatched ?? 0,
            deferred: statsRow?.deferred ?? 0,
            duplicate: statsRow?.duplicate ?? 0
        }
        return {
            id, config: JSON.parse(row.config) as MonitorConfig, createdAt: row.created_at, updatedAt: row.updated_at,
            health: row.health, lastCheckedAt: row.last_checked_at, lastLatencyMs: row.last_latency_ms,
            lastError: row.last_error, nextCheckAt: row.next_check_at, buckets,
            incident: open ? publicIncident(open) : null, incidents, activities, callStats, relatedSession
        }
    }

    activities(id: string, limit = 100): MonitorActivity[] {
        return this.db.query(`SELECT id,monitor_id AS monitorId,created_at AS createdAt,source,outcome,summary,details
            FROM monitor_events WHERE monitor_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(id, limit) as MonitorActivity[]
    }

    private recordActivity(id: string, source: MonitorActivitySource, outcome: MonitorActivityOutcome, summary: string, details = '', now = Date.now()): string {
        const eventId = randomUUID()
        this.db.query('INSERT INTO monitor_events(id,monitor_id,source,outcome,created_at,summary,details) VALUES(?,?,?,?,?,?,?)')
            .run(eventId, id, source, outcome, now, summary.slice(0, 500), details.slice(0, 12000))
        return eventId
    }

    recordProbe(id: string, ok: boolean, latency: number, error: string | null, nextAt: number, now = Date.now()): void {
        this.db.transaction(() => {
            this.db.query('UPDATE monitors SET health=?,last_checked_at=?,last_latency_ms=?,last_error=?,next_check_at=? WHERE id=?')
                .run(ok ? 'up' : 'down', now, latency, error, nextAt, id)
            this.db.query('UPDATE monitors SET consecutive_failures = CASE WHEN ? THEN 0 ELSE consecutive_failures + 1 END WHERE id=?').run(ok ? 1 : 0, id)
            this.bucket(id, ok, latency, now)
        })()
    }

    claimProbe(id: string, expectedNextAt: number, nextAt: number): boolean {
        // Reserve the next interval before I/O. A crash during a POST must not
        // cause an immediate replay on restart; its missing sample stays unknown.
        return this.db.query("UPDATE monitors SET next_check_at=?,health='unknown' WHERE id=? AND next_check_at=?")
            .run(nextAt, id, expectedNextAt).changes === 1
    }

    claimScheduled(monitor: StoredMonitor, now: number): { incidentId: string; created: boolean } | null {
        if (!monitor.config.schedule) return null
        return this.db.transaction(() => {
            // Claim and incident creation are one transaction. Skip missed ticks
            // after downtime; retain at most one pending investigation per rule.
            const next = nextMonitorRun(monitor.config.schedule!, now)
            const claimed = this.db.query('UPDATE monitors SET next_check_at=?,last_checked_at=? WHERE id=? AND next_check_at=?')
                .run(next, now, monitor.id, monitor.nextCheckAt)
            if (!claimed.changes) return null
            this.bucket(monitor.id, true, 0, now)
            const opened = this.openIncident(monitor, 'Scheduled trigger', '', now)
            this.recordActivity(monitor.id, 'scheduled', opened.created ? 'dispatched' : 'deferred', 'Scheduled trigger', '', now)
            return opened
        })()
    }

    recordProbeAndIncident(monitor: StoredMonitor, ok: boolean, latency: number, error: string | null, nextAt: number): { incidentId: string; created: boolean } | null {
        return this.db.transaction(() => {
            this.recordProbe(monitor.id, ok, latency, error, nextAt)
            // Successful samples already live in hourly buckets. The activity
            // ledger is reserved for actionable failures so frequent probes do
            // not create an unbounded stream of redundant rows.
            if (ok) return null
            const summary = error ?? 'HTTP check failed'
            if ((this.get(monitor.id)?.consecutiveFailures ?? 0) >= 2) {
                const opened = this.openIncident(monitor, summary, 'An automatic HTTP probe did not match the configured expectation.')
                this.recordActivity(monitor.id, 'probe', opened.created ? 'dispatched' : 'deferred', summary, `${latency} ms`)
                return opened
            }
            this.recordActivity(monitor.id, 'probe', 'failed', summary, `${latency} ms`)
            return null
        })()
    }

    private bucket(id: string, ok: boolean, latency: number, now: number): void {
        this.db.query(`INSERT INTO monitor_buckets(monitor_id,at,total,ok,failures,latency_ms) VALUES(?,?,1,?,?,?)
            ON CONFLICT(monitor_id,at) DO UPDATE SET total=total+1,ok=ok+excluded.ok,failures=failures+excluded.failures,latency_ms=latency_ms+excluded.latency_ms`)
            .run(id, Math.floor(now / 3600_000) * 3600_000, ok ? 1 : 0, ok ? 0 : 1, latency)
    }

    acceptWebhook(monitor: StoredMonitor, event: MonitorWebhook, now = Date.now()): { duplicate: boolean; incidentId: string; created: boolean } {
        return this.db.transaction(() => {
            this.db.query('DELETE FROM monitor_receipts WHERE monitor_id=? AND created_at < ?').run(monitor.id, now - MONITOR_WEEK_MS)
            const hash = monitorTokenHash(event.eventId)
            const duplicate = this.db.query('SELECT 1 FROM monitor_receipts WHERE monitor_id=? AND event_hash=?').get(monitor.id, hash)
            // Metrics represent valid webhook calls, while receipts only
            // deduplicate investigation work. Repeated deliveries are still
            // calls, but must never create duplicate incidents or sessions.
            this.bucket(monitor.id, true, 0, now)
            this.db.query('UPDATE monitors SET last_checked_at=? WHERE id=?').run(now, monitor.id)
            if (duplicate) {
                this.recordActivity(monitor.id, 'webhook', 'duplicate', event.summary, event.details, now)
                return { duplicate: true, incidentId: '', created: false }
            }
            const counts = this.db.query('SELECT COUNT(*) AS total, SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS recent FROM monitor_receipts WHERE monitor_id=?')
                .get(now - 60_000, monitor.id) as { total: number; recent: number | null }
            if (counts.total >= 2000 || (counts.recent ?? 0) >= 10) throw new Error('Webhook rate limit reached')
            this.db.query('INSERT INTO monitor_receipts(monitor_id,event_hash,created_at) VALUES(?,?,?)').run(monitor.id, hash, now)
            const opened = this.openIncident(monitor, event.summary, event.details, now)
            this.recordActivity(monitor.id, 'webhook', opened.created ? 'dispatched' : 'deferred', event.summary, event.details, now)
            return { duplicate: false, ...opened }
        })()
    }

    triggerManual(monitor: StoredMonitor, summary = 'Manual test trigger', details = '', now = Date.now()): { activityId: string; incidentId: string; created: boolean } {
        return this.db.transaction(() => {
            const opened = this.openIncident(monitor, summary, details, now)
            const activityId = this.recordActivity(monitor.id, 'manual', opened.created ? 'dispatched' : 'deferred', summary, details, now)
            return { activityId, ...opened }
        })()
    }

    retriggerActivity(monitor: StoredMonitor, activityId: string, now = Date.now()): { incidentId: string; created: boolean } | null {
        return this.db.transaction(() => {
            const row = this.db.query(`SELECT summary,details FROM monitor_events
                WHERE id=? AND monitor_id=? AND outcome='deferred'`).get(activityId, monitor.id) as { summary: string; details: string } | null
            if (!row || this.openForMonitor(monitor.id)) return null
            const opened = this.openIncident(monitor, row.summary, row.details, now)
            if (!opened.created) return null
            this.db.query("UPDATE monitor_events SET outcome='dispatched' WHERE id=? AND monitor_id=? AND outcome='deferred'").run(activityId, monitor.id)
            return opened
        })()
    }

    openIncident(monitor: StoredMonitor, summary: string, details: string, now = Date.now()): { incidentId: string; created: boolean } {
        const existing = this.openForMonitor(monitor.id)
        if (existing) return { incidentId: existing.id, created: false }
        // One open incident per rule; repeats update metrics, never spawn an agent storm.
        const id = randomUUID()
        const { machineId, directory, agent, model, reasoningEffort, permissionMode, prompt, targetSession } = monitor.config
        const config: MonitorDispatchConfig = { machineId, directory, agent, model, reasoningEffort, permissionMode, prompt, targetSession }
        const data: IncidentData = { summary, details, config, sessionId: null, repairSessionId: null, plan: null, planHash: null, error: null }
        this.db.query('INSERT INTO monitor_incidents(id,monitor_id,state,created_at,updated_at,data) VALUES(?,?,?,?,?,?)')
            .run(id, monitor.id, 'queued', now, now, JSON.stringify(data))
        return { incidentId: id, created: true }
    }

    openForMonitor(id: string): StoredMonitorIncident | null {
        // A completed run still holds the gate until the owner acknowledges its
        // result by closing it. This prevents later triggers from silently
        // starting another agent task before the previous result was reviewed.
        const row = this.db.query("SELECT * FROM monitor_incidents WHERE monitor_id=? AND state!='closed' LIMIT 1").get(id) as IncidentRow | null
        return row ? incident(row) : null
    }

    getIncident(id: string): StoredMonitorIncident | null {
        const row = this.db.query('SELECT * FROM monitor_incidents WHERE id=?').get(id) as IncidentRow | null
        return row ? incident(row) : null
    }

    transition(id: string, expected: MonitorIncidentState, state: MonitorIncidentState, patch: Partial<IncidentData> = {}): boolean {
        const current = this.getIncident(id)
        if (!current || current.state !== expected) return false
        const { id: _id, monitorId: _monitor, createdAt: _created, updatedAt: _updated, state: _state, ...data } = current
        return this.db.query('UPDATE monitor_incidents SET state=?,data=?,updated_at=? WHERE id=? AND state=?')
            .run(state, JSON.stringify({ ...data, ...patch }), Date.now(), id, expected).changes === 1
    }

    recoverInterrupted(): void {
        // A spawn may have succeeded before Hub crashed. Never blindly replay it.
        for (const state of ['starting', 'repair_starting'] as const) {
            const rows = this.db.query('SELECT id FROM monitor_incidents WHERE state=?').all(state) as { id: string }[]
            for (const row of rows) this.transition(row.id, state, 'needs_attention', { error: 'Dispatch interrupted; check the session list before starting another investigation.' })
        }
    }

    prune(now = Date.now()): void {
        this.db.transaction(() => {
            this.db.query('DELETE FROM monitor_buckets WHERE at < ?').run(Math.floor((now - MONITOR_WEEK_MS) / 3600_000) * 3600_000)
            this.db.query('DELETE FROM monitor_receipts WHERE created_at < ?').run(now - MONITOR_WEEK_MS)
            this.db.query('DELETE FROM monitor_events WHERE created_at < ?').run(now - MONITOR_WEEK_MS)
            this.db.query("DELETE FROM monitor_incidents WHERE state='closed' AND created_at < ?").run(now - MONITOR_WEEK_MS)
            for (const monitor of this.all()) this.db.query("DELETE FROM monitor_incidents WHERE monitor_id=? AND state='closed' AND id NOT IN (SELECT id FROM monitor_incidents WHERE monitor_id=? AND state='closed' ORDER BY created_at DESC LIMIT 100)")
                .run(monitor.id, monitor.id)
            this.db.query("DELETE FROM monitor_incidents WHERE state='closed' AND id NOT IN (SELECT id FROM monitor_incidents WHERE state='closed' ORDER BY created_at DESC LIMIT 2000)").run()
        })()
    }
}
