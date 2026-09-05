import { existsSync, statSync } from 'node:fs'
import {
    isHapiInitiatedCodexSession,
    listCodexTranscriptFilesByRecency,
    readLocalCodexSessionSummary,
    type CodexLocalSessionListOptions,
    type CodexLocalSessionSummary,
    type CodexTranscriptFileCandidate
} from '@hapi/protocol/codexTranscript'

type CachedSummary = {
    modifiedAt: number
    size: number
    session: CodexLocalSessionSummary | null
}

export type NativeCodexSessionListCacheOptions = {
    listFiles?: () => CodexTranscriptFileCandidate[]
    readSummary?: (filePath: string, modifiedAt?: number, size?: number) => CodexLocalSessionSummary | null
    resolveTitles?: (sessionIds: readonly string[], options: { forceRefresh?: boolean }) => ReadonlyMap<string, string>
    applyLifecycle?: (session: CodexLocalSessionSummary) => CodexLocalSessionSummary
}

/**
 * Runner-local index for native Codex list rows. It scans the transcript tree
 * once, then reuses row summaries until the watcher reports a file change.
 * Message bodies deliberately remain outside this cache.
 */
export class NativeCodexSessionListCache {
    private candidates: CodexTranscriptFileCandidate[] = []
    private readonly summaries = new Map<string, CachedSummary>()
    private initialized = false

    constructor(private readonly options: NativeCodexSessionListCacheOptions = {}) {}

    /**
     * Drop the runner-local discovery snapshot after a Codex-owned lifecycle
     * operation such as `thread/archive`. The next list request rescans the
     * source directory instead of serving a row whose transcript moved.
     */
    invalidate(): void {
        this.candidates = []
        this.summaries.clear()
        this.initialized = false
    }

    list(
        limit: number,
        options: CodexLocalSessionListOptions = {},
        cacheOptions: { forceRefresh?: boolean } = {}
    ): CodexLocalSessionSummary[] {
        if (limit <= 0) return []
        if (cacheOptions.forceRefresh) {
            this.refresh()
        } else {
            this.ensureInitialized()
        }

        const sessions: CodexLocalSessionSummary[] = []
        const seenSessionIds = new Set<string>()
        for (const candidate of this.candidates) {
            const session = this.getOrReadSummary(candidate)
            if (!session || seenSessionIds.has(session.id)) continue
            if (options.excludeHapiInitiated && isHapiInitiatedCodexSession(session)) continue
            seenSessionIds.add(session.id)
            sessions.push(this.applyLifecycle(session))
            if (sessions.length >= limit) break
        }
        return this.applyCodexTitles(sessions, cacheOptions.forceRefresh)
    }

    /** Apply one watcher invalidation without rereading unrelated transcripts. */
    update(filePath: string, modifiedAt: number): CodexLocalSessionSummary | null {
        this.ensureInitialized()

        let candidate: CodexTranscriptFileCandidate
        try {
            const stats = statSync(filePath)
            candidate = {
                file: filePath,
                modifiedAt: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : modifiedAt,
                size: stats.size
            }
        } catch {
            this.invalidateCandidate(filePath)
            return null
        }

        this.upsertCandidate(candidate)

        const session = this.readSummary(candidate)
        this.summaries.set(filePath, {
            modifiedAt: candidate.modifiedAt,
            size: candidate.size,
            session
        })
        return session ? this.applyLifecycle(this.applyCodexTitles([session])[0] ?? session) : null
    }

    private ensureInitialized(): void {
        if (this.initialized) return
        this.refresh()
    }

    private refresh(): void {
        const next = this.getListFiles()
            .map((candidate) => ({ ...candidate }))
            .sort((left, right) => right.modifiedAt - left.modifiedAt || left.file.localeCompare(right.file))
        const nextByFile = new Map(next.map((candidate) => [candidate.file, candidate]))

        for (const [filePath, cached] of this.summaries) {
            const candidate = nextByFile.get(filePath)
            if (!candidate || candidate.modifiedAt !== cached.modifiedAt || candidate.size !== cached.size) {
                this.summaries.delete(filePath)
            }
        }
        this.candidates = next
        this.initialized = true
    }

    private getOrReadSummary(candidate: CodexTranscriptFileCandidate): CodexLocalSessionSummary | null {
        // A watcher can miss a final write or temporarily stop watching a cold
        // thread. Never let its discovery snapshot freeze the list run state.
        try {
            const stats = statSync(candidate.file)
            candidate.modifiedAt = stats.mtimeMs
            candidate.size = stats.size
        } catch {
            this.summaries.delete(candidate.file)
            return null
        }
        const cached = this.summaries.get(candidate.file)
        if (cached && cached.modifiedAt === candidate.modifiedAt && cached.size === candidate.size) {
            return cached.session
        }

        const session = this.readSummary(candidate)
        this.summaries.set(candidate.file, {
            modifiedAt: candidate.modifiedAt,
            size: candidate.size,
            session
        })
        return session
    }

    private readSummary(candidate: CodexTranscriptFileCandidate): CodexLocalSessionSummary | null {
        return (this.options.readSummary ?? readLocalCodexSessionSummary)(
            candidate.file,
            candidate.modifiedAt,
            candidate.size
        )
    }

    private applyCodexTitles(
        sessions: CodexLocalSessionSummary[],
        forceRefresh?: boolean
    ): CodexLocalSessionSummary[] {
        const titles = this.options.resolveTitles?.(
            sessions.map((session) => session.id),
            { forceRefresh }
        )
        if (!titles?.size) return sessions

        return sessions.map((session) => {
            const title = titles.get(session.id)
            return title && title !== session.title ? { ...session, title } : session
        })
    }

    private applyLifecycle(session: CodexLocalSessionSummary): CodexLocalSessionSummary {
        return this.options.applyLifecycle?.(session) ?? session
    }

    private getListFiles(): CodexTranscriptFileCandidate[] {
        return (this.options.listFiles ?? listCodexTranscriptFilesByRecency)()
    }

    private upsertCandidate(candidate: CodexTranscriptFileCandidate): void {
        const index = this.candidates.findIndex((current) => current.file === candidate.file)
        if (index === -1) {
            this.candidates.push(candidate)
        } else {
            this.candidates[index] = candidate
        }
        this.candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || left.file.localeCompare(right.file))
    }

    private invalidateCandidate(filePath: string): void {
        this.summaries.delete(filePath)
        if (!existsSync(filePath)) {
            this.candidates = this.candidates.filter((candidate) => candidate.file !== filePath)
        }
    }
}
