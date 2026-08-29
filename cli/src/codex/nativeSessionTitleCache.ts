import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { getCodexHomePath } from './codexHome'

const runtimeRequire = createRequire(import.meta.url)

type StateDatabaseCandidate = {
    path: string
    version: number
    modifiedAt: number
}

type CodexThreadTitleRow = {
    id: string
    title: string | null
    name?: string | null
}

export type NativeCodexSessionTitleCacheOptions = {
    getCodexHome?: () => string
    readTitles?: (databasePath: string, sessionIds: readonly string[]) => Map<string, string>
}

export type NativeCodexSessionTitleResolveOptions = {
    forceRefresh?: boolean
}

function getFileFingerprint(path: string): string {
    try {
        const stats = statSync(path)
        return `${stats.mtimeMs}:${stats.size}`
    } catch {
        return '-'
    }
}

function findLatestCodexStateDatabase(codexHome: string): string | null {
    let entries: string[]
    try {
        entries = readdirSync(codexHome)
    } catch {
        return null
    }

    const candidates: StateDatabaseCandidate[] = []
    for (const entry of entries) {
        const match = /^state_(\d+)\.sqlite$/i.exec(entry)
        if (!match) continue

        const path = join(codexHome, entry)
        try {
            const stats = statSync(path)
            if (!stats.isFile()) continue
            candidates.push({
                path,
                version: Number(match[1]),
                modifiedAt: stats.mtimeMs
            })
        } catch {
            // Codex may rotate its state database while the runner is reading it.
        }
    }

    candidates.sort((left, right) => right.version - left.version || right.modifiedAt - left.modifiedAt)
    return candidates[0]?.path ?? null
}

function getStateDatabaseFingerprint(path: string): string {
    // Codex writes this database in WAL mode. The WAL must participate in the
    // cache key or a freshly renamed native thread can retain a stale title.
    return `${path}:${getFileFingerprint(path)}:${getFileFingerprint(`${path}-wal`)}`
}

function normalizeTitle(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readCodexThreadTitles(databasePath: string, sessionIds: readonly string[]): Map<string, string> {
    if (sessionIds.length === 0) return new Map()

    let database: Database | null = null
    try {
        const { Database } = runtimeRequire('bun:sqlite') as typeof import('bun:sqlite')
        database = new Database(databasePath, { readonly: true })
        const placeholders = sessionIds.map(() => '?').join(', ')
        let rows: CodexThreadTitleRow[]
        try {
            rows = database.prepare(`
                SELECT id, title, name
                FROM threads
                WHERE id IN (${placeholders})
            `).all(...sessionIds) as CodexThreadTitleRow[]
        } catch {
            // Older Codex state schemas do not have the optional `name`
            // column. Their canonical `title` remains useful.
            rows = database.prepare(`
                SELECT id, title
                FROM threads
                WHERE id IN (${placeholders})
            `).all(...sessionIds) as CodexThreadTitleRow[]
        }

        const titles = new Map<string, string>()
        for (const row of rows) {
            const title = normalizeTitle(row.name) ?? normalizeTitle(row.title)
            if (title) titles.set(row.id, title)
        }
        return titles
    } catch {
        // Native transcript metadata is the fallback if Codex's private state
        // database is missing, busy, or changes its schema.
        return new Map()
    } finally {
        try {
            database?.close()
        } catch {
            // Ignore close failures from a concurrently replaced state file.
        }
    }
}

/**
 * Resolves Codex's own native thread title from its state database. It is
 * intentionally separate from transcript parsing: transcript `change_title`
 * calls belong to the client/tool stream and are not Codex's thread title.
 */
export class NativeCodexSessionTitleCache {
    private stateFingerprint: string | null = null
    private readonly titles = new Map<string, string | null>()

    constructor(private readonly options: NativeCodexSessionTitleCacheOptions = {}) {}

    resolve(
        sessionIds: readonly string[],
        options: NativeCodexSessionTitleResolveOptions = {}
    ): ReadonlyMap<string, string> {
        const uniqueIds = Array.from(new Set(sessionIds.map((id) => id.trim()).filter(Boolean)))
        if (uniqueIds.length === 0) return new Map()

        const databasePath = findLatestCodexStateDatabase((this.options.getCodexHome ?? getCodexHomePath)())
        const fingerprint = databasePath ? getStateDatabaseFingerprint(databasePath) : null
        if (options.forceRefresh || fingerprint !== this.stateFingerprint) {
            this.stateFingerprint = fingerprint
            this.titles.clear()
        }

        if (databasePath) {
            const unresolvedIds = uniqueIds.filter((id) => !this.titles.has(id))
            if (unresolvedIds.length > 0) {
                const resolvedTitles = (this.options.readTitles ?? readCodexThreadTitles)(databasePath, unresolvedIds)
                for (const id of unresolvedIds) {
                    this.titles.set(id, resolvedTitles.get(id) ?? null)
                }
            }
        }

        const result = new Map<string, string>()
        for (const id of uniqueIds) {
            const title = this.titles.get(id)
            if (title) result.set(id, title)
        }
        return result
    }
}
