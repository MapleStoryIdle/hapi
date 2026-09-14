import type { Database } from 'bun:sqlite'

export const PLUGIN_SETTINGS_SCHEMA = `CREATE TABLE IF NOT EXISTS plugin_settings (
    namespace TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, plugin_id)
)`

export class PluginSettingsStore {
    constructor(private readonly db: Database) {}

    isEnabled(namespace: string, pluginId: string): boolean {
        const row = this.db.query(
            'SELECT enabled FROM plugin_settings WHERE namespace=? AND plugin_id=?'
        ).get(namespace, pluginId) as { enabled: number } | null
        return row?.enabled !== 0
    }

    setEnabled(namespace: string, pluginId: string, enabled: boolean): void {
        this.db.query(`
            INSERT INTO plugin_settings(namespace, plugin_id, enabled, updated_at)
            VALUES(?,?,?,?)
            ON CONFLICT(namespace, plugin_id) DO UPDATE SET
                enabled=excluded.enabled,
                updated_at=excluded.updated_at
        `).run(namespace, pluginId, enabled ? 1 : 0, Date.now())
    }
}
