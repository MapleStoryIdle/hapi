import { execFile } from 'node:child_process'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SKIP_DIRECTORIES = new Set([
    'node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'coverage',
    'bower_components', '__pycache__', 'venv', 'env', 'tmp', 'temp'
])
const MAX_ENTRIES = 512
const MAX_REPOSITORIES = 32
const SCAN_BUDGET_MS = 2_000
const CACHE_TTL_MS = 5 * 60_000
const MAX_CACHE_ENTRIES = 128
const MAX_PENDING_SCANS = 6
const MAX_ACTIVE_SCANS = 2

export type ChildRepositoryScan = {
    childRepositories: Array<{ name: string; cwd: string }>
    childRepositoriesTruncated?: boolean
    childRepositoriesError?: string
}

/** A bounded, nonrecursive scan. Never follow child directories or .git symlinks. */
export async function scanDirectChildRepositories(cwd: string): Promise<ChildRepositoryScan> {
    const result: ChildRepositoryScan = { childRepositories: [] }
    const deadline = Date.now() + SCAN_BUDGET_MS
    let inspected = 0
    try {
        const directory = await opendir(cwd)
        for await (const entry of directory) {
            if (inspected++ >= MAX_ENTRIES || Date.now() >= deadline || result.childRepositories.length >= MAX_REPOSITORIES) {
                result.childRepositoriesTruncated = true
                break
            }
            if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
            const child = join(cwd, entry.name)
            let markerFound = false
            try {
                // Recheck after reading the entry to reject replaced symlinks.
                if (!(await lstat(child)).isDirectory()) continue
                const marker = await lstat(join(child, '.git'))
                if (!marker.isDirectory() && !marker.isFile()) continue
                markerFound = true
                const remaining = deadline - Date.now()
                if (remaining <= 0) { result.childRepositoriesTruncated = true; break }
                const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
                    cwd: child,
                    timeout: Math.min(1_000, remaining),
                    maxBuffer: 64 * 1024,
                    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
                })
                if (await realpath(stdout.trim()) !== await realpath(child)) continue
                result.childRepositories.push({ name: entry.name, cwd: child })
            } catch (error) {
                if (!markerFound && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
                result.childRepositoriesError = 'Some child directories could not be inspected'
            }
        }
    } catch {
        result.childRepositoriesError = 'Child directories could not be inspected'
    }
    result.childRepositories.sort((a, b) => a.name.localeCompare(b.name))
    return result
}

/** Runner-wide inventory cache, not branch/status cache. Queue and memory bounded. */
export class GitChildRepositoryCache {
    private readonly cached = new Map<string, { expiresAt: number; value: ChildRepositoryScan }>()
    private readonly pending = new Map<string, Promise<ChildRepositoryScan>>()
    private readonly waiting: Array<() => void> = []
    private active = 0

    constructor(
        private readonly scan: (cwd: string) => Promise<ChildRepositoryScan> = scanDirectChildRepositories,
        private readonly now: () => number = Date.now
    ) {}

    get(cwd: string): Promise<ChildRepositoryScan> {
        const key = resolve(cwd)
        const existing = this.cached.get(key)
        if (existing && existing.expiresAt > this.now()) return Promise.resolve(existing.value)
        this.cached.delete(key)
        const pending = this.pending.get(key)
        if (pending) return pending
        if (this.pending.size >= MAX_PENDING_SCANS) {
            return Promise.resolve({ childRepositories: [], childRepositoriesError: 'Child repository scan is busy; retry shortly' })
        }
        const task = this.run(key).finally(() => { this.pending.delete(key) })
        this.pending.set(key, task)
        return task
    }

    private async run(cwd: string): Promise<ChildRepositoryScan> {
        if (this.active >= MAX_ACTIVE_SCANS) await new Promise<void>(resolve => { this.waiting.push(resolve) })
        else this.active++
        try {
            const value = await this.scan(cwd)
            // Transient failures are retried, never cached as five-minute facts.
            if (!value.childRepositoriesError) {
                if (this.cached.size >= MAX_CACHE_ENTRIES) {
                    const oldest = this.cached.keys().next().value
                    if (oldest !== undefined) this.cached.delete(oldest)
                }
                this.cached.set(cwd, { expiresAt: this.now() + CACHE_TTL_MS, value })
            }
            return value
        } catch {
            return { childRepositories: [], childRepositoriesError: 'Child directories could not be inspected' }
        } finally {
            const next = this.waiting.shift()
            if (next) next()
            else this.active--
        }
    }
}

export const runnerGitChildRepositoryCache = new GitChildRepositoryCache()
