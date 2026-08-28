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
            sessions.push(session)
            if (sessions.length >= limit) break
        }
        return sessions
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
        return session
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
