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

    /** Deletes the artifact record; the database cascades its Kanban task. */
    deleteById(id: string): boolean {
        return this.db.query('DELETE FROM artifacts WHERE id = ?').run(id).changes > 0
    }

    /**
     * Claim an artifact for owner-requested deletion before touching disk.
     * A revocation blocks public reads and one-time feedback uploads while the
     * caller removes both blobs. Already-revoked rows are returned so an
     * explicit retry can finish an interrupted deletion; expiry is irrelevant
     * because it only controls public-link access, not data retention.
     */
    markForDeletion(id: string, namespace: string, now = Date.now()): StoredArtifact | null {
        const found = this.db.query<ArtifactRow, [string, string]>(
            'SELECT * FROM artifacts WHERE id = ? AND namespace = ?'
        ).get(id, namespace)
        if (!found) return null

        if (found.revoked_at !== null) return row(found)

        const updated = this.db.query(
            'UPDATE artifacts SET revoked_at = ? WHERE id = ? AND namespace = ? AND revoked_at IS NULL'
        ).run(now, id, namespace)
        if (updated.changes !== 1) {
            const retried = this.db.query<ArtifactRow, [string, string]>(
                'SELECT * FROM artifacts WHERE id = ? AND namespace = ?'
            ).get(id, namespace)
            return retried ? row(retried) : null
        }

        return row({ ...found, revoked_at: now })
    }
}
