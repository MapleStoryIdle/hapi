import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
    appendCodexTranscriptImportLines,
    createCodexTranscriptImportAccumulator,
    createLocalCodexSessionData,
    findLocalCodexSession,
    getCodexTranscriptImportPlan,
    getCodexTranscriptLifecycleEvents,
    getCodexTranscriptUserInputEvents,
    getCodexTranscriptTailSummary,
    listLocalCodexSessionSubagents,
    listLocalCodexSessionTranscriptFiles,
    readLocalCodexSessionSummary,
    type CodexImportedMessageContent,
    type CodexLocalSessionData,
    type CodexLocalSessionPlan,
    type CodexLocalSessionReadOptions,
    type CodexLocalSessionReadTiming,
    type CodexLocalSessionSubagent,
    type CodexLocalSessionSummary,
    type CodexLocalSessionSnapshotVersion,
    type CodexTranscriptImportAccumulator,
    type CodexTranscriptLifecycleEvent,
    type CodexTranscriptUserInputEvent
} from '@hapi/protocol/codexTranscript'

type FileFingerprint = {
    size: number
    modifiedAt: number
    dev: number
    ino: number
}

type CacheEntry = {
    session: CodexLocalSessionSummary
    /** Chronological JSONL segments for one logical native Codex thread. */
    transcriptFiles: readonly string[]
    importedMessages: CodexImportedMessageContent[] | null
    accumulator: CodexTranscriptImportAccumulator | null
    trailingBytes: Buffer
    fileSize: number
    fingerprint: FileFingerprint | null
    lifecycleEvents: CodexTranscriptLifecycleEvent[]
    userInputEvents: CodexTranscriptUserInputEvent[]
    /** Direct native child snapshots are separate from parent pagination. */
    subagents: CodexLocalSessionSubagent[]
    /** Monotonic runner clock of the last cross-transcript child discovery. */
    subagentScanAt: number
    /** A parent agent-control call can create/update a child immediately. */
    subagentDiscoveryPending: boolean
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
    userInputEvents: CodexTranscriptUserInputEvent[]
    trailingBytes: Buffer
}

export type NativeCodexTranscriptRead = {
    data: CodexLocalSessionData
    /** Current confirmed update_plan outside the bounded message page. */
    plan: CodexLocalSessionPlan | null
    /** Opaque version that cannot survive a runner restart. */
    version: CodexLocalSessionSnapshotVersion
    /** Kept for compact callers that only display the revision. */
    revision: number
    timing: CodexLocalSessionReadTiming
    /** Bounded raw lifecycle records for the runner-local turn tracker. */
    lifecycleEvents: readonly CodexTranscriptLifecycleEvent[]
    /** Bounded, argument-free native local-input lifecycle records. */
    userInputEvents: readonly CodexTranscriptUserInputEvent[]
}

export type NativeCodexTranscriptSummaryRead = {
    session: CodexLocalSessionSummary
    version: CodexLocalSessionSnapshotVersion
    revision: number
    lifecycleEvents: readonly CodexTranscriptLifecycleEvent[]
    userInputEvents: readonly CodexTranscriptUserInputEvent[]
}

export type NativeCodexTranscriptCacheOptions = {
    maxEntries?: number
    now?: () => number
    /** Test hook; production runners generate a fresh opaque epoch. */
    runnerEpoch?: string
    applyLifecycle?: (session: CodexLocalSessionSummary) => CodexLocalSessionSummary
}

const MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT = 128
// A cold session only needs the latest turn terminal/start records. Full
// message history is loaded later, when the user actually opens the detail.
const LIFECYCLE_TAIL_READ_BYTES = 16 * 1024
// Child transcript changes do not always append to the parent file. Keep the
// recursive CODEX_HOME discovery bounded; the browser can poll cheaply while
// an active card exists, but should not make every one-second read scan every
// historical rollout header.
const SUBAGENT_DISCOVERY_INTERVAL_MS = 5_000

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
        ...(tail.runState === undefined ? {} : { runState: tail.runState }),
        ...(tail.waitingForUserInput === undefined ? {} : { waitingForUserInput: tail.waitingForUserInput })
    }
}

