import type {
    CodexLocalSessionRunState,
    CodexLocalSessionSummary,
    CodexTranscriptLifecycleEvent,
    CodexTranscriptUserInputEvent
} from '@hapi/protocol/codexTranscript'

export type ExternalCodexLifecycleEvent = {
    codexSessionId: string
    turnId: string
    event: 'turn_started'
    observedAt: number
}

/** Sanitized state-only signal from a global native Codex input hook. */
export type ExternalCodexUserInputEvent = {
    codexSessionId: string
    requestId: string
    phase: 'requested' | 'resolved'
    turnId?: string
    observedAt?: number
}

type ActiveTurn = {
    turnId: string
    observedAt: number
    expiresAt: number
    confirmed: boolean
    expired: boolean
    expiryTimer: ReturnType<typeof setTimeout> | null
}

type ActiveUserInput = {
    requestId: string
    turnId?: string
    observedAt: number
    expiresAt: number
    confirmed: boolean
    expired: boolean
    expiryTimer: ReturnType<typeof setTimeout> | null
}

type SessionLifecycle = {
    active: ActiveTurn | null
    terminals: Map<string, number>
    userInput: ActiveUserInput | null
    resolvedUserInputRequests: Map<string, number>
    transcriptUserInputEvents: CodexTranscriptUserInputEvent[]
    touchedAt: number
}

export type NativeCodexTurnLifecycleTrackerOptions = {
    now?: () => number
    unconfirmedLeaseMs?: number
    processingStaleAfterMs?: number
    terminalTtlMs?: number
    maxSessions?: number
    maxTerminalTurnsPerSession?: number
    onUnconfirmedLeaseExpired?: (codexSessionId: string) => void
    onUserInputLeaseExpired?: (codexSessionId: string) => void
    onProcessingStale?: (codexSessionId: string) => void
}

