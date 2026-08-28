import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import {
    appendCodexTranscriptImportLines,
    createCodexTranscriptImportAccumulator,
    createLocalCodexSessionData,
    findLocalCodexSession,
    getCodexTranscriptTailSummary,
    type CodexImportedMessageContent,
    type CodexLocalSessionData,
    type CodexLocalSessionReadOptions,
    type CodexLocalSessionReadTiming,
    type CodexLocalSessionSummary,
    type CodexTranscriptImportAccumulator
} from '@hapi/protocol/codexTranscript'

type FileFingerprint = {
    size: number
    modifiedAt: number
    dev: number
    ino: number
}

type CacheEntry = {
    session: CodexLocalSessionSummary
    importedMessages: CodexImportedMessageContent[] | null
    accumulator: CodexTranscriptImportAccumulator | null
    trailingBytes: Buffer
    fileSize: number
    fingerprint: FileFingerprint | null
}

type ResolvedEntry = {
    entry: CacheEntry
    cacheMiss: boolean
}

type CompleteLines = {
    lines: string[]
    trailingBytes: Buffer
}

export type NativeCodexTranscriptRead = {
    data: CodexLocalSessionData
    revision: number
    timing: CodexLocalSessionReadTiming
}

function getFileFingerprint(file: string): FileFingerprint | null {
    try {
        const stat = statSync(file)
        return {
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            dev: stat.dev,
            ino: stat.ino
        }
    } catch {
        return null
    }
}

function isSameFile(left: FileFingerprint | null, right: FileFingerprint): boolean {
    return left?.dev === right.dev && left.ino === right.ino
}

function splitCompleteJsonlLines(bytes: Buffer): CompleteLines {
    const lastNewline = bytes.lastIndexOf(0x0a)
    const completeBytes = lastNewline === -1 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline)
    let trailingBytes = lastNewline === -1 ? Buffer.from(bytes) : Buffer.from(bytes.subarray(lastNewline + 1))
    const lines = completeBytes.length > 0 ? completeBytes.toString('utf8').split('\n').filter(Boolean) : []

    // Codex normally terminates each JSONL record, but accepting a final
    // complete record makes reads correct for an app that has not flushed its
    // last newline yet. Invalid bytes stay buffered for the next append.
    if (trailingBytes.length > 0) {
        const lastLine = trailingBytes.toString('utf8')
        try {
            JSON.parse(lastLine)
            lines.push(lastLine)
            trailingBytes = Buffer.alloc(0)
        } catch {
            // Partial or malformed final line; retry when the file grows.
        }
    }

    return { lines, trailingBytes }
}

function readFileRange(file: string, offset: number, length: number): Buffer | null {
    if (length <= 0) return Buffer.alloc(0)
    let descriptor: number | null = null
    try {
        descriptor = openSync(file, 'r')
        const bytes = Buffer.allocUnsafe(length)
        const bytesRead = readSync(descriptor, bytes, 0, length, offset)
        return Buffer.from(bytes.subarray(0, bytesRead))
    } catch {
        return null
    } finally {
        if (descriptor !== null) {
            try {
                closeSync(descriptor)
            } catch {
                // The transcript read has already failed or completed.
            }
        }
    }
}

function applyTailSummary(session: CodexLocalSessionSummary, lines: readonly string[], fingerprint: FileFingerprint): CodexLocalSessionSummary {
    const tail = getCodexTranscriptTailSummary(lines)
    return {
        ...session,
        modifiedAt: fingerprint.modifiedAt,
        ...(tail.title === undefined ? {} : { title: tail.title }),
        ...(tail.lastUserMessage === undefined ? {} : { lastUserMessage: tail.lastUserMessage }),
        ...(tail.model === undefined ? {} : { model: tail.model }),
        ...(tail.modelReasoningEffort === undefined ? {} : { modelReasoningEffort: tail.modelReasoningEffort }),
        ...(tail.runState === undefined ? {} : { runState: tail.runState })
    }
}

/**
 * Keeps recently viewed native transcripts in runner memory. After the first
 * read, normal status/context requests only stat the JSONL. When Codex appends
 * a record, the cache reads the new byte range and advances its parser state
 * instead of reparsing the full transcript.
 */
export class NativeCodexTranscriptCache {
    private readonly entries = new Map<string, CacheEntry>()
    private readonly revisions = new Map<string, number>()

    constructor(
        // Match the watcher’s observed-thread window so parsed message bodies
        // cannot accumulate for every historical Codex transcript.
        private readonly maxEntries = 16,
        private readonly now: () => number = Date.now
    ) {}

    has(sessionId: string): boolean {
        return this.entries.has(sessionId)
    }

    getSummary(sessionId: string): CodexLocalSessionSummary | null {
        return this.resolveEntry(sessionId)?.entry.session ?? null
    }

    read(sessionId: string, options: CodexLocalSessionReadOptions = {}): NativeCodexTranscriptRead | null {
        return this.readInternal(sessionId, options, false, true)
    }

    readCached(sessionId: string, options: CodexLocalSessionReadOptions = {}): NativeCodexTranscriptRead | null {
        if (!this.entries.has(sessionId)) {
            return null
        }
        return this.readInternal(sessionId, options, false, false)
    }

    /**
     * Advance a transcript that the watcher just changed, but only if a
     * browser/direct-send path has already made it hot in this cache.
     */
    refreshCached(sessionId: string, options: CodexLocalSessionReadOptions = {}): NativeCodexTranscriptRead | null {
        if (!this.entries.has(sessionId)) {
            return null
        }
        return this.readInternal(sessionId, options, true, false)
    }

