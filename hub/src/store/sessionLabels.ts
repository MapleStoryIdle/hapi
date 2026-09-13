import type { Database } from 'bun:sqlite'
import type { SessionLabelSource, SessionLabelsResponse } from '@hapi/protocol/sessionLabels'

export const SESSION_LABEL_SCHEMA = `
    CREATE TABLE IF NOT EXISTS session_labels (
        namespace TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('managed', 'native-codex')),
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY(namespace, source_type, machine_id, session_id)
    );
`

type LabelRow = {
    source_type: 'managed' | 'native-codex'
    machine_id: string
    session_id: string
    label: string
}

export class SessionLabelStore {
    constructor(private readonly db: Database) {}

    list(namespace: string): SessionLabelsResponse {
        const rows = this.db.query(`SELECT source_type, machine_id, session_id, label
            FROM session_labels l WHERE namespace = ? AND (
                (source_type = 'managed' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = l.session_id AND s.namespace = l.namespace)) OR
                (source_type = 'native-codex' AND EXISTS (SELECT 1 FROM machines m WHERE m.id = l.machine_id AND m.namespace = l.namespace))
            )`).all(namespace) as LabelRow[]
        return {
            labels: rows.map(row => ({
                label: row.label,
                source: row.source_type === 'managed'
                    ? { type: 'managed', sessionId: row.session_id }
                    : { type: 'native-codex', machineId: row.machine_id, codexSessionId: row.session_id }
            }))
        }
    }

    set(namespace: string, source: SessionLabelSource, label: string | null): 'ok' | 'source-not-found' {
        const owned = source.type === 'managed'
            ? this.db.query('SELECT 1 FROM sessions WHERE id = ? AND namespace = ?').get(source.sessionId, namespace)
            : this.db.query('SELECT 1 FROM machines WHERE id = ? AND namespace = ?').get(source.machineId, namespace)
        if (!owned) return 'source-not-found'

        const machineId = source.type === 'managed' ? '' : source.machineId
        const sessionId = source.type === 'managed' ? source.sessionId : source.codexSessionId
        if (label === null) {
            this.db.query('DELETE FROM session_labels WHERE namespace = ? AND source_type = ? AND machine_id = ? AND session_id = ?')
                .run(namespace, source.type, machineId, sessionId)
        } else {
            this.db.query(`INSERT INTO session_labels (namespace, source_type, machine_id, session_id, label)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace, source_type, machine_id, session_id)
                DO UPDATE SET label = excluded.label`).run(namespace, source.type, machineId, sessionId, label)
        }
        return 'ok'
    }
}