type ProcessingStaleTimer = {
    modifiedAt: number
    dueAt: number
    notified: boolean
    timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_UNCONFIRMED_LEASE_MS = 15_000
export const NATIVE_CODEX_PROCESSING_STALE_AFTER_MS = 5 * 60_000
const DEFAULT_TERMINAL_TTL_MS = 5 * 60_000
const DEFAULT_MAX_SESSIONS = 128
const DEFAULT_MAX_TERMINAL_TURNS_PER_SESSION = 16

function sameUserInputEvent(
    left: CodexTranscriptUserInputEvent,
    right: CodexTranscriptUserInputEvent
): boolean {
    return left.type === right.type
        && left.turnId === right.turnId
        && ('requestId' in left ? ('requestId' in right && left.requestId === right.requestId) : !('requestId' in right))
}

/**
 * Applies the local UserPromptSubmit signal before its matching transcript
 * lifecycle arrives. Transcript terminal records remain authoritative; the
 * short unconfirmed lease is deliberately conservative when confirmation is
 * missing.
 */
export class NativeCodexTurnLifecycleTracker {
    private readonly sessions = new Map<string, SessionLifecycle>()
    private readonly processingStaleTimers = new Map<string, ProcessingStaleTimer>()
    private readonly now: () => number
    private readonly unconfirmedLeaseMs: number
    private readonly processingStaleAfterMs: number
    private readonly terminalTtlMs: number
    private readonly maxSessions: number
    private readonly maxTerminalTurnsPerSession: number
    private readonly onUnconfirmedLeaseExpired: ((codexSessionId: string) => void) | null
    private readonly onUserInputLeaseExpired: ((codexSessionId: string) => void) | null
    private readonly onProcessingStale: ((codexSessionId: string) => void) | null

    constructor(options: NativeCodexTurnLifecycleTrackerOptions = {}) {
        this.now = options.now ?? Date.now
        this.unconfirmedLeaseMs = options.unconfirmedLeaseMs ?? DEFAULT_UNCONFIRMED_LEASE_MS
        this.processingStaleAfterMs = options.processingStaleAfterMs ?? NATIVE_CODEX_PROCESSING_STALE_AFTER_MS
        this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS
        this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
        this.maxTerminalTurnsPerSession = options.maxTerminalTurnsPerSession ?? DEFAULT_MAX_TERMINAL_TURNS_PER_SESSION
        this.onUnconfirmedLeaseExpired = options.onUnconfirmedLeaseExpired ?? null
        this.onUserInputLeaseExpired = options.onUserInputLeaseExpired ?? null
        this.onProcessingStale = options.onProcessingStale ?? null
    }

    /** Returns true only when a new effective local lifecycle state begins. */
    observeHookStart(event: ExternalCodexLifecycleEvent): boolean {
        const session = this.getOrCreate(event.codexSessionId)
        const now = this.now()
        const observedAt = Number.isFinite(event.observedAt) && event.observedAt >= 0
            ? Math.min(event.observedAt, now)
            : now
        this.pruneTerminals(session, now)
        this.touch(event.codexSessionId, session, now)

        // A terminal can reach the transcript before this asynchronous hook.
        // Do not let a late duplicate start resurrect that completed turn.
        if (session.terminals.has(event.turnId)) {
            return false
        }

        if (session.active?.turnId === event.turnId) {
            // Same-turn starts are intentionally idempotent: they must not
            // continually extend an otherwise unconfirmed safety lease.
            return false
        }

        // Startup buffering and background hooks can deliver starts out of
        // order. A provably older observation must never replace the newer
        // active turn and later let its terminal clear it. Equal millisecond
        // timestamps keep arrival order because two adjacent turns can share
        // Date.now() granularity.
        if (session.active && observedAt < session.active.observedAt) {
            return false
        }

        this.clearUserInputForNewTurn(session, event.turnId, now)
        this.clearActiveTimer(session.active)
        const active: ActiveTurn = {
            turnId: event.turnId,
            observedAt,
            expiresAt: observedAt + this.unconfirmedLeaseMs,
            confirmed: false,
            expired: false,
            expiryTimer: null
        }
        session.active = active
        this.scheduleExpiry(event.codexSessionId, active)
        return true
    }

    /**
     * Apply an advisory PreToolUse/PostToolUse signal without retaining its
     * input or output. A resolved hook is authoritative for the local UI
     * immediately, while a requested hook remains a short lease until its
     * matching transcript call confirms it.
     */
    observeExternalUserInput(event: ExternalCodexUserInputEvent): boolean {
        const session = this.getOrCreate(event.codexSessionId)
        const now = this.now()
        const observedAt = Number.isFinite(event.observedAt) && (event.observedAt ?? -1) >= 0
            ? Math.min(event.observedAt!, now)
            : now
        this.pruneTerminals(session, now)
        this.pruneUserInputTombstones(session, now)
        this.touch(event.codexSessionId, session, now)

        if (event.phase === 'resolved') {
            if (session.resolvedUserInputRequests.has(event.requestId)) {
                return false
            }
            this.rememberResolvedUserInput(session, event.requestId, now)
            if (session.userInput?.requestId !== event.requestId) {
                return false
            }
            this.clearUserInputTimer(session.userInput)
            session.userInput = null
            return true
        }

        if (session.resolvedUserInputRequests.has(event.requestId)) {
            return false
        }
        if (event.turnId && session.terminals.has(event.turnId)) {
            return false
        }
        if (session.userInput?.requestId === event.requestId) {
            // A duplicate request must not silently renew the safety lease.
            return false
        }

        if (session.userInput) {
            this.rememberResolvedUserInput(session, session.userInput.requestId, now)
            this.clearUserInputTimer(session.userInput)
        }
        const userInput: ActiveUserInput = {
            requestId: event.requestId,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            observedAt,
            expiresAt: observedAt + this.unconfirmedLeaseMs,
            confirmed: false,
            expired: false,
            expiryTimer: null
        }
        session.userInput = userInput
        this.scheduleUserInputExpiry(event.codexSessionId, userInput)
        return true
    }

    /** True only while this exact local request is still awaiting an answer. */
    isActiveUserInputRequest(codexSessionId: string, requestId: string): boolean {
        const session = this.sessions.get(codexSessionId)
        const userInput = session?.userInput
        if (!session || !userInput || userInput.requestId !== requestId) return false

        const now = this.now()
        this.pruneUserInputTombstones(session, now)
        this.touch(codexSessionId, session, now)
        return !userInput.expired && (userInput.confirmed || now < userInput.expiresAt)
    }

    /** Confirm/resolve native local-input state from a bounded transcript tail. */
    observeTranscriptUserInputEvents(
        codexSessionId: string,
        events: readonly CodexTranscriptUserInputEvent[]
    ): boolean {
        const session = this.getOrCreate(codexSessionId)
        const now = this.now()
        this.pruneUserInputTombstones(session, now)
        this.touch(codexSessionId, session, now)
        let changed = false

        const previousEvents = session.transcriptUserInputEvents
        let overlap = Math.min(previousEvents.length, events.length)
        while (overlap > 0) {
            const previousOffset = previousEvents.length - overlap
            let matches = true
            for (let index = 0; index < overlap; index += 1) {
                if (!sameUserInputEvent(previousEvents[previousOffset + index], events[index])) {
                    matches = false
                    break
                }
            }
            if (matches) break
            overlap -= 1
        }
        if (previousEvents.length > 0 && overlap === 0 && session.userInput?.confirmed) {
            // The bounded tail was replaced rather than appended. Rebuild its
            // transcript-owned state from the new snapshot; a fresh hook-only
            // request remains protected until its own transcript arrives.
            this.rememberResolvedUserInput(session, session.userInput.requestId, now)
            this.clearUserInputTimer(session.userInput)
            session.userInput = null
            changed = true
        }
        const unseenEvents = events.slice(overlap)
        session.transcriptUserInputEvents = events.map((event) => ({ ...event }))

        for (const event of unseenEvents) {
            if (event.type === 'turn_started') {
                changed = this.clearUserInputForNewTurn(session, event.turnId, now) || changed
                continue
            }
            if (event.type === 'turn_terminal') {
                changed = this.clearUserInputForTerminal(session, event.turnId, now) || changed
                continue
            }
            if (event.type === 'requested') {
                if (session.resolvedUserInputRequests.has(event.requestId)) {
                    continue
                }
                if (session.userInput?.requestId === event.requestId) {
                    if (!session.userInput.confirmed) {
                        session.userInput.confirmed = true
                        session.userInput.expired = false
                        this.clearUserInputTimer(session.userInput)
                        changed = true
                    }
                    continue
                }

                if (session.userInput) {
                    this.rememberResolvedUserInput(session, session.userInput.requestId, now)
                    this.clearUserInputTimer(session.userInput)
                }
                session.userInput = {
                    requestId: event.requestId,
                    ...(event.turnId ? { turnId: event.turnId } : {}),
                    observedAt: now,
                    expiresAt: Number.POSITIVE_INFINITY,
                    confirmed: true,
                    expired: false,
                    expiryTimer: null
                }
                changed = true
                continue
            }

            if (event.type !== 'resolved') {
                continue
            }

            // A transcript function_call_output does not identify its tool
            // name. It can only resolve the exact active local-input request;
            // unrelated tool outputs never create tombstones.
            if (session.userInput?.requestId !== event.requestId) {
                continue
            }
            this.rememberResolvedUserInput(session, event.requestId, now)
            this.clearUserInputTimer(session.userInput)
            session.userInput = null
            changed = true
        }
        return changed
    }

    /** Ignore a prompt created by HAPI's own headless native bridge. */
    suppressUserInputWait(codexSessionId: string): boolean {
        const session = this.sessions.get(codexSessionId)
        if (!session?.userInput) return false
        const now = this.now()
        this.touch(codexSessionId, session, now)
        return this.clearUserInputForTerminal(session, undefined, now)
    }

    /**
     * Consume parsed transcript events. Only turn-scoped records can mutate
     * the hook overlay; unscoped legacy records remain the raw transcript
     * fallback rather than risking one turn ending another.
     */
    observeTranscriptEvents(codexSessionId: string, events: readonly CodexTranscriptLifecycleEvent[]): boolean {
        const scopedEvents = events.filter((event): event is CodexTranscriptLifecycleEvent & { turnId: string } => (
            typeof event.turnId === 'string' && event.turnId.length > 0
        ))
        const supersededStartIndexes = new Set<number>()
        let changed = false

        // A later scoped lifecycle record proves that an earlier started turn
        // is no longer the live native turn, even when Codex crashed before it
        // could append that turn's own terminal. Remember the superseded turn
        // before replaying the bounded transcript tail so repeated status
        // reads cannot resurrect the orphaned start.
        for (let index = 0; index < scopedEvents.length - 1; index += 1) {
            const event = scopedEvents[index]
            if (event.type !== 'task_started') continue
            supersededStartIndexes.add(index)
            changed = this.observeTranscriptTerminal(codexSessionId, event.turnId) || changed
        }

        for (let index = 0; index < scopedEvents.length; index += 1) {
            const event = scopedEvents[index]
            if (event.type === 'task_started') {
                // The terminal tombstone cache is intentionally bounded. Skip
                // starts already proven obsolete in this batch as well, so a
                // long transcript tail cannot prune an old tombstone and then
                // resurrect that orphan while the same tail is replayed.
                if (supersededStartIndexes.has(index)) continue
                changed = this.observeTranscriptStart(codexSessionId, event.turnId) || changed
            } else {
                changed = this.observeTranscriptTerminal(codexSessionId, event.turnId) || changed
            }
        }
        return changed
    }

    /** Overlay the hook lifecycle onto the raw transcript summary. */
    applyToSummary(session: CodexLocalSessionSummary): CodexLocalSessionSummary {
        const now = this.now()
        const lifecycle = this.sessions.get(session.id)
        const active = lifecycle?.active ?? null
        const userInput = lifecycle?.userInput ?? null
        const hasUserInputDecision = Boolean(userInput) || (lifecycle?.resolvedUserInputRequests.size ?? 0) > 0
        const hapiOriginated = session.originator?.trim().toLowerCase() === 'hapi-codex-client'
        const waitingForUserInput = !hapiOriginated && (userInput !== null
            ? !userInput.expired && (userInput.confirmed || now < userInput.expiresAt)
            : !hasUserInputDecision && session.waitingForUserInput === true)
        const state: CodexLocalSessionRunState = waitingForUserInput
            ? 'processing'
            : active
                ? active.confirmed
                    ? 'processing'
                    : (active.expired || now >= active.expiresAt ? 'unknown' : 'processing')
                : session.runState ?? 'unknown'
        // A hook precedes the file append, so its short lease may advance the
        // row timestamp. A confirmed transcript start already has an
        // authoritative file mtime; replacing it with read time would make an
        // abandoned historical start look freshly active after every restart.
        const unconfirmedObservedAt = [
            active && !active.confirmed ? active.observedAt : null,
            userInput && !userInput.confirmed && !userInput.expired ? userInput.observedAt : null
        ].reduce<number | null>((latest, observedAt) => (
            observedAt === null ? latest : Math.max(latest ?? observedAt, observedAt)
        ), null)
        const modifiedAt = state === 'processing' && unconfirmedObservedAt !== null
            ? Math.max(session.modifiedAt, unconfirmedObservedAt)
            : session.modifiedAt
        if (
            session.runState === state
            && session.modifiedAt === modifiedAt
            && (session.waitingForUserInput ?? false) === waitingForUserInput
        ) {
            this.updateProcessingStaleTimer(session)
            return session
        }
        const next = { ...session, runState: state, waitingForUserInput, modifiedAt }
        this.updateProcessingStaleTimer(next)
        return next
    }

    dispose(): void {
        for (const session of this.sessions.values()) {
            this.clearActiveTimer(session.active)
            this.clearUserInputTimer(session.userInput)
        }
        for (const entry of this.processingStaleTimers.values()) {
            if (entry.timer) clearTimeout(entry.timer)
        }
        this.sessions.clear()
        this.processingStaleTimers.clear()
    }

    private observeTranscriptStart(codexSessionId: string, turnId: string): boolean {
        const session = this.getOrCreate(codexSessionId)
        const now = this.now()
        this.pruneTerminals(session, now)
        this.touch(codexSessionId, session, now)
        if (session.terminals.has(turnId)) {
            return false
        }

        if (session.active?.turnId === turnId) {
            if (session.active.confirmed) return false
            session.active.confirmed = true
            session.active.expired = false
            this.clearActiveTimer(session.active)
            return true
        }

        // A newer hook-start wins over delayed transcript confirmation for an
        // older turn. With no active turn, task_started is the fallback.
        if (session.active) return false

        this.clearUserInputForNewTurn(session, turnId, now)
        session.active = {
            turnId,
            observedAt: now,
            expiresAt: Number.POSITIVE_INFINITY,
            confirmed: true,
            expired: false,
            expiryTimer: null
        }
        return true
    }

    private observeTranscriptTerminal(codexSessionId: string, turnId: string): boolean {
        const session = this.getOrCreate(codexSessionId)
        const now = this.now()
        this.pruneTerminals(session, now)
        this.touch(codexSessionId, session, now)
        session.terminals.delete(turnId)
        session.terminals.set(turnId, now)
        this.pruneTerminals(session, now)

        const clearedUserInput = this.clearUserInputForTerminal(session, turnId, now)
        if (session.active?.turnId !== turnId) {
            return clearedUserInput
        }

        this.clearActiveTimer(session.active)
        session.active = null
        return true
    }

    private scheduleExpiry(codexSessionId: string, active: ActiveTurn): void {
        const delay = Math.max(0, active.expiresAt - this.now())
        const timer = setTimeout(() => {
            const session = this.sessions.get(codexSessionId)
            if (!session || session.active !== active || active.confirmed || active.expired || this.now() < active.expiresAt) {
                return
            }
            active.expired = true
            active.expiryTimer = null
            this.touch(codexSessionId, session, this.now())
            this.onUnconfirmedLeaseExpired?.(codexSessionId)
        }, delay)
        timer.unref?.()
        active.expiryTimer = timer
    }

    private getOrCreate(codexSessionId: string): SessionLifecycle {
        const existing = this.sessions.get(codexSessionId)
        if (existing) return existing

        const created: SessionLifecycle = {
            active: null,
            terminals: new Map(),
            userInput: null,
            resolvedUserInputRequests: new Map(),
            transcriptUserInputEvents: [],
            touchedAt: this.now()
        }
        this.sessions.set(codexSessionId, created)
        this.enforceSessionLimit()
        return created
    }

    private touch(codexSessionId: string, session: SessionLifecycle, now: number): void {
        session.touchedAt = now
        this.sessions.delete(codexSessionId)
        this.sessions.set(codexSessionId, session)
    }

    private enforceSessionLimit(): void {
        while (this.sessions.size > this.maxSessions) {
            const oldestId = this.sessions.keys().next().value
            if (!oldestId) return
            const oldest = this.sessions.get(oldestId)
            this.clearActiveTimer(oldest?.active ?? null)
            this.clearUserInputTimer(oldest?.userInput ?? null)
            this.sessions.delete(oldestId)
        }
    }

    private pruneTerminals(session: SessionLifecycle, now: number): void {
        for (const [turnId, observedAt] of session.terminals) {
            if (now - observedAt > this.terminalTtlMs) {
                session.terminals.delete(turnId)
            }
        }
        while (session.terminals.size > this.maxTerminalTurnsPerSession) {
            const oldestTurnId = session.terminals.keys().next().value
            if (!oldestTurnId) break
            session.terminals.delete(oldestTurnId)
        }
    }

    private pruneUserInputTombstones(session: SessionLifecycle, now: number): void {
        for (const [requestId, resolvedAt] of session.resolvedUserInputRequests) {
            if (now - resolvedAt > this.terminalTtlMs) {
                session.resolvedUserInputRequests.delete(requestId)
            }
        }
        while (session.resolvedUserInputRequests.size > this.maxTerminalTurnsPerSession) {
            const oldestRequestId = session.resolvedUserInputRequests.keys().next().value
            if (!oldestRequestId) break
            session.resolvedUserInputRequests.delete(oldestRequestId)
        }
    }

    private rememberResolvedUserInput(session: SessionLifecycle, requestId: string, now: number): void {
        session.resolvedUserInputRequests.delete(requestId)
        session.resolvedUserInputRequests.set(requestId, now)
        this.pruneUserInputTombstones(session, now)
    }

    private clearUserInputForNewTurn(session: SessionLifecycle, turnId: string | undefined, now: number): boolean {
        const active = session.userInput
        if (!active || (turnId && active.turnId === turnId)) return false
        this.rememberResolvedUserInput(session, active.requestId, now)
        this.clearUserInputTimer(active)
        session.userInput = null
        return true
    }

    private clearUserInputForTerminal(session: SessionLifecycle, turnId: string | undefined, now: number): boolean {
        const active = session.userInput
        if (!active || (active.turnId && turnId && active.turnId !== turnId)) return false
        this.rememberResolvedUserInput(session, active.requestId, now)
        this.clearUserInputTimer(active)
        session.userInput = null
        return true
    }

    private scheduleUserInputExpiry(codexSessionId: string, userInput: ActiveUserInput): void {
        const delay = Math.max(0, userInput.expiresAt - this.now())
        const timer = setTimeout(() => {
            const session = this.sessions.get(codexSessionId)
            if (
                !session
                || session.userInput !== userInput
                || userInput.confirmed
                || userInput.expired
                || this.now() < userInput.expiresAt
            ) {
                return
            }
            userInput.expired = true
            userInput.expiryTimer = null
            this.touch(codexSessionId, session, this.now())
            this.onUserInputLeaseExpired?.(codexSessionId)
        }, delay)
        timer.unref?.()
        userInput.expiryTimer = timer
    }

    private clearActiveTimer(active: ActiveTurn | null): void {
        if (!active?.expiryTimer) return
        clearTimeout(active.expiryTimer)
        active.expiryTimer = null
    }

    private clearUserInputTimer(userInput: ActiveUserInput | null): void {
        if (!userInput?.expiryTimer) return
        clearTimeout(userInput.expiryTimer)
        userInput.expiryTimer = null
    }

    private updateProcessingStaleTimer(session: CodexLocalSessionSummary): void {
        if (session.runState !== 'processing' || session.waitingForUserInput === true) {
            this.clearProcessingStaleTimer(session.id)
            return
        }

        const dueAt = session.modifiedAt + this.processingStaleAfterMs
        const existing = this.processingStaleTimers.get(session.id)
        if (existing?.modifiedAt === session.modifiedAt && existing.dueAt === dueAt) {
            return
        }

        this.clearProcessingStaleTimer(session.id)
        const entry: ProcessingStaleTimer = {
            modifiedAt: session.modifiedAt,
            dueAt,
            notified: false,
            timer: null
        }
        this.processingStaleTimers.set(session.id, entry)
        this.armProcessingStaleTimer(session.id, entry)
    }

    private armProcessingStaleTimer(codexSessionId: string, entry: ProcessingStaleTimer): void {
        const run = () => {
            if (this.processingStaleTimers.get(codexSessionId) !== entry || entry.notified) return
            const remaining = entry.dueAt - this.now()
            if (remaining > 0) {
                entry.timer = setTimeout(run, remaining)
                entry.timer.unref?.()
                return
            }

            entry.timer = null
            entry.notified = true
            this.onProcessingStale?.(codexSessionId)
        }
        entry.timer = setTimeout(run, Math.max(0, entry.dueAt - this.now()))
        entry.timer.unref?.()
    }

    private clearProcessingStaleTimer(codexSessionId: string): void {
        const entry = this.processingStaleTimers.get(codexSessionId)
        if (entry?.timer) clearTimeout(entry.timer)
        this.processingStaleTimers.delete(codexSessionId)
    }
}

/**
 * Public list rows should not animate forever for an abandoned final
 * task_started record. Unknown is deliberately safer than claiming idle; the
 * direct-send layer keeps the raw processing evidence so explicit recovery
 * remains available.
 */
export function normalizeNativeCodexSessionForDisplay(
    session: CodexLocalSessionSummary,
    now = Date.now()
): CodexLocalSessionSummary {
    if (
        session.waitingForUserInput === true
        ||
        session.runState !== 'processing'
        || now - session.modifiedAt < NATIVE_CODEX_PROCESSING_STALE_AFTER_MS
    ) {
        return session
    }
    return { ...session, runState: 'unknown' }
}
