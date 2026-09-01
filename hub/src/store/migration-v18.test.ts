import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V17→V18 migration: Kanban source context', () => {
    it('adds nullable source context columns without backfilling existing tasks', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v18-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined
        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                CREATE TABLE artifacts (
                    id TEXT PRIMARY KEY, namespace TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
                    public_url TEXT, filename TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
                );
                CREATE TABLE kanban_tasks (
                    artifact_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, source_session_id TEXT,
                    source_type TEXT, source_machine_id TEXT, source_codex_session_id TEXT,
                    status TEXT NOT NULL, feedback_request TEXT, feedback_token_hash TEXT UNIQUE,
                    feedback_lease_id TEXT, feedback_lease_expires_at INTEGER, feedback_filename TEXT,
                    feedback_size INTEGER, feedback_sha256 TEXT, feedback_metadata TEXT,
                    feedback_received_at INTEGER, review_delivered_at INTEGER, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO artifacts VALUES ('legacy-task', 'default', 'token', NULL, 'task.md', 1, 'hash', 1, 9999999999999, NULL);
                INSERT INTO kanban_tasks (artifact_id, namespace, status, created_at, updated_at)
                VALUES ('legacy-task', 'default', 'published', 1, 1);
                PRAGMA user_version = 17;
            `)
            db.close()

            store = new Store(dbPath)
            expect(store.kanbanTasks.find('legacy-task')?.sourceContext).toBeNull()
            store.close()
            store = undefined

            const migrated = new Database(dbPath, { create: false, readwrite: false, strict: true })
            const columns = migrated.prepare('PRAGMA table_info(kanban_tasks)').all() as Array<{ name: string }>
            expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
                'source_directory_name',
                'source_git_branch'
            ]))
            migrated.close()
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
