import type { Database } from 'bun:sqlite'

import type { StoredPushSubscription } from './types'
import { addPushSubscription, getPushSubscriptionsByNamespace, removePushSubscription } from './pushSubscriptions'

export const BARK_SCHEMA = `CREATE TABLE IF NOT EXISTS bark_settings (
    namespace TEXT PRIMARY KEY, device_key TEXT NOT NULL, updated_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
)`

export class PushStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    addPushSubscription(namespace: string, subscription: { endpoint: string; p256dh: string; auth: string }): void {
        addPushSubscription(this.db, namespace, subscription)
    }

    removePushSubscription(namespace: string, endpoint: string): void {
        removePushSubscription(this.db, namespace, endpoint)
    }

    getPushSubscriptionsByNamespace(namespace: string): StoredPushSubscription[] {
        return getPushSubscriptionsByNamespace(this.db, namespace)
    }

    getBarkKey(namespace: string): string | null {
        const row = this.db.query('SELECT device_key FROM bark_settings WHERE namespace=?').get(namespace) as { device_key: string } | null
        return row?.device_key ?? null
    }

    isBarkEnabled(namespace: string): boolean {
        const row = this.db.query('SELECT enabled FROM bark_settings WHERE namespace=?').get(namespace) as { enabled: number } | null
        return row?.enabled === 1
    }

    setBarkEnabled(namespace: string, enabled: boolean): void {
        this.db.query('UPDATE bark_settings SET enabled=?,updated_at=? WHERE namespace=?').run(enabled ? 1 : 0, Date.now(), namespace)
    }

    setBarkKey(namespace: string, key: string | null): void {
        if (!key) { this.db.query('DELETE FROM bark_settings WHERE namespace=?').run(namespace); return }
        this.db.query('INSERT INTO bark_settings(namespace,device_key,updated_at) VALUES(?,?,?) ON CONFLICT(namespace) DO UPDATE SET device_key=excluded.device_key,updated_at=excluded.updated_at')
            .run(namespace, key, Date.now())
    }
}
