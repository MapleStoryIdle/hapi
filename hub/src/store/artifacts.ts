import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { StoredArtifact } from './types'

type ArtifactRow = {
    id: string
    namespace: string
    token_hash: string
    public_url: string | null
    filename: string
    size: number
    sha256: string
    created_at: number
    expires_at: number
    revoked_at: number | null
}

function row(row: ArtifactRow): StoredArtifact {
    return {
        id: row.id,
        namespace: row.namespace,
        tokenHash: row.token_hash,
        publicUrl: row.public_url,
        filename: row.filename,
        size: row.size,
        sha256: row.sha256,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at
    }
}

type CreateArtifactInput = Omit<StoredArtifact, 'id' | 'createdAt' | 'revokedAt' | 'publicUrl'> & {
    id?: string
    createdAt?: number
    publicUrl?: string | null
}

export class ArtifactStore {
    constructor(private readonly db: Database) {}

    create(input: CreateArtifactInput): StoredArtifact {
        const artifact: StoredArtifact = {
            id: input.id ?? randomUUID(),
            namespace: input.namespace,
            tokenHash: input.tokenHash,
            publicUrl: input.publicUrl ?? null,
            filename: input.filename,
            size: input.size,
            sha256: input.sha256,
            createdAt: input.createdAt ?? Date.now(),
            expiresAt: input.expiresAt,
            revokedAt: null
        }
        this.db.query(
            'INSERT INTO artifacts (id, namespace, token_hash, public_url, filename, size, sha256, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)'
        ).run(
            artifact.id,
            artifact.namespace,
            artifact.tokenHash,
            artifact.publicUrl,
            artifact.filename,
            artifact.size,
            artifact.sha256,
            artifact.createdAt,
            artifact.expiresAt
        )
        return artifact
    }

    findPublic(tokenHash: string, now = Date.now()): StoredArtifact | null {
        const found = this.db.query<ArtifactRow, [string, number]>('SELECT * FROM artifacts WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(tokenHash, now)
        return found ? row(found) : null
    }

    listActive(namespace: string, now = Date.now()): StoredArtifact[] {
        return this.db.query<ArtifactRow, [string, number]>(
            'SELECT * FROM artifacts WHERE namespace = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at ASC'
        ).all(namespace, now).map(row)
    }

    findActive(id: string, namespace: string, now = Date.now()): StoredArtifact | null {
        const found = this.db.query<ArtifactRow, [string, string, number]>(
            'SELECT * FROM artifacts WHERE id = ? AND namespace = ? AND revoked_at IS NULL AND expires_at > ?'
        ).get(id, namespace, now)
        return found ? row(found) : null
    }

    listExpired(now = Date.now()): StoredArtifact[] {
        return this.db.query<ArtifactRow, [number]>('SELECT * FROM artifacts WHERE expires_at <= ?').all(now).map(row)
    }

    deleteExpired(id: string, now = Date.now()): boolean {
        return this.db.query('DELETE FROM artifacts WHERE id = ? AND expires_at <= ?').run(id, now).changes > 0
    }

    /** Internal rollback only: caller has just created this artifact in the same process. */
    deleteById(id: string): boolean {
        return this.db.query('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0
    }

    listCleanupCandidates(now = Date.now()): StoredArtifact[] {
        return this.db.query<ArtifactRow, [number]>(
            'SELECT * FROM artifacts WHERE revoked_at IS NOT NULL OR expires_at <= ? ORDER BY expires_at ASC'
        ).all(now).map(row)
    }

    deleteCleanupCandidate(id: string, now = Date.now()): boolean {
        return this.db.query(
            'DELETE FROM artifacts WHERE id = ? AND (revoked_at IS NOT NULL OR expires_at <= ?)'
        ).run(id, now).changes > 0
    }

    revokeActive(id: string, namespace: string, now = Date.now()): StoredArtifact | null {
        const found = this.db.query<ArtifactRow, [string, string, number]>(
            'SELECT * FROM artifacts WHERE id = ? AND namespace = ? AND revoked_at IS NULL AND expires_at > ?'
        ).get(id, namespace, now)
        if (!found) return null

        const updated = this.db.query(
            'UPDATE artifacts SET revoked_at = ? WHERE id = ? AND namespace = ? AND revoked_at IS NULL AND expires_at > ?'
        ).run(now, id, namespace, now)
        if (updated.changes !== 1) return null

        return row({ ...found, revoked_at: now })
    }
}