function areSameNativeCodexSubagents(
    left: readonly CodexLocalSessionSubagent[],
    right: readonly CodexLocalSessionSubagent[]
): boolean {
    if (left.length !== right.length) return false
    return left.every((subagent, index) => {
        const candidate = right[index]
        return candidate?.id === subagent.id
            && candidate.parentSessionId === subagent.parentSessionId
            && candidate.name === subagent.name
            && candidate.role === subagent.role
            && candidate.agentPath === subagent.agentPath
            && candidate.model === subagent.model
            && candidate.modelReasoningEffort === subagent.modelReasoningEffort
            && candidate.status === subagent.status
            && candidate.statusText === subagent.statusText
            && candidate.startedAt === subagent.startedAt
            && candidate.updatedAt === subagent.updatedAt
            && candidate.completedAt === subagent.completedAt
            && candidate.traceMessages.length === subagent.traceMessages.length
    })
}

function hasNativeCodexSubagentControlRecord(lines: readonly string[]): boolean {
    for (const line of lines) {
        try {
            const record = JSON.parse(line) as { type?: unknown; payload?: unknown }
            if (record.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') continue
            const payload = record.payload as { type?: unknown; name?: unknown }
            if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue
            if (
                payload.name === 'spawn_agent'
                || payload.name === 'send_input'
                || payload.name === 'resume_agent'
                || payload.name === 'wait_agent'
                || payload.name === 'close_agent'
            ) {
                return true
            }
        } catch {
            // A live transcript may expose a partial final JSONL line.
        }
    }
    return false
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
    private readonly runnerEpoch: string
    private readonly applyLifecycle: ((session: CodexLocalSessionSummary) => CodexLocalSessionSummary) | null
    private revisionCounter = 0

    constructor(options: NativeCodexTranscriptCacheOptions = {}) {
        // Match the watcher’s observed-thread window so parsed message bodies
        // cannot accumulate for every historical Codex transcript.
        this.maxEntries = options.maxEntries ?? 16
        this.now = options.now ?? Date.now
        this.runnerEpoch = options.runnerEpoch?.trim() || randomUUID()
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

    /**
     * Advance a watcher-observed summary from its exact JSONL path. Codex can
     * rotate one thread into a new file while the previous file remains valid
     * and unchanged, so a session-id-only refresh would otherwise stay stale.
     */
    refreshSummaryFromFile(sessionId: string, filePath: string): NativeCodexTranscriptSummaryRead | null {
        if (!this.entries.has(sessionId)) return null
        return this.readSummaryInternal(sessionId, true, false, filePath)
    }

    private readSummaryInternal(
        sessionId: string,
        forceRefresh: boolean,
        allowColdLoad: boolean,
        observedFilePath?: string
    ): NativeCodexTranscriptSummaryRead | null {
        const entry = this.resolveEntry(sessionId, { forceRefresh, allowColdLoad, observedFilePath })?.entry
        if (!entry) return null
        const revision = this.getRevision(sessionId)
        return {
            session: this.applyLifecycleToSummary(entry.session),
            version: this.getVersion(revision),
            revision,
            lifecycleEvents: entry.lifecycleEvents,
            userInputEvents: entry.userInputEvents
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

    /**
     * Refresh a hot transcript from a watcher-reported file. A segment switch
     * rebuilds the message accumulator across the thread's ordered JSONL
     * files, keeping older conversation history intact.
     */
    refreshCachedFromFile(
        sessionId: string,
        filePath: string,
        options: CodexLocalSessionReadOptions = {}
    ): NativeCodexTranscriptRead | null {
        const entry = this.entries.get(sessionId)
        if (!entry || entry.importedMessages === null) {
            return null
        }
        return this.readInternal(sessionId, options, true, false, filePath)
    }

    private readInternal(
        sessionId: string,
        options: CodexLocalSessionReadOptions,
        forceRefresh: boolean,
        allowColdLoad: boolean,
        observedFilePath?: string
    ): NativeCodexTranscriptRead | null {
        const startedAt = this.now()
        const resolved = this.resolveEntry(sessionId, {
            forceRefresh,
            allowColdLoad,
            observedFilePath
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

        const entryBeforeSubagentRefresh = entry
        const refreshedSubagents = this.refreshSubagents(entry)
        entry = refreshedSubagents.entry
        if (entry !== entryBeforeSubagentRefresh) {
            this.setEntry(sessionId, entry)
        }
        if (refreshedSubagents.changed) {
            this.bumpRevision(sessionId)
            cacheMiss = true
        }

        const data = createLocalCodexSessionData(
            entry.session,
            entry.importedMessages ?? [],
            options,
            entry.subagents
        )
        const revision = this.getRevision(sessionId)
        return {
            data: {
                ...data,
                session: this.applyLifecycleToSummary(data.session)
            },
            plan: entry.accumulator ? getCodexTranscriptImportPlan(entry.accumulator) : null,
            version: this.getVersion(revision),
            revision,
            timing: {
                cache: cacheMiss ? 'miss' : 'hit',
                durationMs: Math.max(0, this.now() - startedAt)
            },
            lifecycleEvents: entry.lifecycleEvents,
            userInputEvents: entry.userInputEvents
        }
    }

    private resolveEntry(
        sessionId: string,
        options: { forceRefresh?: boolean; allowColdLoad?: boolean; observedFilePath?: string } = {}
    ): ResolvedEntry | null {
        const current = this.entries.get(sessionId)
        const observedFilePath = options.observedFilePath?.trim()
        if (current && observedFilePath && observedFilePath !== current.session.file) {
            const observedSession = readLocalCodexSessionSummary(observedFilePath)
            // A late watcher callback for an older segment must not move a
            // thread backwards after Codex has already rotated it again.
            if (observedSession?.id === sessionId && observedSession.modifiedAt >= current.session.modifiedAt) {
                const entry = this.createEntry(observedSession)
                this.setEntry(sessionId, entry)
                this.bumpRevision(sessionId)
                return { entry, cacheMiss: true }
            }
        }

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
        const entry = this.createEntry(session)
        this.setEntry(sessionId, entry)
        this.bumpRevision(sessionId)
        return { entry, cacheMiss: true }
    }

    private createEntry(session: CodexLocalSessionSummary): CacheEntry {
        const fingerprint = getFileFingerprint(session.file)
        const lifecycleTail = fingerprint
            ? readRecentLifecycleTail(session.file, fingerprint.size)
            : { lifecycleEvents: [], userInputEvents: [], trailingBytes: Buffer.alloc(0) }
        const transcriptFiles = listLocalCodexSessionTranscriptFiles(session.id).map((candidate) => candidate.file)
        if (!transcriptFiles.includes(session.file)) {
            transcriptFiles.push(session.file)
        }
        return {
            session: fingerprint ? { ...session, modifiedAt: fingerprint.modifiedAt } : session,
            transcriptFiles,
            importedMessages: null,
            accumulator: null,
            trailingBytes: lifecycleTail.trailingBytes,
            fileSize: fingerprint?.size ?? 0,
            fingerprint,
            lifecycleEvents: lifecycleTail.lifecycleEvents,
            userInputEvents: lifecycleTail.userInputEvents,
            subagents: [],
            subagentScanAt: 0,
            subagentDiscoveryPending: true
        }
    }

    private refreshSubagents(entry: CacheEntry): { entry: CacheEntry; changed: boolean } {
        const now = this.now()
        if (
            !entry.subagentDiscoveryPending
            && entry.subagentScanAt > 0
            && now - entry.subagentScanAt < SUBAGENT_DISCOVERY_INTERVAL_MS
        ) {
            return { entry, changed: false }
        }

        const subagents = listLocalCodexSessionSubagents(entry.session.id)
        const next: CacheEntry = {
            ...entry,
            subagents,
            subagentScanAt: now,
            subagentDiscoveryPending: false
        }
        return {
            entry: next,
            changed: !areSameNativeCodexSubagents(entry.subagents, subagents)
        }
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
        const lifecycleEvents = appendLifecycleEvents(entry.lifecycleEvents, parsed.lines)
        const userInputEvents = appendUserInputEvents(entry.userInputEvents, parsed.lines)
        const waitingForUserInput = getIncrementalUserInputWaitingState(userInputEvents)
        return {
            ...entry,
            session: {
                ...applyTailSummary(entry.session, parsed.lines, fingerprint),
                waitingForUserInput
            },
            importedMessages: entry.accumulator?.messages ?? null,
            trailingBytes: parsed.trailingBytes,
            fileSize: entry.fileSize + appendedBytes.length,
            fingerprint,
            lifecycleEvents,
            userInputEvents,
            subagentDiscoveryPending: entry.subagentDiscoveryPending
                || hasNativeCodexSubagentControlRecord(parsed.lines)
        }
    }

    private loadImportedMessages(sessionId: string, entry: CacheEntry): CacheEntry {
        const accumulator = createCodexTranscriptImportAccumulator()
        let latestParsed: CompleteLines | null = null
        for (const filePath of entry.transcriptFiles) {
            let contents: Buffer
            try {
                contents = readFileSync(filePath)
            } catch {
                // A rotated historical segment can disappear after native
                // archive/cleanup. Keep the current segment readable rather
                // than dropping the whole thread view.
                continue
            }
            const parsed = splitCompleteJsonlLines(contents)
            appendCodexTranscriptImportLines(accumulator, parsed.lines)
            if (filePath === entry.session.file) {
                latestParsed = parsed
            }
        }

        if (!latestParsed) {
            const empty: CacheEntry = {
                ...entry,
                importedMessages: [],
                accumulator,
                trailingBytes: Buffer.alloc(0),
                lifecycleEvents: [],
                userInputEvents: []
            }
            this.setEntry(sessionId, empty)
            return empty
        }

        const fingerprint = getFileFingerprint(entry.session.file)
        const next: CacheEntry = {
            ...entry,
            session: fingerprint ? applyTailSummary(entry.session, latestParsed.lines, fingerprint) : entry.session,
            importedMessages: accumulator.messages,
            accumulator,
            trailingBytes: latestParsed.trailingBytes,
            fileSize: fingerprint?.size ?? entry.fileSize,
            fingerprint,
            lifecycleEvents: takeRecentLifecycleEvents(latestParsed.lines),
            userInputEvents: takeRecentUserInputEvents(latestParsed.lines)
        }
        this.setEntry(sessionId, next)
        return next
    }

    private bumpRevision(sessionId: string): number {
        const revision = ++this.revisionCounter
        this.revisions.set(sessionId, revision)
        return revision
    }

    private getRevision(sessionId: string): number {
        return this.revisions.get(sessionId) ?? this.bumpRevision(sessionId)
    }

    private getVersion(revision: number): CodexLocalSessionSnapshotVersion {
        return {
            runnerEpoch: this.runnerEpoch,
            revision
        }
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

function appendUserInputEvents(
    existing: readonly CodexTranscriptUserInputEvent[],
    lines: readonly string[]
): CodexTranscriptUserInputEvent[] {
    const next = [...existing, ...getCodexTranscriptUserInputEvents(lines)]
    return next.length <= MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT
        ? next
        : next.slice(-MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT)
}

function takeRecentUserInputEvents(lines: readonly string[]): CodexTranscriptUserInputEvent[] {
    const events = getCodexTranscriptUserInputEvents(lines)
    return events.length <= MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT
        ? events
        : events.slice(-MAX_LIFECYCLE_EVENTS_PER_TRANSCRIPT)
}

function getIncrementalUserInputWaitingState(
    events: readonly CodexTranscriptUserInputEvent[]
): boolean {
    let active: Extract<CodexTranscriptUserInputEvent, { requestId: string }> | null = null
    for (const event of events) {
        if (event.type === 'requested') {
            active = event
        } else if (event.type === 'resolved') {
            if (active?.requestId === event.requestId) active = null
        } else if (event.type === 'turn_started' && active) {
            if (!event.turnId || !active.turnId || event.turnId !== active.turnId) {
                active = null
            }
        } else if (event.type === 'turn_terminal' && active
            && (!event.turnId || !active.turnId || event.turnId === active.turnId)) {
            active = null
        }
    }
    return active !== null
}

function readRecentLifecycleTail(file: string, fileSize: number): RecentLifecycleTail {
    const empty: RecentLifecycleTail = {
        lifecycleEvents: [],
        userInputEvents: [],
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
        userInputEvents: takeRecentUserInputEvents(parsed.lines),
        trailingBytes: parsed.trailingBytes
    }
}
