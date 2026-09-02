import type {
    CodexLocalSessionRunState,
    CodexLocalSessionSummary,
    CodexTranscriptLifecycleEvent
} from '@hapi/protocol/codexTranscript'

export type ExternalCodexLifecycleEvent = {
    codexSessionId: string
    turnId: string
    event: 'turn_started'
    observedAt: number
}

type ActiveTurn = {
    turnId: string
    observedAt: number
    expiresAt: number
    confirmed: boolean
    expired: boolean
    expiryTimer: ReturnType<typeof setTimeout> | null
}

type SessionLifecycle = {
    active: ActiveTurn | null
    terminals: Map<string, number>
    touchedAt: number
}

export type NativeCodexTurnLifecycleTrackerOptions = {
    now?: () => number
    unconfirmedLeaseMs?: number
    terminalTtlMs?: number
    maxSessions?: number
    maxTerminalTurnsPerSession?: number
    onUnconfirmedLeaseExpired?: (codexSessionId: string) => void
}

const DEFAULT_UNCONFIRMED_LEASE_MS = 15_000
const DEFAULT_TERMINAL_TTL_MS = 5 * 60_000
const DEFAULT_MAX_SESSIONS = 128
const DEFAULT_MAX_TERMINAL_TURNS_PER_SESSION = 16

/**
 * Applies the local UserPromptSubmit signal before its matching transcript
 * lifecycle arrives. Transcript terminal records remain authoritative; the
 * short unconfirmed lease is deliberately conservative when confirmation is
 * missing.
 */
export class NativeCodexTurnLifecycleTracker {
    private readonly sessions = new Map<string, SessionLifecycle>()
    private readonly now: () => number
    private readonly unconfirmedLeaseMs: number
    private readonly terminalTtlMs: number
    private readonly maxSessions: number
    private readonly maxTerminalTurnsPerSession: number
    private readonly onUnconfirmedLeaseExpired: ((codexSessionId: string) => void) | null

    constructor(options: NativeCodexTurnLifecycleTrackerOptions = {}) {
        this.now = options.now ?? Date.now
        this.unconfirmedLeaseMs = options.unconfirmedLeaseMs ?? DEFAULT_UNCONFIRMED_LEASE_MS
        this.terminalTtlMs = options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS
        this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
        this.maxTerminalTurnsPerSession = options.maxTerminalTurnsPerSession ?? DEFAULT_MAX_TERMINAL_TURNS_PER_SESSION
        this.onUnconfirmedLeaseExpired = options.onUnconfirmedLeaseExpired ?? null
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
     * Consume parsed transcript events. Only turn-scoped records can mutate
     * the hook overlay; unscoped legacy records remain the raw transcript
     * fallback rather than risking one turn ending another.
     */
    observeTranscriptEvents(codexSessionId: string, events: readonly CodexTranscriptLifecycleEvent[]): boolean {
        const scopedEvents = events.filter((event): event is CodexTranscriptLifecycleEvent & { turnId: string } => (
            typeof event.turnId === 'string' && event.turnId.length > 0
        ))
        let changed = false

        // A later scoped lifecycle record proves that an earlier started turn
        // is no longer the live native turn, even when Codex crashed before it
        // could append that turn's own terminal. Remember the superseded turn
        // before replaying the bounded transcript tail so repeated status
        // reads cannot resurrect the orphaned start.
        for (let index = 0; index < scopedEvents.length - 1; index += 1) {
            const event = scopedEvents[index]
            if (event.type !== 'task_started') continue
            changed = this.observeTranscriptTerminal(codexSessionId, event.turnId) || changed
        }

        for (const event of scopedEvents) {
            if (event.type === 'task_started') {
                changed = this.observeTranscriptStart(codexSessionId, event.turnId) || changed
            } else {
                changed = this.observeTranscriptTerminal(codexSessionId, event.turnId) || changed
            }
        }
        return changed
    }

    /** Overlay the hook lifecycle onto the raw transcript summary. */
    applyToSummary(session: CodexLocalSessionSummary): CodexLocalSessionSummary {
        const lifecycle = this.sessions.get(session.id)
        if (!lifecycle?.active) return session

        const active = lifecycle.active
        const state: CodexLocalSessionRunState = active.confirmed
            ? 'processing'
            : (active.expired || this.now() >= active.expiresAt ? 'unknown' : 'processing')
        const modifiedAt = state === 'processing'
            ? Math.max(session.modifiedAt, active.observedAt)
            : session.modifiedAt
        if (session.runState === state && session.modifiedAt === modifiedAt) {
            return session
        }
        return { ...session, runState: state, modifiedAt }
    }

    dispose(): void {
        for (const session of this.sessions.values()) {
            this.clearActiveTimer(session.active)
        }
        this.sessions.clear()
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

        if (session.active?.turnId !== turnId) {
            return false
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

    private clearActiveTimer(active: ActiveTurn | null): void {
        if (!active?.expiryTimer) return
        clearTimeout(active.expiryTimer)
        active.expiryTimer = null
    }
}
