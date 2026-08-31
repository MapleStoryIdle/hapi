import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Store V15→V16 migration: Kanban tasks', () => {
    it('backfills an immutable task row for every legacy share', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v16-test-'))
        const dbPath = join(dir, 'test.db')
        let store: Store | undefined

        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                CREATE TABLE artifacts (
                    id TEXT PRIMARY KEY,
                    namespace TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    public_url TEXT,
                    filename TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    revoked_at INTEGER
                );
                INSERT INTO artifacts (id, namespace, token_hash, filename, size, sha256, created_at, expires_at, revoked_at)
                VALUES ('legacy-task', 'default', 'token-hash', 'old.md', 1, 'content-hash', 10, 9999999999999, NULL);
                PRAGMA user_version = 15;
            `)
            db.close()

            store = new Store(dbPath)
            expect(store.kanbanTasks.find('legacy-task')).toEqual(expect.objectContaining({
                artifactId: 'legacy-task',
                namespace: 'default',
                status: 'published',
                source: null,
                feedbackTokenHash: null
            }))
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('Store V16→V17 migration: Kanban sources', () => {
    it('marks legacy source ids as HAPI sources without rewriting their id', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-migration-v17-test-'))
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
                    status TEXT NOT NULL, feedback_request TEXT, feedback_token_hash TEXT UNIQUE,
                    feedback_lease_id TEXT, feedback_lease_expires_at INTEGER, feedback_filename TEXT,
                    feedback_size INTEGER, feedback_sha256 TEXT, feedback_metadata TEXT,
                    feedback_received_at INTEGER, review_delivered_at INTEGER, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                INSERT INTO artifacts VALUES ('legacy-source', 'default', 'token', NULL, 'task.md', 1, 'hash', 1, 9999999999999, NULL);
                INSERT INTO kanban_tasks VALUES ('legacy-source', 'default', 'old-hapi-session', 'awaiting_feedback', NULL, 'feedback-token', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, 1);
                PRAGMA user_version = 16;
            `)
            db.close()
            store = new Store(dbPath)
            expect(store.kanbanTasks.find('legacy-source')).toEqual(expect.objectContaining({
                source: { type: 'hapi', sessionId: 'old-hapi-session' }
            }))
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
