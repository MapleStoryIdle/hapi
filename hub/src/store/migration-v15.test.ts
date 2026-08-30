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

describe('removed Remote Server storage', () => {
    it('does not create the removed tables or session column for a fresh database', () => {
        const store = new Store(':memory:')
        try {
            const database = (store as unknown as { db: Database }).db
            expectRemoteServerSchemaAbsent(database)
        } finally {
            store.close()
        }
    })

    it('does not recreate the removed schema while migrating a v10 database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-removed-remote-server-v10-test-'))
        const dbPath = join(dir, 'test.db')
        let initialStore: Store | undefined
        let upgradedStore: Store | undefined

        try {
            initialStore = new Store(dbPath)
            const initialDatabase = (initialStore as unknown as { db: Database }).db
            initialDatabase.exec('PRAGMA user_version = 10')
            initialStore.close()
            initialStore = undefined

            upgradedStore = new Store(dbPath)
            const upgradedDatabase = (upgradedStore as unknown as { db: Database }).db
            expectRemoteServerSchemaAbsent(upgradedDatabase)
        } finally {
            initialStore?.close()
            upgradedStore?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('leaves legacy Remote Server records untouched and inactive when reopening a database', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-removed-remote-server-test-'))
        const dbPath = join(dir, 'test.db')
        let initialStore: Store | undefined
        let reopenedStore: Store | undefined

        try {
            initialStore = new Store(dbPath)
            const database = (initialStore as unknown as { db: Database }).db
            database.exec(`
                ALTER TABLE sessions ADD COLUMN remote_server_id TEXT;
                CREATE TABLE remote_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                INSERT INTO remote_servers (id, name) VALUES ('legacy-server', 'Legacy server');
                INSERT INTO sessions (id, namespace, created_at, updated_at, seq, remote_server_id)
                VALUES ('legacy-session', 'default', 1, 1, 0, 'legacy-server');
            `)
            initialStore.close()
            initialStore = undefined

            reopenedStore = new Store(dbPath)
            const reopenedDatabase = (reopenedStore as unknown as { db: Database }).db
            expect(reopenedDatabase.prepare(
                'SELECT remote_server_id FROM sessions WHERE id = ?'
            ).get('legacy-session')).toEqual({ remote_server_id: 'legacy-server' })
            expect(reopenedDatabase.prepare(
                'SELECT name FROM remote_servers WHERE id = ?'
            ).get('legacy-server')).toEqual({ name: 'Legacy server' })
            expect('remoteServers' in reopenedStore).toBe(false)
        } finally {
            initialStore?.close()
            reopenedStore?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

function expectRemoteServerSchemaAbsent(database: Database): void {
    const tableNames = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all() as Array<{ name: string }>
    const sessionColumns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>

    expect(tableNames.map((table) => table.name)).not.toEqual(expect.arrayContaining([
        'remote_servers',
        'remote_server_connections',
        'remote_server_candidates',
        'remote_server_candidate_connections'
    ]))
    expect(sessionColumns.map((column) => column.name)).not.toContain('remote_server_id')
}
