import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { StoredArtifact } from './types'

type ArtifactRow = {
    id: string; namespace: string; token_hash: string; filename: string; size: number; sha256: string; created_at: number; expires_at: number; revoked_at: number | null
}
function row(row: ArtifactRow): StoredArtifact {
    return { id: row.id, namespace: row.namespace, tokenHash: row.token_hash, filename: row.filename, size: row.size, sha256: row.sha256, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at }
}
export class ArtifactStore {
    constructor(private readonly db: Database) {}
    create(input: Omit<StoredArtifact, 'id' | 'createdAt' | 'revokedAt'> & { id?: string; createdAt?: number }): StoredArtifact {
        const artifact: StoredArtifact = { id: input.id ?? randomUUID(), namespace: input.namespace, tokenHash: input.tokenHash, filename: input.filename, size: input.size, sha256: input.sha256, createdAt: input.createdAt ?? Date.now(), expiresAt: input.expiresAt, revokedAt: null }
        this.db.query('INSERT INTO artifacts (id, namespace, token_hash, filename, size, sha256, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(artifact.id, artifact.namespace, artifact.tokenHash, artifact.filename, artifact.size, artifact.sha256, artifact.createdAt, artifact.expiresAt)
        return artifact
    }
    findPublic(tokenHash: string, now = Date.now()): StoredArtifact | null {
        const found = this.db.query<ArtifactRow, [string, number]>('SELECT * FROM artifacts WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(tokenHash, now)
        return found ? row(found) : null
    }
    revoke(id: string, namespace: string, now = Date.now()): StoredArtifact | null {
        const found = this.db.query<ArtifactRow, [string, string]>('SELECT * FROM artifacts WHERE id = ? AND namespace = ?').get(id, namespace)
        if (!found) return null
        if (found.revoked_at === null) this.db.query('UPDATE artifacts SET revoked_at = ? WHERE id = ?').run(now, id)
        return row({ ...found, revoked_at: found.revoked_at ?? now })
    }
}