    private readInternal(
        sessionId: string,
        options: CodexLocalSessionReadOptions,
        forceRefresh: boolean,
        allowColdLoad: boolean
    ): NativeCodexTranscriptRead | null {
        const startedAt = this.now()
        const resolved = this.resolveEntry(sessionId, {
            forceRefresh,
            allowColdLoad
        })
        if (!resolved) {
            return null
        }

        let { entry } = resolved
        let cacheMiss = resolved.cacheMiss
        if (entry.importedMessages === null) {
            entry = this.loadImportedMessages(sessionId, entry)
            cacheMiss = true
        }

        return {
            data: createLocalCodexSessionData(entry.session, entry.importedMessages ?? [], options),
            revision: this.revisions.get(sessionId) ?? 1,
            timing: {
                cache: cacheMiss ? 'miss' : 'hit',
                durationMs: Math.max(0, this.now() - startedAt)
            }
        }
    }

    private resolveEntry(sessionId: string, options: { forceRefresh?: boolean; allowColdLoad?: boolean } = {}): ResolvedEntry | null {
        const current = this.entries.get(sessionId)
        const fingerprint = current ? getFileFingerprint(current.session.file) : null
        const changed =
            current &&
            (!fingerprint ||
                !isSameFile(current.fingerprint, fingerprint) ||
                current.fileSize !== fingerprint.size ||
                current.session.modifiedAt !== fingerprint.modifiedAt)

        if (current && !changed && !options.forceRefresh) {
            this.touch(sessionId, current)
            return { entry: current, cacheMiss: false }
        }

        if (current && fingerprint && isSameFile(current.fingerprint, fingerprint) && fingerprint.size > current.fileSize) {
            const advanced = this.advanceAppendedEntry(current, fingerprint)
            if (advanced) {
                this.setEntry(sessionId, advanced)
                this.bumpRevision(sessionId)
                return { entry: advanced, cacheMiss: true }
            }
        }

        // A watcher can race its own stat update. There is no reason to throw
        // away a warm parse when the file did not actually change.
        if (current && !changed) {
            this.touch(sessionId, current)
            return { entry: current, cacheMiss: false }
        }

        if (!current && options.allowColdLoad === false) {
            return null
        }

        // Truncation, replacement, or an in-place rewrite cannot be proven to
        // be append-only. Rebuild once; subsequent writes return to byte-tail
        // reads.
        const session = findLocalCodexSession(sessionId)
        if (!session) {
            this.entries.delete(sessionId)
            return null
        }
        const nextFingerprint = getFileFingerprint(session.file)
        const entry: CacheEntry = {
            session: nextFingerprint ? { ...session, modifiedAt: nextFingerprint.modifiedAt } : session,
            importedMessages: null,
            accumulator: null,
            trailingBytes: Buffer.alloc(0),
            fileSize: nextFingerprint?.size ?? 0,
            fingerprint: nextFingerprint
        }
        this.setEntry(sessionId, entry)
        this.bumpRevision(sessionId)
        return { entry, cacheMiss: true }
    }

    private advanceAppendedEntry(entry: CacheEntry, fingerprint: FileFingerprint): CacheEntry | null {
        const appendedBytes = readFileRange(entry.session.file, entry.fileSize, fingerprint.size - entry.fileSize)
        if (appendedBytes === null) {
            return null
        }

        const parsed = splitCompleteJsonlLines(Buffer.concat([entry.trailingBytes, appendedBytes]))
        if (entry.accumulator) {
            appendCodexTranscriptImportLines(entry.accumulator, parsed.lines)
        }
        return {
            ...entry,
            session: applyTailSummary(entry.session, parsed.lines, fingerprint),
            importedMessages: entry.accumulator?.messages ?? null,
            trailingBytes: parsed.trailingBytes,
            fileSize: entry.fileSize + appendedBytes.length,
            fingerprint
        }
    }

    private loadImportedMessages(sessionId: string, entry: CacheEntry): CacheEntry {
        let contents: Buffer
        try {
            contents = readFileSync(entry.session.file)
        } catch {
            const empty: CacheEntry = {
                ...entry,
                importedMessages: [],
                accumulator: createCodexTranscriptImportAccumulator(),
                trailingBytes: Buffer.alloc(0)
            }
            this.setEntry(sessionId, empty)
            return empty
        }

        const parsed = splitCompleteJsonlLines(contents)
        const accumulator = createCodexTranscriptImportAccumulator()
        appendCodexTranscriptImportLines(accumulator, parsed.lines)
        const fingerprint = getFileFingerprint(entry.session.file)
        const next: CacheEntry = {
            ...entry,
            session: fingerprint ? applyTailSummary(entry.session, parsed.lines, fingerprint) : entry.session,
            importedMessages: accumulator.messages,
            accumulator,
            trailingBytes: parsed.trailingBytes,
            fileSize: contents.length,
            fingerprint
        }
        this.setEntry(sessionId, next)
        return next
    }

    private bumpRevision(sessionId: string): void {
        this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1)
    }

    private setEntry(sessionId: string, entry: CacheEntry): void {
        this.entries.delete(sessionId)
        this.entries.set(sessionId, entry)
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value
            if (!oldest) break
            this.entries.delete(oldest)
        }
    }

    private touch(sessionId: string, entry: CacheEntry): void {
        this.entries.delete(sessionId)
        this.entries.set(sessionId, entry)
    }
}
