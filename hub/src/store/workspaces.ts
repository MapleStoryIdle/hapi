import type { Database } from 'bun:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'

export type WorkspaceAccessKind = 'legacy' | 'web' | 'runner'

export type Workspace = {
    id: string
    name: string
    dataNamespace: string
    createdAt: number
}

export type WorkspaceAccess = {
    workspace: Workspace
    accessKeyId: string
    kind: WorkspaceAccessKind
}

export type WorkspaceAccessKey = {
    id: string
    kind: WorkspaceAccessKind
    name: string
    createdAt: number
    expiresAt: number | null
    lastUsedAt: number | null
}

export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data_namespace TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_access_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('legacy', 'web', 'runner')),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workspace_access_keys_workspace ON workspace_access_keys(workspace_id, revoked_at);
`

type WorkspaceRow = { id: string; name: string; data_namespace: string; created_at: number }
type AccessRow = WorkspaceRow & {
    access_key_id: string
    kind: WorkspaceAccessKind
    expires_at: number | null
    revoked_at: number | null
}

function tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

function fromRow(row: WorkspaceRow): Workspace {
    return { id: row.id, name: row.name, dataNamespace: row.data_namespace, createdAt: row.created_at }
}

export class WorkspaceStore {
    constructor(private readonly db: Database) {}

    get(id: string): Workspace | null {
        const row = this.db.query('SELECT id,name,data_namespace,created_at FROM workspaces WHERE id=?').get(id) as WorkspaceRow | null
        return row ? fromRow(row) : null
    }

    getByDataNamespace(namespace: string): Workspace | null {
        const row = this.db.query('SELECT id,name,data_namespace,created_at FROM workspaces WHERE data_namespace=?').get(namespace) as WorkspaceRow | null
        return row ? fromRow(row) : null
    }

    ensureLegacyWorkspace(namespace: string): Workspace {
        const existing = this.getByDataNamespace(namespace)
        if (existing) return existing
        const workspace: Workspace = {
            id: randomUUID(),
            name: namespace === 'default' ? 'Personal' : namespace,
            dataNamespace: namespace,
            createdAt: Date.now()
        }
        this.db.query('INSERT INTO workspaces(id,name,data_namespace,created_at) VALUES(?,?,?,?)')
            .run(workspace.id, workspace.name, workspace.dataNamespace, workspace.createdAt)
        return workspace
    }

    bootstrapExistingNamespaces(): void {
        const candidates = [
            'sessions', 'machines', 'users', 'push_subscriptions', 'artifacts', 'kanban_tasks',
            'session_groups', 'session_labels', 'session_pins', 'kanban_order', 'monitors',
            'bark_settings', 'plugin_settings'
        ] as const
        const existingTables = new Set(
            (this.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
                .map(row => row.name)
        )
        const namespaceQueries = candidates
            .filter(table => existingTables.has(table))
            .map(table => `SELECT namespace FROM ${table}`)
        const namespaces = namespaceQueries.length > 0
            ? this.db.query(namespaceQueries.join(' UNION ')).all() as Array<{ namespace: string }>
            : []
        this.ensureLegacyWorkspace('default')
        for (const row of namespaces) this.ensureLegacyWorkspace(row.namespace)
    }

    bootstrapLegacyCredentials(baseToken: string): void {
        const workspaces = this.db.query('SELECT id,name,data_namespace,created_at FROM workspaces').all() as WorkspaceRow[]
        const now = Date.now()
        const insert = this.db.query(`INSERT OR IGNORE INTO workspace_access_keys
            (id,workspace_id,kind,name,token_hash,created_at) VALUES(?,?,?,?,?,?)`)
        this.db.transaction(() => {
            for (const workspace of workspaces) {
                const token = workspace.data_namespace === 'default' ? baseToken : `${baseToken}:${workspace.data_namespace}`
                insert.run(randomUUID(), workspace.id, 'legacy', 'Migrated CLI_API_TOKEN', tokenHash(token), now)
            }
        })()
    }

    authenticate(token: string, legacyBaseToken: string, purpose: 'web' | 'runner'): WorkspaceAccess | null {
        const now = Date.now()
        const row = this.db.query(`SELECT k.id access_key_id,k.kind,k.expires_at,k.revoked_at,w.id,w.name,w.data_namespace,w.created_at
            FROM workspace_access_keys k JOIN workspaces w ON w.id=k.workspace_id
            WHERE k.token_hash=?`).get(tokenHash(token)) as AccessRow | null
        if (row) {
            if (row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)
                || (row.kind !== 'legacy' && row.kind !== purpose)) return null
            this.db.query('UPDATE workspace_access_keys SET last_used_at=? WHERE id=?').run(now, row.access_key_id)
            return { workspace: fromRow(row), accessKeyId: row.access_key_id, kind: row.kind }
        }

        const legacy = parseAccessToken(token)
        if (!legacy || !constantTimeEquals(legacy.baseToken, legacyBaseToken)) return null
        const canonicalLegacyToken = legacy.namespace === 'default'
            ? legacyBaseToken
            : `${legacyBaseToken}:${legacy.namespace}`
        if (!constantTimeEquals(token, canonicalLegacyToken)) return null
        const workspace = this.getByDataNamespace(legacy.namespace)
        if (!workspace) return null
        const accessKeyId = randomUUID()
        this.db.query(`INSERT INTO workspace_access_keys(id,workspace_id,kind,name,token_hash,created_at,last_used_at)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET last_used_at=excluded.last_used_at`)
            .run(accessKeyId, workspace.id, 'legacy', 'Migrated CLI_API_TOKEN', tokenHash(token), now, now)
        const stored = this.db.query('SELECT id FROM workspace_access_keys WHERE token_hash=?').get(tokenHash(token)) as { id: string }
        return { workspace, accessKeyId: stored.id, kind: 'legacy' }
    }

    create(name: string): Workspace {
        return this.db.transaction(() => {
            if (this.count() >= 32) throw new Error('Workspace limit reached')
            const workspace: Workspace = { id: randomUUID(), name, dataNamespace: randomUUID(), createdAt: Date.now() }
            this.db.query('INSERT INTO workspaces(id,name,data_namespace,created_at) VALUES(?,?,?,?)')
                .run(workspace.id, workspace.name, workspace.dataNamespace, workspace.createdAt)
            return workspace
        })()
    }

    count(): number {
        return (this.db.query('SELECT COUNT(*) count FROM workspaces').get() as { count: number }).count
    }

    issueKey(workspaceId: string, kind: Exclude<WorkspaceAccessKind, 'legacy'>, name: string, expiresAt?: number | null): { id: string; token: string } {
        return this.db.transaction(() => {
            if (!this.get(workspaceId)) throw new Error('Workspace not found')
            const now = Date.now()
            const activeCount = (this.db.query(`SELECT COUNT(*) count FROM workspace_access_keys
                WHERE workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).get(workspaceId, now) as { count: number }).count
            if (activeCount >= 32) throw new Error('Workspace access key limit reached')
            const id = randomUUID()
            const prefix = kind === 'web' ? 'spw' : 'spr'
            const token = `${prefix}${randomBytes(32).toString('base64url')}`
            this.db.query(`INSERT INTO workspace_access_keys(id,workspace_id,kind,name,token_hash,created_at,expires_at)
                VALUES(?,?,?,?,?,?,?)`).run(id, workspaceId, kind, name, tokenHash(token), now, expiresAt ?? null)
            return { id, token }
        })()
    }

    listKeys(workspaceId: string): WorkspaceAccessKey[] {
        const rows = this.db.query(`SELECT id,kind,name,created_at,expires_at,last_used_at
            FROM workspace_access_keys WHERE workspace_id=? AND revoked_at IS NULL ORDER BY created_at`)
            .all(workspaceId) as Array<{ id: string; kind: WorkspaceAccessKind; name: string; created_at: number; expires_at: number | null; last_used_at: number | null }>
        return rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            name: row.name,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            lastUsedAt: row.last_used_at
        }))
    }

    isKeyActive(workspaceId: string, keyId: string, purpose: 'web' | 'runner'): boolean {
        const row = this.db.query(`SELECT kind FROM workspace_access_keys
            WHERE id=? AND workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`)
            .get(keyId, workspaceId, Date.now()) as { kind: WorkspaceAccessKind } | null
        return Boolean(row && (row.kind === 'legacy' || row.kind === purpose))
    }

    revokeKey(workspaceId: string, keyId: string): boolean {
        return this.db.query('UPDATE workspace_access_keys SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL')
            .run(Date.now(), keyId, workspaceId).changes > 0
    }
}
