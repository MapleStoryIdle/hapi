import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import {
    appendCodexTranscriptImportLines,
    createCodexTranscriptImportAccumulator,
    createLocalCodexSessionData,
    findLocalCodexSession,
    getCodexTranscriptLifecycleEvents,
    getCodexTranscriptTailSummary,
    type CodexImportedMessageContent,
    type CodexLocalSessionData,
    type CodexLocalSessionReadOptions,
    type CodexLocalSessionReadTiming,
    type CodexLocalSessionSummary,
    type CodexTranscriptImportAccumulator,
    type CodexTranscriptLifecycleEvent
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
    lifecycleEvents: CodexTranscriptLifecycleEvent[]
}

type ResolvedEntry = {
    entry: CacheEntry
    cacheMiss: boolean
}

type CompleteLines = {
    lines: string[]
    trailingBytes: Buffer
}

type RecentLifecycleTail = {
    lifecycleEvents: CodexTranscriptLifecycleEvent[]
    trailingBytes: Buffer
}

export type NativeCodexTranscriptRead = {
    data: CodexLocalSessionData
    revision: number
    timing: CodexLocalSessionReadTiming
    /** Bounded raw lifecycle records for the runner-local turn tracker. */
    lifecycleEvents: readonly CodexTranscriptLifecycleEvent[]
}

export type NativeCodexTranscriptSummaryRead = {
    session: CodexLocalSessionSummary
    lifecycleEvents: readonly CodexTranscriptLifecycleEvent[]
}

export type NativeCodexTranscriptCacheOptions = {
    maxEntries?: number
    now?: () => number
    applyLifecycle?: (session: CodexLocalSessionSummary) => CodexLocalSessionSummary
}

const MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT = 128
// A cold session only needs the latest turn terminal/start records. Full
// message history is loaded later, when the user actually opens the detail.
const LIFECYCLE_TAIL_READ_BYTES = 16 * 1024

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
    private readonly maxEntries: number
    private readonly now: () => number
    private readonly applyLifecycle: ((session: CodexLocalSessionSummary) => CodexLocalSessionSummary) | null

    constructor(options: NativeCodexTranscriptCacheOptions = {}) {
        // Match the watcher’s observed-thread window so parsed message bodies
        // cannot accumulate for every historical Codex transcript.
        this.maxEntries = options.maxEntries ?? 16
        this.now = options.now ?? Date.now
        this.applyLifecycle = options.applyLifecycle ?? null
    }

    has(sessionId: string): boolean {
        return this.entries.has(sessionId)
    }

    /** Evict a thread moved by Codex's native archive operation. */
    evict(sessionId: string): void {
        this.entries.delete(sessionId)
        this.revisions.delete(sessionId)
    }

    getSummary(sessionId: string): CodexLocalSessionSummary | null {
        return this.readSummary(sessionId)?.session ?? null
    }

    /**
     * Read only the row summary and recent turn lifecycle. This path must stay
     * bounded because hooks and queue checks run on the runner's event loop;
     * message bodies are loaded only by read()/readCached().
     */
    readSummary(sessionId: string): NativeCodexTranscriptSummaryRead | null {
        return this.readSummaryInternal(sessionId, false, true)
    }

    /** Advance a watcher-observed summary without loading message bodies. */
    refreshSummary(sessionId: string): NativeCodexTranscriptSummaryRead | null {
        if (!this.entries.has(sessionId)) return null
        return this.readSummaryInternal(sessionId, true, false)
    }

    private readSummaryInternal(
        sessionId: string,
        forceRefresh: boolean,
        allowColdLoad: boolean
    ): NativeCodexTranscriptSummaryRead | null {
        const entry = this.resolveEntry(sessionId, { forceRefresh, allowColdLoad })?.entry
        if (!entry) return null
        return {
            session: this.applyLifecycleToSummary(entry.session),
            lifecycleEvents: entry.lifecycleEvents
        }
    }

    read(sessionId: string, options: CodexLocalSessionReadOptions = {}): NativeCodexTranscriptRead | null {
        return this.readInternal(sessionId, options, false, true)
    }

    readCached(sessionId: string, options: CodexLocalSessionReadOptions = {}): NativeCodexTranscriptRead | null {
        const entry = this.entries.get(sessionId)
        if (!entry || entry.importedMessages === null) {
            return null
        }
        return this.readInternal(sessionId, options, false, false)
    }

    /**
     * Advance a transcript that the watcher just changed, but only if a
     * browser/direct-send path has already made it hot in this cache.
     */
    refreshCached(sessionId: string, options: CodexLocalSessionReadOptions = {}): NativeCodexTranscriptRead | null {
        const entry = this.entries.get(sessionId)
        if (!entry || entry.importedMessages === null) {
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

        const data = createLocalCodexSessionData(entry.session, entry.importedMessages ?? [], options)
        return {
            data: {
                ...data,
                session: this.applyLifecycleToSummary(data.session)
            },
            revision: this.revisions.get(sessionId) ?? 1,
            timing: {
                cache: cacheMiss ? 'miss' : 'hit',
                durationMs: Math.max(0, this.now() - startedAt)
            },
            lifecycleEvents: entry.lifecycleEvents
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
        const lifecycleTail = nextFingerprint
            ? readRecentLifecycleTail(session.file, nextFingerprint.size)
            : { lifecycleEvents: [], trailingBytes: Buffer.alloc(0) }
        const entry: CacheEntry = {
            session: nextFingerprint ? { ...session, modifiedAt: nextFingerprint.modifiedAt } : session,
            importedMessages: null,
            accumulator: null,
            trailingBytes: lifecycleTail.trailingBytes,
            fileSize: nextFingerprint?.size ?? 0,
            fingerprint: nextFingerprint,
            lifecycleEvents: lifecycleTail.lifecycleEvents
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
            fingerprint,
            lifecycleEvents: appendLifecycleEvents(entry.lifecycleEvents, parsed.lines)
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
                trailingBytes: Buffer.alloc(0),
                lifecycleEvents: []
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
            fingerprint,
            lifecycleEvents: takeRecentLifecycleEvents(parsed.lines)
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

    private applyLifecycleToSummary(session: CodexLocalSessionSummary): CodexLocalSessionSummary {
        return this.applyLifecycle?.(session) ?? session
    }
}

function appendLifecycleEvents(
    existing: readonly CodexTranscriptLifecycleEvent[],
    lines: readonly string[]
): CodexTranscriptLifecycleEvent[] {
    const next = [...existing, ...getCodexTranscriptLifecycleEvents(lines)]
    return next.length <= MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT
        ? next
        : next.slice(-MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT)
}

function takeRecentLifecycleEvents(lines: readonly string[]): CodexTranscriptLifecycleEvent[] {
    const events = getCodexTranscriptLifecycleEvents(lines)
    return events.length <= MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT
        ? events
        : events.slice(-MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT)
}

function readRecentLifecycleTail(file: string, fileSize: number): RecentLifecycleTail {
    const empty: RecentLifecycleTail = {
        lifecycleEvents: [],
        trailingBytes: Buffer.alloc(0)
    }
    if (fileSize <= 0) return empty
    const offset = Math.max(0, fileSize - LIFECYCLE_TAIL_READ_BYTES)
    const bytes = readFileRange(file, offset, fileSize - offset)
    if (!bytes) return empty

    let completeTail = bytes
    // A bounded tail can begin inside a JSONL record. Ignore that fragment so
    // arbitrary message text cannot hide later complete lifecycle records.
    if (offset > 0) {
        const firstNewline = completeTail.indexOf(0x0a)
        if (firstNewline === -1) return empty
        completeTail = completeTail.subarray(firstNewline + 1)
    }

    const parsed = splitCompleteJsonlLines(completeTail)
    return {
        lifecycleEvents: takeRecentLifecycleEvents(parsed.lines),
        trailingBytes: parsed.trailingBytes
    }
}
