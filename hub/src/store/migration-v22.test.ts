import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from './index'

describe('Bark enabled migration', () => {
    it('preserves old keys, defaults enabled and persists disabling across restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-bark-v22-'))
        const path = join(dir, 'test.db')
        let store: Store | undefined
        try {
            store = new Store(path)
            store.close()
            store = undefined
            const db = new Database(path)
            db.exec(`DROP TABLE bark_settings;
                CREATE TABLE bark_settings(namespace TEXT PRIMARY KEY, device_key TEXT NOT NULL, updated_at INTEGER NOT NULL);
                INSERT INTO bark_settings VALUES ('a','TEST_KEY',1);
                PRAGMA user_version=21;`)
            db.close()
            store = new Store(path)
            expect(store.push.isBarkEnabled('a')).toBe(true)
            store.push.setBarkEnabled('a', false)
            expect(store.push.getBarkKey('a')).toBe('TEST_KEY')
            expect(store.push.getBarkKey('b')).toBeNull()
            store.close()
            store = new Store(path)
            expect(store.push.isBarkEnabled('a')).toBe(false)
            expect(store.push.getBarkKey('a')).toBe('TEST_KEY')
            store.push.setBarkEnabled('a', true)
            expect(store.push.isBarkEnabled('a')).toBe(true)
        } finally {
            store?.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
