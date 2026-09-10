import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import type { SessionGroup, SessionGroupInput, SessionGroupSource, SessionGroupsResponse } from '@hapi/protocol/sessionGroups'

export const SESSION_GROUP_SCHEMA = `
    CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        UNIQUE(namespace, id)
    );
    CREATE TABLE IF NOT EXISTS session_group_assignments (
        namespace TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('managed', 'native-codex')),
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        PRIMARY KEY(namespace, source_type, machine_id, session_id),
        FOREIGN KEY(namespace, group_id) REFERENCES session_groups(namespace, id) ON DELETE CASCADE
    );
`

type AssignmentRow = { source_type: 'managed' | 'native-codex'; machine_id: string; session_id: string; group_id: string }

export class SessionGroupStore {
    constructor(private readonly db: Database) {}

    list(namespace: string): SessionGroupsResponse {
        const groups = this.db.query('SELECT id, name, emoji FROM session_groups WHERE namespace = ? ORDER BY rowid').all(namespace) as SessionGroup[]
        const rows = this.db.query(`SELECT source_type, machine_id, session_id, group_id
            FROM session_group_assignments a WHERE namespace = ? AND (
                (source_type = 'managed' AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = a.session_id AND s.namespace = a.namespace)) OR
                (source_type = 'native-codex' AND EXISTS (SELECT 1 FROM machines m WHERE m.id = a.machine_id AND m.namespace = a.namespace))
            )`).all(namespace) as AssignmentRow[]
        return {
            groups,
            assignments: rows.map(row => ({
                groupId: row.group_id,
                source: row.source_type === 'managed'
                    ? { type: 'managed', sessionId: row.session_id }
                    : { type: 'native-codex', machineId: row.machine_id, codexSessionId: row.session_id }
            }))
        }
    }

    create(namespace: string, input: SessionGroupInput): SessionGroup {
        const group = { id: randomUUID(), ...input }
        this.db.query('INSERT INTO session_groups (id, namespace, name, emoji) VALUES (?, ?, ?, ?)')
            .run(group.id, namespace, group.name, group.emoji)
        return group
    }

    update(namespace: string, id: string, input: Partial<SessionGroupInput>): SessionGroup | null {
        return this.db.query(`UPDATE session_groups SET name = COALESCE(?, name), emoji = COALESCE(?, emoji)
            WHERE namespace = ? AND id = ? RETURNING id, name, emoji`)
            .get(input.name ?? null, input.emoji ?? null, namespace, id) as SessionGroup | null
    }

    assign(namespace: string, source: SessionGroupSource, groupId: string | null): 'ok' | 'source-not-found' | 'group-not-found' {
        return this.db.transaction(() => {
            const owned = source.type === 'managed'
                ? this.db.query('SELECT 1 FROM sessions WHERE id = ? AND namespace = ?').get(source.sessionId, namespace)
                : this.db.query('SELECT 1 FROM machines WHERE id = ? AND namespace = ?').get(source.machineId, namespace)
            if (!owned) return 'source-not-found' as const
            if (groupId && !this.db.query('SELECT 1 FROM session_groups WHERE id = ? AND namespace = ?').get(groupId, namespace)) {
                return 'group-not-found' as const
            }
            const machineId = source.type === 'managed' ? '' : source.machineId
            const sessionId = source.type === 'managed' ? source.sessionId : source.codexSessionId
            if (groupId === null) {
                this.db.query('DELETE FROM session_group_assignments WHERE namespace = ? AND source_type = ? AND machine_id = ? AND session_id = ?')
                    .run(namespace, source.type, machineId, sessionId)
            } else {
                this.db.query(`INSERT INTO session_group_assignments (namespace, source_type, machine_id, session_id, group_id)
                    VALUES (?, ?, ?, ?, ?) ON CONFLICT(namespace, source_type, machine_id, session_id)
                    DO UPDATE SET group_id = excluded.group_id`).run(namespace, source.type, machineId, sessionId, groupId)
            }
            return 'ok' as const
        })()
    }
}
