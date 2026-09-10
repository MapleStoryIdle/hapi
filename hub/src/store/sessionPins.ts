import type { Database } from 'bun:sqlite'
import type { SessionPinSource, SessionPinsResponse } from '@hapi/protocol/sessionPins'

export const SESSION_PIN_SCHEMA = `
    CREATE TABLE IF NOT EXISTS session_pins (
        namespace TEXT NOT NULL,
        source_type TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pinned INTEGER NOT NULL CHECK(pinned IN (0, 1)),
        PRIMARY KEY(namespace, source_type, machine_id, session_id)
    );
`

type PinRow = { source_type: 'managed' | 'native-codex'; machine_id: string; session_id: string; pinned: number }

export class SessionPinStore {
    constructor(private readonly db: Database) {}

    private resolve(namespace: string, source: SessionPinSource): SessionPinSource | null {
        if (source.type === 'native-codex') {
            return this.db.query('SELECT 1 FROM machines WHERE id = ? AND namespace = ?').get(source.machineId, namespace) ? source : null
        }
        const row = this.db.query('SELECT metadata FROM sessions WHERE id = ? AND namespace = ?').get(source.sessionId, namespace) as { metadata: string | null } | null
        if (!row) return null
        let metadata: unknown = null
        try { metadata = row.metadata ? JSON.parse(row.metadata) : null } catch { /* Invalid metadata cannot establish an alias. */ }
        if (metadata && typeof metadata === 'object' && 'flavor' in metadata && metadata.flavor === 'codex'
            && 'agentSessionId' in metadata && 'machineId' in metadata
            && typeof metadata.agentSessionId === 'string' && metadata.agentSessionId.trim()
            && typeof metadata.machineId === 'string'
            && this.db.query('SELECT 1 FROM machines WHERE id = ? AND namespace = ?').get(metadata.machineId, namespace)) {
            return { type: 'native-codex', machineId: metadata.machineId, codexSessionId: metadata.agentSessionId.trim() }
        }
        return source
    }

    private canonicalize(namespace: string): void {
        const rows = this.db.query("SELECT session_id, pinned FROM session_pins WHERE namespace = ? AND source_type = 'managed'")
            .all(namespace) as { session_id: string; pinned: number }[]
        this.db.transaction(() => {
            for (const row of rows) {
                const source = this.resolve(namespace, { type: 'managed', sessionId: row.session_id })
                if (source?.type !== 'native-codex') continue
                // A newly attached native identity takes the old managed pin
                // with it. Existing native decisions (including unpins) win.
                this.db.query(`INSERT INTO session_pins (namespace, source_type, machine_id, session_id, pinned)
                    VALUES (?, 'native-codex', ?, ?, ?) ON CONFLICT DO NOTHING`)
                    .run(namespace, source.machineId, source.codexSessionId, row.pinned)
                this.db.query("DELETE FROM session_pins WHERE namespace = ? AND source_type = 'managed' AND session_id = ?")
                    .run(namespace, row.session_id)
            }
        })()
    }

    list(namespace: string): SessionPinsResponse {
        this.canonicalize(namespace)
        const rows = this.db.query(`SELECT source_type, machine_id, session_id, pinned FROM session_pins p WHERE namespace = ? AND (
            (source_type = 'managed' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = p.session_id AND s.namespace = p.namespace)) OR
            (source_type = 'native-codex' AND EXISTS (SELECT 1 FROM machines m WHERE m.id = p.machine_id AND m.namespace = p.namespace))
        )`).all(namespace) as PinRow[]
        return { pins: rows.map(row => ({
            source: row.source_type === 'managed'
                ? { type: 'managed' as const, sessionId: row.session_id }
                : { type: 'native-codex' as const, machineId: row.machine_id, codexSessionId: row.session_id },
            pinned: row.pinned === 1
        })) }
    }

    set(namespace: string, source: SessionPinSource, pinned: boolean, migrate = false): boolean {
        if (!migrate) this.canonicalize(namespace)
        const resolved = this.resolve(namespace, source)
        if (!resolved) return false
        const machineId = resolved.type === 'managed' ? '' : resolved.machineId
        const sessionId = resolved.type === 'managed' ? resolved.sessionId : resolved.codexSessionId
        // Keep explicit unpins as tombstones: another browser's old local pins
        // must never override a decision already saved on the Hub.
        this.db.query(`INSERT INTO session_pins (namespace, source_type, machine_id, session_id, pinned)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace, source_type, machine_id, session_id)
            ${migrate ? 'DO NOTHING' : 'DO UPDATE SET pinned = excluded.pinned'}`)
            .run(namespace, resolved.type, machineId, sessionId, Number(pinned))
        return true
    }

    migrate(namespace: string, sources: SessionPinSource[]): void {
        this.canonicalize(namespace)
        this.db.transaction(() => { for (const source of sources) this.set(namespace, source, true, true) })()
    }
}
