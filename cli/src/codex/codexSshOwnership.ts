import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getCodexHomePath } from './codexHome'
import { CodexSshAppServerClient } from './codexSshAppServerClient'

const DEFAULT_CACHE_TTL_MS = 1_000
const DEFAULT_FAILURE_GRACE_MS = 3_000
const DEFAULT_TIMEOUT_MS = 750

export type CodexSshOwnershipProbeOptions = {
    /** Windows Desktop SSH does not expose this Unix-domain control endpoint. */
    platform?: NodeJS.Platform
    now?: () => number
    cacheTtlMs?: number
    failureGraceMs?: number
    timeoutMs?: number
    getSocketPath?: () => string
    socketExists?: (path: string) => boolean
    /** Test seam; `null` means the optional endpoint could not be read. */
    loadHeldSessionIds?: (input: { socketPath: string; timeoutMs: number }) => Promise<ReadonlySet<string> | null>
}

type OwnershipCache = {
    heldSessionIds: ReadonlySet<string>
    expiresAt: number
}

type LastSuccessfulOwnershipRead = {
    heldSessionIds: ReadonlySet<string>
    checkedAt: number
}

function emptySet(): ReadonlySet<string> {
    return new Set<string>()
}

function normalizeSessionIds(sessionIds: ReadonlySet<string>): ReadonlySet<string> {
    const normalized = new Set<string>()
    for (const sessionId of sessionIds) {
        const id = typeof sessionId === 'string' ? sessionId.trim() : ''
        if (id && id.length <= 512) normalized.add(id)
    }
    return normalized
}

export function getCodexSshControlSocketPath(): string {
    return join(getCodexHomePath(), 'app-server-control', 'app-server-control.sock')
}

/**
 * `thread/loaded/list` is intentionally the only Desktop SSH RPC used here.
 * Its result contains thread ids but no transcript body or control handle.
 */
export function parseCodexSshLoadedThreadIds(value: unknown): ReadonlySet<string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySet()
    const data = (value as { data?: unknown }).data
    if (!Array.isArray(data)) return emptySet()

    const ids = new Set<string>()
    for (const candidate of data) {
        if (typeof candidate !== 'string') continue
        const id = candidate.trim()
        if (id && id.length <= 512) ids.add(id)
    }
    return ids
}

function isLoadedThreadListResult(value: unknown): value is { data: unknown[] } {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { data?: unknown }).data))
}

/**
 * Reads the optional Desktop SSH app-server without starting it. The transport
 * is transient: the final disconnect closes only this probe's WebSocket.
 */
export async function loadCodexSshHeldSessionIds(input: {
    socketPath: string
    timeoutMs?: number
}): Promise<ReadonlySet<string> | null> {
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const client = new CodexSshAppServerClient({
        socketPath: input.socketPath,
        connectTimeoutMs: timeoutMs,
        requestTimeoutMs: timeoutMs
    })
    let timeout: ReturnType<typeof setTimeout> | null = null

    try {
        const read = (async () => {
            await client.connect()
            await client.initialize({
                clientInfo: { name: 'hapi-ssh-ownership-probe', version: '1.0.0' },
                capabilities: { experimentalApi: true }
            })
            const result = await client.request('thread/loaded/list', {}, { timeoutMs })
            return isLoadedThreadListResult(result) ? parseCodexSshLoadedThreadIds(result) : null
        })()
        const deadline = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                void client.disconnect()
                reject(new Error(`Timed out reading Codex SSH ownership after ${timeoutMs}ms`))
            }, timeoutMs)
            timeout.unref?.()
        })
        return await Promise.race([read, deadline])
    } catch {
        return null
    } finally {
        if (timeout) clearTimeout(timeout)
        await client.disconnect().catch(() => {})
    }
}

/**
 * Short-lived ownership cache. A missing optional endpoint releases a stale
 * lock; a transient failed read preserves the most recently observed lock for
 * a bounded grace period so an SSH-controlled thread is never spuriously
 * re-enabled during a local socket hiccup.
 */
export class CodexSshSessionOwnershipProbe {
    private readonly platform: NodeJS.Platform
    private readonly now: () => number
    private readonly cacheTtlMs: number
    private readonly failureGraceMs: number
    private readonly timeoutMs: number
    private readonly getSocketPath: () => string
    private readonly socketExists: (path: string) => boolean
    private readonly loadHeldSessionIds: (input: { socketPath: string; timeoutMs: number }) => Promise<ReadonlySet<string> | null>
    private cache: OwnershipCache | null = null
    private lastSuccessfulRead: LastSuccessfulOwnershipRead | null = null
    private inFlight: Promise<ReadonlySet<string>> | null = null

    constructor(options: CodexSshOwnershipProbeOptions = {}) {
        this.platform = options.platform ?? process.platform
        this.now = options.now ?? Date.now
        this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
        this.failureGraceMs = Math.max(0, options.failureGraceMs ?? Math.max(DEFAULT_FAILURE_GRACE_MS, this.cacheTtlMs * 3))
        this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        this.getSocketPath = options.getSocketPath ?? getCodexSshControlSocketPath
        this.socketExists = options.socketExists ?? existsSync
        this.loadHeldSessionIds = options.loadHeldSessionIds ?? loadCodexSshHeldSessionIds
    }

    getCachedHeldSessionIds(): ReadonlySet<string> {
        return new Set(this.cache?.heldSessionIds ?? [])
    }

    async isHeld(sessionId: string, options: { forceRefresh?: boolean } = {}): Promise<boolean> {
        const id = sessionId.trim()
        if (!id) return false
        return (await this.getHeldSessionIds(options)).has(id)
    }

    async getHeldSessionIds(options: { forceRefresh?: boolean } = {}): Promise<ReadonlySet<string>> {
        const now = this.now()
        if (!options.forceRefresh && this.cache && this.cache.expiresAt > now) {
            return new Set(this.cache.heldSessionIds)
        }
        if (this.inFlight) return await this.inFlight

        const request = this.refresh()
        this.inFlight = request
        try {
            return await request
        } finally {
            if (this.inFlight === request) this.inFlight = null
        }
    }

    private setCache(heldSessionIds: ReadonlySet<string>): ReadonlySet<string> {
        const normalized = normalizeSessionIds(heldSessionIds)
        this.cache = {
            heldSessionIds: normalized,
            expiresAt: this.now() + this.cacheTtlMs
        }
        return new Set(normalized)
    }

    private async refresh(): Promise<ReadonlySet<string>> {
        let result: ReadonlySet<string> | null = null
        let definitive = false

        if (this.platform === 'win32') {
            result = emptySet()
            definitive = true
        } else {
            try {
                const socketPath = this.getSocketPath()
                if (!socketPath || !this.socketExists(socketPath)) {
                    // Absence is a real release signal, unlike a failed read.
                    result = emptySet()
                    definitive = true
                } else {
                    result = await this.loadHeldSessionIds({ socketPath, timeoutMs: this.timeoutMs })
                    definitive = result !== null
                }
            } catch {
                // The optional endpoint is versioned separately. Preserve a
                // recent known lock rather than falsely re-enabling a session.
            }
        }

        if (definitive && result !== null) {
            const normalized = normalizeSessionIds(result)
            this.lastSuccessfulRead = {
                heldSessionIds: normalized,
                checkedAt: this.now()
            }
            return this.setCache(normalized)
        }

        const now = this.now()
        const preserved = this.lastSuccessfulRead
            && now - this.lastSuccessfulRead.checkedAt <= this.failureGraceMs
            ? this.lastSuccessfulRead.heldSessionIds
            : emptySet()
        return this.setCache(preserved)
    }
}
