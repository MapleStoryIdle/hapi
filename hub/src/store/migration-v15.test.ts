import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V14→V15 migration: share public URL', () => {
    it('adds a nullable public_url column without changing legacy shares', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v15-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined

        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                CREATE TABLE artifacts (
                    id TEXT PRIMARY KEY,
                    namespace TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    filename TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    revoked_at INTEGER
                );
                INSERT INTO artifacts (id, namespace, token_hash, filename, size, sha256, created_at, expires_at, revoked_at)
                VALUES ('legacy', 'default', 'token-hash', 'old.txt', 1, 'content-hash', 1, 9999999999999, NULL);
                PRAGMA user_version = 14;
            `)
            db.close()

            store = new Store(dbPath)

            const legacy = store.artifacts.findActive('legacy', 'default')
            expect(legacy?.publicUrl).toBeNull()

            const database = (store as unknown as { db: Database }).db
            const columns = database.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>
            expect(columns.map((column) => column.name)).toContain('public_url')
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
