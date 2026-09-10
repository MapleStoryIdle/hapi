import type { Database } from 'bun:sqlite'
import { mergeVisibleKanbanOrder, normalizeKanbanOrder, type KanbanOrder, type KanbanOrderInput } from '@hapi/protocol/kanbanOrder'

export const KANBAN_ORDER_SCHEMA = `CREATE TABLE IF NOT EXISTS kanban_order (
    namespace TEXT PRIMARY KEY,
    lane_order TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
);`

export class KanbanOrderStore {
    constructor(private readonly db: Database) {}

    private groupIds(namespace: string): string[] {
        return (this.db.query('SELECT id FROM session_groups WHERE namespace = ? ORDER BY rowid').all(namespace) as { id: string }[]).map(row => row.id)
    }

    private persist(namespace: string, state: KanbanOrder): void {
        this.db.query(`INSERT INTO kanban_order (namespace, lane_order, revision) VALUES (?, ?, ?)
            ON CONFLICT(namespace) DO UPDATE SET lane_order = excluded.lane_order, revision = excluded.revision`)
            .run(namespace, JSON.stringify(state.order), state.revision)
    }

    get(namespace: string): KanbanOrder {
        return this.db.transaction(() => {
            const row = this.db.query('SELECT lane_order, revision FROM kanban_order WHERE namespace = ?').get(namespace) as { lane_order: string; revision: number } | null
            const saved: string[] = row ? JSON.parse(row.lane_order) : []
            const order = normalizeKanbanOrder(saved, this.groupIds(namespace))
            const changed = JSON.stringify(saved) !== JSON.stringify(order)
            const state = { order, revision: (row?.revision ?? 0) + (row && changed ? 1 : 0) }
            if (!row || changed) this.persist(namespace, state)
            return state
        })()
    }

    set(namespace: string, input: KanbanOrderInput): { conflict: boolean; state: KanbanOrder } {
        return this.db.transaction(() => {
            const current = this.get(namespace)
            if (input.revision !== current.revision) return { conflict: true, state: current }
            const order = input.reset ? normalizeKanbanOrder([], this.groupIds(namespace)) : mergeVisibleKanbanOrder(current.order, input.order)
            const state = { order, revision: current.revision + 1 }
            this.persist(namespace, state)
            return { conflict: false, state }
        })()
    }
}
