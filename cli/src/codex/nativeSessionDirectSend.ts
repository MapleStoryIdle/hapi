import type { ChildProcess } from 'node:child_process'
import spawnChildProcess from 'cross-spawn'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InitializeParams, ThreadResumeParams, TurnStartParams, TurnStartResponse } from './appServerTypes'
import {
    findLocalCodexSession,
    isHapiInitiatedCodexSession,
    type CodexLocalSessionDirectSendProgress,
    type CodexLocalSessionDirectSendRecoveryReason,
    type CodexLocalSessionQueuedMessage,
    type CodexLocalSessionStatusRpcResponse,
    type CodexLocalSessionSummary,
    type SendCodexLocalSessionMessageRpcResponse
} from '@hapi/protocol/codexTranscript'

type NativeCodexChildProcess = Pick<ChildProcess, 'once' | 'stderr'> & {
    kill?: ChildProcess['kill']
}

export type SpawnNativeCodexProcess = (args: string[], cwd: string) => NativeCodexChildProcess

/** The deliberately small app-server surface needed by the native bridge. */
export type NativeCodexAppServerClient = {
    connect: () => Promise<void>
    initialize: (params: InitializeParams) => Promise<unknown>
    resumeThread: (params: ThreadResumeParams, options?: { signal?: AbortSignal }) => Promise<unknown>
    startTurn: (params: TurnStartParams, options?: { signal?: AbortSignal }) => Promise<TurnStartResponse>
    disconnect: () => Promise<void>
    setNotificationHandler: (handler: ((method: string, params: unknown) => void) | null) => void
}

export type CreateNativeCodexAppServerClient = () => NativeCodexAppServerClient

export type NativeCodexSessionLookup = {
    getSummary: (sessionId: string) => CodexLocalSessionSummary | null
}

export type NativeCodexSessionDirectSendStoredItem = {
    sessionId: string
    id: string
    text: string
    deliveryText: string
    queuedAt: number
    recoveryRequired: boolean
    recoveryReason?: CodexLocalSessionDirectSendRecoveryReason
}

/**
 * Runner-local outbox for original Codex threads. A queue is deliberately
 * saved outside the browser so a runner handoff cannot silently drop it.
 */
export type NativeCodexSessionDirectSendStore = {
    load: () => NativeCodexSessionDirectSendStoredItem[]
    save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => void
}

type NativeCodexSessionDirectSendStoreFile = {
    version: 1
    items: NativeCodexSessionDirectSendStoredItem[]
}

function parseStoredItem(value: unknown): NativeCodexSessionDirectSendStoredItem | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const text = typeof record.text === 'string' ? record.text : ''
    const deliveryText = typeof record.deliveryText === 'string' ? record.deliveryText : ''
    const queuedAt = typeof record.queuedAt === 'number' ? record.queuedAt : Number.NaN
    const recoveryReason = parseRecoveryReason(record.recoveryReason)
    if (
        !sessionId
        || !id
        || id.length > MAX_CLIENT_MESSAGE_ID_LENGTH
        || !text.trim()
        || !deliveryText.trim()
        || !Number.isFinite(queuedAt)
        || queuedAt < 0
    ) {
        return null
    }
    const recoveryRequired = record.recoveryRequired === true
    return {
        sessionId,
        id,
        text,
        deliveryText,
        queuedAt,
        recoveryRequired,
        ...(recoveryRequired && recoveryReason ? { recoveryReason } : {})
    }
}

/**
 * Small, atomic JSON store with owner-only permissions. It contains pending
 * prompt text, which already lives in Codex's local transcript; do not put it
 * in the hub or any remote store.
 */
export class FileNativeCodexSessionDirectSendStore implements NativeCodexSessionDirectSendStore {
    constructor(private readonly filePath: string) {}

    load(): NativeCodexSessionDirectSendStoredItem[] {
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<NativeCodexSessionDirectSendStoreFile>
            if (parsed.version !== 1 || !Array.isArray(parsed.items)) return []
            return parsed.items
                .map(parseStoredItem)
                .filter((item): item is NativeCodexSessionDirectSendStoredItem => item !== null)
        } catch {
            return []
        }
    }

    save(items: readonly NativeCodexSessionDirectSendStoredItem[]): void {
        const directory = dirname(this.filePath)
        mkdirSync(directory, { recursive: true })
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`
        const payload: NativeCodexSessionDirectSendStoreFile = {
            version: 1,
            items: [...items]
        }
        writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
        renameSync(temporaryPath, this.filePath)
        chmodSync(this.filePath, 0o600)
    }
}

type ActiveSendBase = {
    startedAt: number
    /** Browser-generated id; makes a resend after navigation idempotent. */
    clientMessageId: string | null
    /** Expanded prompt passed to Codex. */
    deliveryText: string
    /** Browser-visible shorthand, retained if a launch race turns into a queue. */
    displayText: string
}

type ActiveExecSend = ActiveSendBase & {
    kind: 'exec-resume'
    child: NativeCodexChildProcess
    progress: CodexLocalSessionDirectSendProgress
    lifecycleTimer: ReturnType<typeof setTimeout> | null
}

type ActiveAppServerSend = ActiveSendBase & {
    kind: 'app-server'
    cwd: string
    client: NativeCodexAppServerClient
    progress: CodexLocalSessionDirectSendProgress
    initialModifiedAt: number
    turnStartAttempted: boolean
    turnAcceptedAt: number | null
    turnId: string | null
    observedProcessing: boolean
    lifecycleTimer: ReturnType<typeof setTimeout> | null
}

type ActiveSend = ActiveExecSend | ActiveAppServerSend

type ProcessingAcceptance = {
    success: true
    status: 'processing'
    startedAt: number
    progress?: CodexLocalSessionDirectSendProgress
    queuedMessages?: CodexLocalSessionQueuedMessage[]
}

type RecentFailure = {
    message: string
    occurredAt: number
    clientMessageId: string | null
    code: CodexLocalSessionDirectSendRecoveryReason
}

type QueuedSend = CodexLocalSessionQueuedMessage & {
    /** Actual prompt delivered to Codex; UI may retain the original shorthand. */
    deliveryText: string
    /** A prior runner could not prove delivery; never retry this automatically. */
    recoveryRequired: boolean
    recoveryReason?: CodexLocalSessionDirectSendRecoveryReason
}

const RECENT_FAILURE_TTL_MS = 60_000
const MAX_FAILURE_MESSAGE_LENGTH = 400
const MAX_NATIVE_QUEUE_LENGTH = 50
const NATIVE_QUEUE_POLL_INTERVAL_MS = 1_000
const NATIVE_QUEUE_RETRY_INTERVAL_MS = 5_000
const MAX_CLIENT_MESSAGE_ID_LENGTH = 160
const NATIVE_BRIDGE_LIFECYCLE_POLL_INTERVAL_MS = 1_000
const NATIVE_BRIDGE_SETUP_TIMEOUT_MS = 15_000
const NATIVE_BRIDGE_TURN_START_TIMEOUT_MS = 15_000
const NATIVE_BRIDGE_IDLE_OBSERVATION_GRACE_MS = 1_500
const NATIVE_BRIDGE_IDLE_TIMEOUT_MS = 20_000
const NATIVE_BRIDGE_UNKNOWN_TIMEOUT_MS = 20_000
const NATIVE_EXEC_EVIDENCE_TIMEOUT_MS = 20_000
const NATIVE_PROCESSING_STALE_AFTER_MS = 5 * 60 * 1_000

const defaultSessionLookup: NativeCodexSessionLookup = {
    getSummary: findLocalCodexSession
}

function trimFailureMessage(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return 'Codex direct send failed'
    return trimmed.length > MAX_FAILURE_MESSAGE_LENGTH
        ? `${trimmed.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`
        : trimmed
}

function parseRecoveryReason(value: unknown): CodexLocalSessionDirectSendRecoveryReason | null {
    return value === 'codex_timeout'
        || value === 'session_status_unknown'
        || value === 'launch_failed'
        || value === 'runner_restarted'
        ? value
        : null
}

function normalizeClientMessageId(value: unknown): string | null | 'invalid' {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') return 'invalid'
    const id = value.trim()
    // This id is never rendered as HTML or executed. Restrict it anyway so a
    // remote caller cannot turn the runner's in-memory maps into an arbitrary
    // unbounded-key store.
    if (!id || id.length > MAX_CLIENT_MESSAGE_ID_LENGTH || !/^[a-zA-Z0-9:._-]+$/.test(id)) {
        return 'invalid'
    }
    return id
}

function defaultSpawnNativeCodexProcess(args: string[], cwd: string): NativeCodexChildProcess {
    return spawnChildProcess('codex', args, {
        cwd,
        // cross-spawn resolves Windows command shims without invoking a shell;
        // native transcript text may contain arbitrary user input.
        windowsHide: process.platform === 'win32',
        stdio: ['ignore', 'ignore', 'pipe']
    })
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getNotificationThreadId(params: unknown): string | null {
    const record = asRecord(params)
    const thread = asRecord(record?.thread)
    return asString(record?.threadId ?? record?.thread_id ?? thread?.threadId ?? thread?.thread_id ?? thread?.id)
}

function getNotificationTurnId(params: unknown): string | null {
    const record = asRecord(params)
    const turn = asRecord(record?.turn)
    return asString(record?.turnId ?? record?.turn_id ?? turn?.turnId ?? turn?.turn_id ?? turn?.id)
}

function getNotificationStatus(params: unknown): string | null {
    const record = asRecord(params)
    const turn = asRecord(record?.turn)
    const status = asRecord(record?.status ?? turn?.status)
    return asString(record?.status) ?? asString(turn?.status) ?? asString(status?.type)
}

function getNotificationError(params: unknown): string | null {
    const record = asRecord(params)
    const status = asRecord(record?.status)
    return asString(record?.error ?? record?.message ?? record?.reason ?? status?.error ?? status?.message)
}

function getTurnId(response: TurnStartResponse): string | null {
    return asString(response.turn?.id)
}

/**
 * Delivers a prompt to the original native Codex thread after a
 * lifecycle-confirmed idle check.
 *
 * The primary path creates an app-server only for this hand-off, resumes the
 * exact thread, starts one turn, and disposes the bridge when it completes.
 * It is faster than `codex exec resume` while avoiding a machine-global
 * control socket and a stale, long-lived copy of a native thread. If bridge
 * setup fails before `turn/start`, the exact `exec resume` path remains the
 * safe fallback. Once `turn/start` was attempted, no automatic fallback is
 * allowed because it could duplicate the user's prompt.
 */
export class NativeCodexSessionDirectSender {
    private readonly activeSends = new Map<string, ActiveSend>()
    private readonly recentFailures = new Map<string, RecentFailure>()
    private readonly queues = new Map<string, QueuedSend[]>()
    private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private stateChangeListener: ((sessionId: string) => void) | null = null

    constructor(
        private readonly spawnProcess: SpawnNativeCodexProcess = defaultSpawnNativeCodexProcess,
        private readonly now: () => number = Date.now,
        private readonly queuePollIntervalMs: number = NATIVE_QUEUE_POLL_INTERVAL_MS,
        private readonly sessionLookup: NativeCodexSessionLookup = defaultSessionLookup,
        private readonly createAppServerClient: CreateNativeCodexAppServerClient | null = null,
        private readonly store: NativeCodexSessionDirectSendStore | null = null
    ) {
        this.restorePersistedQueues()
        for (const sessionId of this.queues.keys()) {
            // Safe queued receipts should continue without requiring a browser
            // to reopen the thread after a runner handoff. Recovery-required
            // entries are filtered by scheduleQueuePump and stay explicit.
            this.scheduleQueuePump(sessionId, 0)
        }
    }

    private restorePersistedQueues(): void {
        const restored = this.store?.load() ?? []
        for (const item of restored) {
            const queue = this.queues.get(item.sessionId) ?? []
            if (queue.length >= MAX_NATIVE_QUEUE_LENGTH || queue.some((queued) => queued.id === item.id)) {
                continue
            }
            queue.push({
                id: item.id,
                text: item.text,
                deliveryText: item.deliveryText,
                queuedAt: item.queuedAt,
                recoveryRequired: item.recoveryRequired,
                ...(item.recoveryReason ? { recoveryReason: item.recoveryReason } : {})
            })
            this.queues.set(item.sessionId, queue)
        }
    }

    private getActiveReceiptId(sessionId: string, active: ActiveSend): string {
        return active.clientMessageId ?? `native-active:${sessionId}:${active.startedAt}`
    }

    private preserveFailedActive(
        sessionId: string,
        active: ActiveSend,
        recoveryReason: CodexLocalSessionDirectSendRecoveryReason
    ): void {
        this.preserveFailedReceipt(sessionId, {
            id: this.getActiveReceiptId(sessionId, active),
            text: active.displayText,
            deliveryText: active.deliveryText,
            queuedAt: active.startedAt
        }, recoveryReason)
    }

    private preserveFailedReceipt(
        sessionId: string,
        receipt: Pick<NativeCodexSessionDirectSendStoredItem, 'id' | 'text' | 'deliveryText' | 'queuedAt'>,
        recoveryReason: CodexLocalSessionDirectSendRecoveryReason
    ): void {
        const queue = this.queues.get(sessionId) ?? []
        if (queue.some((item) => item.id === receipt.id)) return
        // The child or app-server may have received the prompt before its
        // failure response. Keep this receipt ahead of later FIFO items, but
        // never replay it without a person explicitly confirming the risk.
        queue.unshift({
            ...receipt,
            recoveryRequired: true,
            recoveryReason
        })
        this.queues.set(sessionId, queue)
    }

    private getPersistedItems(extra: readonly NativeCodexSessionDirectSendStoredItem[] = []): NativeCodexSessionDirectSendStoredItem[] {
        const items: NativeCodexSessionDirectSendStoredItem[] = []
        for (const [sessionId, active] of this.activeSends) {
            items.push({
                sessionId,
                id: this.getActiveReceiptId(sessionId, active),
                text: active.displayText,
                deliveryText: active.deliveryText,
                queuedAt: active.startedAt,
                // After a process handoff we cannot prove whether a started
                // child received the prompt. Surface it for manual retry.
                recoveryRequired: true,
                recoveryReason: 'runner_restarted'
            })
        }
        for (const [sessionId, queue] of this.queues) {
            for (const item of queue) {
                items.push({
                    sessionId,
                    id: item.id,
                    text: item.text,
                    deliveryText: item.deliveryText,
                    queuedAt: item.queuedAt,
                    recoveryRequired: item.recoveryRequired,
                    ...(item.recoveryReason ? { recoveryReason: item.recoveryReason } : {})
                })
            }
        }
        return [...extra, ...items]
    }

    private persistOutbox(extra: readonly NativeCodexSessionDirectSendStoredItem[] = []): boolean {
        if (!this.store) return true
        try {
            this.store.save(this.getPersistedItems(extra))
            return true
        } catch {
            return false
        }
    }

    private persistenceFailure(): Extract<SendCodexLocalSessionMessageRpcResponse, { success: false }> {
        return {
            success: false,
            code: 'launch_failed',
            error: 'Could not safely save this native message for recovery'
        }
    }

    /** Notify the runner when queue/launch state changes for another web client. */
    setStateChangeListener(listener: ((sessionId: string) => void) | null): void {
        this.stateChangeListener = listener
    }

    /** Release timers and our short-lived bridge processes on runner shutdown. */
    dispose(): void {
        for (const timer of this.queueTimers.values()) {
            clearTimeout(timer)
        }
        this.queueTimers.clear()

        for (const active of this.activeSends.values()) {
            if (active.kind === 'app-server') {
                this.disposeBridge(active)
            } else {
                this.disposeExec(active)
            }
        }
        // Keep the already-persisted active entries as recovery-required
        // receipts for the replacement runner. Do not silently retry them.
        this.persistOutbox()
        this.activeSends.clear()
    }

    getStatus(sessionId: string, summary?: CodexLocalSessionSummary | null): CodexLocalSessionStatusRpcResponse {
        return this.getStatusForSession(
            sessionId,
            summary === undefined ? this.sessionLookup.getSummary(sessionId) : summary
        )
    }

    /** Let the watcher update bridge progress and release a FIFO item on idle. */
    notifyTranscriptChanged(sessionId: string): void {
        const session = this.sessionLookup.getSummary(sessionId)
        this.reconcileActiveWithTranscript(sessionId, session)
        if (this.activeSends.has(sessionId) || !this.queues.get(sessionId)?.length) {
            return
        }
        this.scheduleQueuePump(sessionId, 0, { replacePending: true })
    }

    private getStatusForSession(
        sessionId: string,
        session: CodexLocalSessionSummary | null
    ): CodexLocalSessionStatusRpcResponse {
        this.reconcileActiveWithTranscript(sessionId, session)
        const active = this.activeSends.get(sessionId)
        const stalledSince = this.getStalledSince(session)
        const queuedMessages = this.getQueuedMessages(sessionId)
        if (queuedMessages.length > 0 && !queuedMessages[0]?.recoveryRequired) {
            this.scheduleQueuePump(sessionId)
        }
        if (active) {
            return {
                success: true,
                status: 'processing',
                startedAt: active.startedAt,
                progress: { ...active.progress },
                ...(stalledSince === null ? {} : { stalledSince }),
                queuedMessages
            }
        }

        if (!session) {
            return { success: false, error: 'Codex session not found' }
        }

        const recentFailure = this.getRecentFailure(sessionId)
        // A failed HAPI child may leave an error worth showing, but it must
        // never override the raw lifecycle state. An external Codex turn can
        // begin between a child exit and this status read.
        return {
            success: true,
            status: session.runState ?? 'unknown',
            ...(stalledSince === null ? {} : { stalledSince }),
            ...(recentFailure
                ? {
                    lastError: recentFailure.message,
                    lastErrorAt: recentFailure.occurredAt,
                    lastErrorCode: recentFailure.code,
                    ...(recentFailure.clientMessageId
                        ? { lastErrorClientMessageId: recentFailure.clientMessageId }
                        : {})
                }
                : {}),
            queuedMessages
        }
    }

    private getStalledSince(session: CodexLocalSessionSummary | null): number | null {
        if (!session || session.runState !== 'processing') return null
        const elapsed = this.now() - session.modifiedAt
        return elapsed >= NATIVE_PROCESSING_STALE_AFTER_MS ? session.modifiedAt : null
    }

    send(
        sessionId: string,
        rawMessage: unknown,
        rawDisplayMessage?: unknown,
        rawClientMessageId?: unknown,
        rawForceRecovery?: unknown
    ): SendCodexLocalSessionMessageRpcResponse {
        const message = typeof rawMessage === 'string' ? rawMessage.trim() : ''
        const forceRecovery = rawForceRecovery === true
        const clientMessageId = normalizeClientMessageId(rawClientMessageId)
        if (clientMessageId === 'invalid') {
            return {
                success: false,
                code: 'invalid_client_message_id',
                error: 'clientMessageId is invalid'
            }
        }
        if (!forceRecovery && !message) {
            return {
                success: false,
                code: 'invalid_message',
                error: 'Message is required'
            }
        }
        const displayMessage =
            typeof rawDisplayMessage === 'string' && rawDisplayMessage.trim() ? rawDisplayMessage.trim() : message

        const session = this.sessionLookup.getSummary(sessionId)
        const status = this.getStatusForSession(sessionId, session)
        if (status.success === false) {
            return { success: false, code: 'session_not_found', error: status.error }
        }

        if (!session || isHapiInitiatedCodexSession(session)) {
            return {
                success: false,
                code: 'not_native_session',
                error: 'Only original native Codex sessions support direct delivery'
            }
        }

        const cwd = session.cwd?.trim()
        if (!cwd || !this.isDirectory(cwd)) {
            return {
                success: false,
                code: 'workspace_unavailable',
                error: 'The original Codex workspace is no longer available'
            }
        }

        const previous = clientMessageId ? this.getExistingAcceptance(sessionId, clientMessageId) : null
        if (forceRecovery) {
            if (previous?.success === true && previous.status === 'processing') return previous
            return this.recoverMessage(
                sessionId,
                session,
                cwd,
                clientMessageId,
                message,
                displayMessage
            )
        }
        if (previous) {
            return previous
        }

        // Once a queue exists, preserve FIFO order even if the transcript has
        // already become idle but the pump has not run its next tick yet.
        if (status.status === 'processing' || (this.queues.get(sessionId)?.length ?? 0) > 0) {
            return this.enqueue(sessionId, message, displayMessage, clientMessageId)
        }
        if (status.status === 'unknown') {
            return {
                success: false,
                code: 'session_status_unknown',
                error: 'Cannot confirm whether this native Codex session is idle'
            }
        }

        return this.start(sessionId, message, displayMessage, cwd, session.modifiedAt, clientMessageId)
    }

    /**
     * A person explicitly confirmed this retry from the UI. This is the only
     * path allowed to bypass a stale `task_started` marker or resend a prompt
     * whose prior runner stopped before it could prove delivery.
     */
    private recoverMessage(
        sessionId: string,
        session: CodexLocalSessionSummary,
        cwd: string,
        clientMessageId: string | null,
        deliveryText: string,
        displayText: string
    ): SendCodexLocalSessionMessageRpcResponse {
        if (!clientMessageId) {
            return {
                success: false,
                code: 'invalid_client_message_id',
                error: 'clientMessageId is required for native recovery'
            }
        }

        // A confirmation is never permission to overlap a hand-off that this
        // runner still owns. The matching-id case was returned by `send`
        // above; any other active send must settle first.
        if (this.activeSends.has(sessionId)) {
            return {
                success: false,
                code: 'session_busy',
                error: 'A native message is already being delivered'
            }
        }

        const stale = this.getStalledSince(session) !== null
        const queue = this.queues.get(sessionId) ?? []
        const queueIndex = queue.findIndex((item) => item.id === clientMessageId)
        if (queueIndex > 0) {
            return {
                success: false,
                code: 'session_busy',
                error: 'An earlier native message must be recovered first'
            }
        }

        const queued = queueIndex === 0 ? queue[0] : null
        const requiresConfirmation = queued?.recoveryRequired === true
        if (!queued && !deliveryText) {
            return {
                success: false,
                code: 'invalid_message',
                error: 'Message is required for native recovery'
            }
        }
        if (!requiresConfirmation && !stale && queued) {
            return {
                success: false,
                code: 'session_busy',
                error: 'This native message is already waiting for a confirmed idle turn'
            }
        }
        if (session.runState === 'unknown') {
            return {
                success: false,
                code: 'session_status_unknown',
                error: 'Cannot confirm whether this native Codex session is idle'
            }
        }
        if (session.runState === 'processing' && !stale) {
            return {
                success: false,
                code: 'session_busy',
                error: 'The native Codex turn is still active'
            }
        }

        if (queued) {
            queue.shift()
            if (queue.length === 0) {
                this.queues.delete(sessionId)
            } else {
                this.queues.set(sessionId, queue)
            }
            const result = this.startExecResume(
                sessionId,
                queued.deliveryText,
                queued.text,
                cwd,
                queued.id
            )
            if (result.success) return result

            queue.unshift(queued)
            this.queues.set(sessionId, queue)
            this.persistOutbox()
            return result
        }

        // A browser can retain a receipt from a runner that restarted before
        // this outbox existed. Retrying it remains explicit and therefore
        // avoids a hidden duplicate even though no local queue item survived.
        return this.startExecResume(sessionId, deliveryText, displayText || deliveryText, cwd, clientMessageId)
    }

    private enqueue(
        sessionId: string,
        deliveryText: string,
        displayText: string,
        clientMessageId: string | null
    ): SendCodexLocalSessionMessageRpcResponse {
        const queue = this.queues.get(sessionId) ?? []
        if (queue.length >= MAX_NATIVE_QUEUE_LENGTH) {
            return {
                success: false,
                code: 'queue_full',
                error: `Native Codex queue is full (maximum ${MAX_NATIVE_QUEUE_LENGTH} messages)`
            }
        }

        const queuedAt = this.now()
        const item: QueuedSend = {
            id: clientMessageId ?? randomUUID(),
            text: displayText,
            deliveryText,
            queuedAt,
            recoveryRequired: false
        }
        queue.push(item)
        this.queues.set(sessionId, queue)
        if (!this.persistOutbox()) {
            queue.pop()
            if (queue.length === 0) {
                this.queues.delete(sessionId)
            }
            return this.persistenceFailure()
        }
        this.scheduleQueuePump(sessionId)
        this.notifyStateChange(sessionId)
        return {
            success: true,
            status: 'queued',
            queuedAt,
            queuePosition: queue.length,
            queueId: item.id,
            queuedMessages: this.getQueuedMessages(sessionId)
        }
    }

    private start(
        sessionId: string,
        deliveryText: string,
        displayText: string,
        cwd: string,
        initialModifiedAt: number,
        clientMessageId: string | null = null
    ): SendCodexLocalSessionMessageRpcResponse {
        if (this.createAppServerClient) {
            return this.startAppServerBridge(
                sessionId,
                deliveryText,
                displayText,
                cwd,
                initialModifiedAt,
                clientMessageId
            )
        }
        return this.startExecResume(sessionId, deliveryText, displayText, cwd, clientMessageId)
    }

    private startAppServerBridge(
        sessionId: string,
        deliveryText: string,
        displayText: string,
        cwd: string,
        initialModifiedAt: number,
        clientMessageId: string | null
    ): SendCodexLocalSessionMessageRpcResponse {
        const startedAt = this.now()
        let client: NativeCodexAppServerClient
        try {
            client = this.createAppServerClient!()
        } catch {
            // A factory failure has not touched the native thread. Use the
            // legacy exact-thread path instead of rejecting a valid message.
            return this.startExecResume(sessionId, deliveryText, displayText, cwd, clientMessageId, startedAt, 2)
        }

        const active: ActiveAppServerSend = {
            kind: 'app-server',
            startedAt,
            cwd,
            clientMessageId,
            deliveryText,
            displayText,
            client,
            progress: {
                phase: 'launching',
                startedAt,
                phaseStartedAt: startedAt,
                transport: 'app-server'
            },
            initialModifiedAt,
            turnStartAttempted: false,
            turnAcceptedAt: null,
            turnId: null,
            observedProcessing: false,
            lifecycleTimer: null
        }
        this.recentFailures.delete(sessionId)
        this.activeSends.set(sessionId, active)
        if (!this.persistOutbox()) {
            this.activeSends.delete(sessionId)
            this.disposeBridge(active)
            return this.persistenceFailure()
        }
        try {
            client.setNotificationHandler((method, params) => {
                this.handleBridgeNotification(sessionId, active, method, params)
            })
        } catch {
            this.activeSends.delete(sessionId)
            this.disposeBridge(active)
            this.persistOutbox()
            return this.startExecResume(sessionId, deliveryText, displayText, cwd, clientMessageId, startedAt, 2)
        }
        this.scheduleBridgeLifecycleCheck(sessionId, active)
        this.notifyStateChange(sessionId)
        void this.runAppServerBridge(sessionId, active, cwd)
        return this.getProcessingAcceptance(active)
    }

    private startExecResume(
        sessionId: string,
        deliveryText: string,
        displayText: string,
        cwd: string,
        clientMessageId: string | null = null,
        startedAt = this.now(),
        attempt = 1
    ): SendCodexLocalSessionMessageRpcResponse {
        // A native transcript may live outside a Git repository. We already
        // verify that its original workspace exists above, so do not let
        // Codex's interactive-project guard turn a valid direct message into
        // a child-process failure.
        const recoveryReceipt: NativeCodexSessionDirectSendStoredItem = {
            sessionId,
            id: clientMessageId ?? `native-active:${sessionId}:${startedAt}`,
            text: displayText,
            deliveryText,
            queuedAt: startedAt,
            recoveryRequired: true,
            recoveryReason: 'runner_restarted'
        }
        if (!this.persistOutbox([recoveryReceipt])) {
            return this.persistenceFailure()
        }
        const args = ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, deliveryText]
        let child: NativeCodexChildProcess
        try {
            child = this.spawnProcess(args, cwd)
        } catch (error) {
            const failure = trimFailureMessage(error instanceof Error ? error.message : String(error))
            this.preserveFailedReceipt(sessionId, recoveryReceipt, 'launch_failed')
            this.persistOutbox()
            this.recentFailures.set(sessionId, {
                message: failure,
                occurredAt: startedAt,
                clientMessageId,
                code: 'launch_failed'
            })
            this.notifyStateChange(sessionId)
            return { success: false, code: 'launch_failed', error: failure }
        }

        const active: ActiveExecSend = {
            kind: 'exec-resume',
            startedAt,
            child,
            clientMessageId,
            deliveryText,
            displayText,
            progress: {
                phase: attempt > 1 ? 'retrying' : 'launching',
                startedAt,
                phaseStartedAt: startedAt,
                transport: 'exec-resume',
                ...(attempt > 1 ? { attempt } : {})
            },
            lifecycleTimer: null
        }
        this.recentFailures.delete(sessionId)
        this.activeSends.set(sessionId, active)
        // The reservation above contains the same receipt. Write the active
        // map once more so a future format change cannot leave two variants.
        this.persistOutbox()
        this.watch(sessionId, child)
        this.scheduleExecLifecycleCheck(sessionId, active)
        this.notifyStateChange(sessionId)
        return this.getProcessingAcceptance(active)
    }

    private async runAppServerBridge(sessionId: string, active: ActiveAppServerSend, cwd: string): Promise<void> {
        try {
            this.setBridgePhase(sessionId, active, 'matching')
            await active.client.connect()
            if (!this.isCurrentActive(sessionId, active)) return

            await active.client.initialize({
                clientInfo: {
                    // Keep the bridge distinct from a HAPI-owned session. The
                    // original native transcript must remain visible as native.
                    name: 'hapi-native-session-bridge',
                    title: 'HAPI Native Session Bridge',
                    version: '1.0.0'
                },
                capabilities: { experimentalApi: true }
            })
            if (!this.isCurrentActive(sessionId, active)) return

            if (!this.isNativeSessionStillIdle(sessionId)) {
                this.deferBridgeBeforeTurn(
                    sessionId,
                    active,
                    cwd,
                    'Native Codex started another turn before the hand-off'
                )
                return
            }

            await active.client.resumeThread({ threadId: sessionId })
            if (!this.isCurrentActive(sessionId, active)) return

            this.setBridgePhase(sessionId, active, 'connected')
            if (!this.isNativeSessionStillIdle(sessionId)) {
                this.deferBridgeBeforeTurn(
                    sessionId,
                    active,
                    cwd,
                    'Native Codex started another turn while matching the Agent'
                )
                return
            }

            // This is the irrevocable edge. A thrown or timed-out request may
            // still have reached Codex, so any failure after this line is
            // surfaced rather than retried through exec resume.
            active.turnStartAttempted = true
            const response = await active.client.startTurn({
                threadId: sessionId,
                input: [{ type: 'text', text: active.deliveryText }]
            })
            if (!this.isCurrentActive(sessionId, active)) return

            active.turnAcceptedAt = this.now()
            active.turnId = getTurnId(response)
            this.notifyStateChange(sessionId)
        } catch (error) {
            if (!this.isCurrentActive(sessionId, active)) return
            const failure = trimFailureMessage(error instanceof Error ? error.message : String(error))
            if (!active.turnStartAttempted) {
                this.fallbackAfterBridgeSetupFailure(sessionId, active, cwd, failure)
                return
            }
            // turn/start may have reached Codex even when its response did
            // not make it back. Keep the prompt as an explicit recovery
            // receipt instead of describing this ambiguous edge as a simple
            // launch failure.
            this.finish(sessionId, active, failure, 'session_status_unknown')
        }
    }

    private handleBridgeNotification(
        sessionId: string,
        active: ActiveAppServerSend,
        method: string,
        params: unknown
    ): void {
        if (!this.isCurrentActive(sessionId, active)) return

        const threadId = getNotificationThreadId(params)
        const turnId = getNotificationTurnId(params)
        if (threadId && threadId !== sessionId) return
        if (active.turnId && turnId && turnId !== active.turnId) return

        if (method === 'thread/status/changed' && getNotificationStatus(params)?.toLowerCase() === 'systemerror') {
            const failure = getNotificationError(params) ?? 'Codex native thread entered a system error'
            if (!active.turnStartAttempted) {
                this.fallbackAfterBridgeSetupFailure(sessionId, active, active.cwd, failure)
            } else {
                this.finish(sessionId, active, failure, 'session_status_unknown')
            }
            return
        }

        if (method === 'turn/started' || method === 'thread/status/changed') {
            // A missing thread id on turn/started is intentionally ignored
            // until startTurn returned its turn id. Child-agent events can
            // share the app-server connection with the parent native thread.
            if (method === 'turn/started' && !threadId && !active.turnId) return
            active.observedProcessing = true
            this.setBridgePhase(sessionId, active, 'reasoning')
            return
        }

        if (method !== 'turn/completed') return
        // Do not let an unscoped completion emitted before startTurn returns
        // close this bridge; its id cannot yet be tied to our exact request.
        if (!threadId && !active.turnId) return
        const status = getNotificationStatus(params)?.toLowerCase()
        const failure = getNotificationError(params)
        if (
            status === 'failed' ||
            status === 'error' ||
            status === 'interrupted' ||
            status === 'cancelled' ||
            status === 'canceled'
        ) {
            this.finish(
                sessionId,
                active,
                failure ?? `Codex native turn ${status}`,
                'session_status_unknown'
            )
            return
        }
        this.finish(sessionId, active, null)
    }

    private isNativeSessionStillIdle(sessionId: string): boolean {
        return this.sessionLookup.getSummary(sessionId)?.runState === 'idle'
    }

    /**
     * Before turn/start, setup failure cannot have written the user's prompt.
     * Recheck the lifecycle: fall back on idle, or preserve FIFO by queueing
     * behind a native turn that won the race.
     */
    private fallbackAfterBridgeSetupFailure(
        sessionId: string,
        active: ActiveAppServerSend,
        cwd: string,
        setupFailure: string
    ): void {
        if (!this.isCurrentActive(sessionId, active)) return
        this.detachBridge(sessionId, active)
        const session = this.sessionLookup.getSummary(sessionId)
        if (session?.runState === 'idle') {
            const result = this.startExecResume(
                sessionId,
                active.deliveryText,
                active.displayText,
                cwd,
                active.clientMessageId,
                active.startedAt,
                2
            )
            if (result.success) return
            this.recordBridgeFallbackFailure(sessionId, active, result)
            return
        }
        if (session?.runState === 'processing') {
            const queued = this.enqueue(sessionId, active.deliveryText, active.displayText, active.clientMessageId)
            if (queued.success) return
        }
        this.preserveFailedActive(sessionId, active, 'session_status_unknown')
        this.persistOutbox()
        this.recentFailures.set(sessionId, {
            message: `Could not set up native Codex hand-off: ${setupFailure}`,
            occurredAt: this.now(),
            clientMessageId: active.clientMessageId,
            code: 'session_status_unknown'
        })
        this.notifyStateChange(sessionId)
    }

    private deferBridgeBeforeTurn(sessionId: string, active: ActiveAppServerSend, cwd: string, reason: string): void {
        if (!this.isCurrentActive(sessionId, active)) return
        this.detachBridge(sessionId, active)
        const session = this.sessionLookup.getSummary(sessionId)
        if (session?.runState === 'processing') {
            const queued = this.enqueue(sessionId, active.deliveryText, active.displayText, active.clientMessageId)
            if (queued.success) return
        }
        if (session?.runState === 'idle') {
            // A stale watcher update can report idle right after the race.
            // exec resume still performs an exact-thread open, so it remains
            // the safe pre-turn fallback in this narrow case.
            const result = this.startExecResume(
                sessionId,
                active.deliveryText,
                active.displayText,
                cwd,
                active.clientMessageId,
                active.startedAt,
                2
            )
            if (!result.success) {
                this.recordBridgeFallbackFailure(sessionId, active, result)
            }
            return
        }
        this.preserveFailedActive(sessionId, active, 'session_status_unknown')
        this.persistOutbox()
        this.recentFailures.set(sessionId, {
            message: reason,
            occurredAt: this.now(),
            clientMessageId: active.clientMessageId,
            code: 'session_status_unknown'
        })
        this.notifyStateChange(sessionId)
    }

    private recordBridgeFallbackFailure(
        sessionId: string,
        active: ActiveAppServerSend,
        result: Extract<SendCodexLocalSessionMessageRpcResponse, { success: false }>
    ): void {
        // The primary bridge never reached turn/start here, so a failed
        // fallback is a known launch problem rather than an ambiguous Codex
        // execution. The browser still retains its local receipt.
        this.recentFailures.set(sessionId, {
            message: result.error,
            occurredAt: this.now(),
            clientMessageId: active.clientMessageId,
            code: result.code === 'session_status_unknown' ? 'session_status_unknown' : 'launch_failed'
        })
        this.notifyStateChange(sessionId)
    }

    private reconcileActiveWithTranscript(sessionId: string, session: CodexLocalSessionSummary | null): void {
        const active = this.activeSends.get(sessionId)
        if (!active) return

        if (active.kind === 'exec-resume') {
            if (session?.runState === 'processing') {
                this.setExecPhase(sessionId, active, 'reasoning')
            }
            return
        }

        if (active.turnAcceptedAt === null) return

        if (session?.runState === 'processing') {
            active.observedProcessing = true
            this.setBridgePhase(sessionId, active, 'reasoning')
            return
        }

        if (session?.runState !== 'idle') return
        const elapsed = this.now() - active.turnAcceptedAt
        if (active.observedProcessing && session.modifiedAt > active.initialModifiedAt) {
            this.finish(sessionId, active, null)
            return
        }
        // A tiny turn can begin and finish between two watcher reads. Its
        // updated transcript timestamp is enough evidence to release this
        // short-lived bridge after a small settle window.
        if (elapsed >= NATIVE_BRIDGE_IDLE_OBSERVATION_GRACE_MS && session.modifiedAt > active.initialModifiedAt) {
            this.finish(sessionId, active, null)
        }
    }

    private scheduleExecLifecycleCheck(sessionId: string, active: ActiveExecSend): void {
        if (!this.isCurrentActive(sessionId, active) || active.lifecycleTimer) return
        const timer = setTimeout(() => {
            active.lifecycleTimer = null
            if (!this.isCurrentActive(sessionId, active)) return

            const session = this.sessionLookup.getSummary(sessionId)
            this.reconcileActiveWithTranscript(sessionId, session)
            if (!this.isCurrentActive(sessionId, active)) return

            const elapsed = this.now() - active.startedAt
            if ((session === null || session.runState === 'unknown') && elapsed >= NATIVE_EXEC_EVIDENCE_TIMEOUT_MS) {
                this.expireExec(sessionId, active, 'Codex did not report whether it received the fallback turn', 'session_status_unknown')
                return
            }
            if (session?.runState === 'idle' && elapsed >= NATIVE_EXEC_EVIDENCE_TIMEOUT_MS) {
                this.expireExec(sessionId, active, 'Codex did not update its native transcript after fallback delivery', 'codex_timeout')
                return
            }
            if (this.getStalledSince(session) !== null) {
                this.expireExec(sessionId, active, 'Codex stopped reporting native activity', 'codex_timeout')
                return
            }
            this.scheduleExecLifecycleCheck(sessionId, active)
        }, NATIVE_BRIDGE_LIFECYCLE_POLL_INTERVAL_MS)
        timer.unref?.()
        active.lifecycleTimer = timer
    }

    private expireExec(
        sessionId: string,
        active: ActiveExecSend,
        message: string,
        code: CodexLocalSessionDirectSendRecoveryReason
    ): void {
        try {
            active.child.kill?.('SIGTERM')
        } catch {
            // The child may already have exited; either way this hand-off is no longer trusted.
        }
        this.finish(sessionId, active, message, code)
    }

    private scheduleBridgeLifecycleCheck(sessionId: string, active: ActiveAppServerSend): void {
        if (!this.isCurrentActive(sessionId, active) || active.lifecycleTimer) return
        const timer = setTimeout(() => {
            active.lifecycleTimer = null
            if (!this.isCurrentActive(sessionId, active)) return

            const session = this.sessionLookup.getSummary(sessionId)
            this.reconcileActiveWithTranscript(sessionId, session)
            if (!this.isCurrentActive(sessionId, active)) return

            const elapsed = this.now() - active.startedAt
            if (!active.turnStartAttempted && elapsed >= NATIVE_BRIDGE_SETUP_TIMEOUT_MS) {
                this.fallbackAfterBridgeSetupFailure(
                    sessionId,
                    active,
                    active.cwd,
                    'Timed out while matching the native Agent'
                )
                return
            }
            if (
                active.turnStartAttempted
                && active.turnAcceptedAt === null
                && elapsed >= NATIVE_BRIDGE_TURN_START_TIMEOUT_MS
            ) {
                this.finish(sessionId, active, 'Timed out while starting the native Codex turn', 'codex_timeout')
                return
            }
            const acceptedElapsed = active.turnAcceptedAt === null ? null : this.now() - active.turnAcceptedAt
            if (
                acceptedElapsed !== null
                && (session === null || session.runState === 'unknown')
                && acceptedElapsed >= NATIVE_BRIDGE_UNKNOWN_TIMEOUT_MS
            ) {
                this.finish(
                    sessionId,
                    active,
                    'Codex did not report whether it received the native turn',
                    'session_status_unknown'
                )
                return
            }
            if (active.turnAcceptedAt !== null && this.getStalledSince(session) !== null) {
                this.finish(sessionId, active, 'Codex stopped reporting native activity', 'codex_timeout')
                return
            }
            if (
                active.turnAcceptedAt !== null &&
                session?.runState === 'idle' &&
                acceptedElapsed !== null &&
                acceptedElapsed >= NATIVE_BRIDGE_IDLE_TIMEOUT_MS
            ) {
                this.finish(sessionId, active, 'Codex accepted the turn but did not update its native transcript', 'codex_timeout')
                return
            }
            this.scheduleBridgeLifecycleCheck(sessionId, active)
        }, NATIVE_BRIDGE_LIFECYCLE_POLL_INTERVAL_MS)
        timer.unref?.()
        active.lifecycleTimer = timer
    }

    private setBridgePhase(
        sessionId: string,
        active: ActiveAppServerSend,
        phase: CodexLocalSessionDirectSendProgress['phase']
    ): void {
        if (!this.isCurrentActive(sessionId, active) || active.progress.phase === phase) return
        active.progress = {
            ...active.progress,
            phase,
            phaseStartedAt: this.now()
        }
        this.notifyStateChange(sessionId)
    }

    private setExecPhase(
        sessionId: string,
        active: ActiveExecSend,
        phase: CodexLocalSessionDirectSendProgress['phase']
    ): void {
        if (!this.isCurrentActive(sessionId, active) || active.progress.phase === phase) return
        active.progress = {
            ...active.progress,
            phase,
            phaseStartedAt: this.now()
        }
        this.notifyStateChange(sessionId)
    }

    private getProcessingAcceptance(active: ActiveSend): ProcessingAcceptance {
        return {
            success: true,
            status: 'processing',
            startedAt: active.startedAt,
            progress: { ...active.progress }
        }
    }

    private finish(
        sessionId: string,
        active: ActiveSend,
        failure: string | null,
        failureCode: CodexLocalSessionDirectSendRecoveryReason = 'launch_failed'
    ): void {
        if (!this.isCurrentActive(sessionId, active)) return
        this.activeSends.delete(sessionId)
        if (active.kind === 'app-server') {
            this.disposeBridge(active)
        } else {
            this.disposeExec(active)
        }
        if (failure) {
            this.recentFailures.set(sessionId, {
                message: failure,
                occurredAt: this.now(),
                clientMessageId: active.clientMessageId,
                code: failureCode
            })
            this.preserveFailedActive(sessionId, active, failureCode)
        }
        this.persistOutbox()
        if (this.queues.get(sessionId)?.length && !this.queues.get(sessionId)?.[0]?.recoveryRequired) {
            this.scheduleQueuePump(sessionId, failure ? NATIVE_QUEUE_RETRY_INTERVAL_MS : this.queuePollIntervalMs)
        }
        this.notifyStateChange(sessionId)
    }

    private detachBridge(sessionId: string, active: ActiveAppServerSend): void {
        if (!this.isCurrentActive(sessionId, active)) return
        this.activeSends.delete(sessionId)
        this.disposeBridge(active)
        this.persistOutbox()
    }

    private disposeBridge(active: ActiveAppServerSend): void {
        if (active.lifecycleTimer) {
            clearTimeout(active.lifecycleTimer)
            active.lifecycleTimer = null
        }
        try {
            active.client.setNotificationHandler(null)
        } catch {
            // Disconnection is best effort; the client has no more state owner.
        }
        void active.client.disconnect().catch(() => {})
    }

    private disposeExec(active: ActiveExecSend): void {
        if (active.lifecycleTimer) {
            clearTimeout(active.lifecycleTimer)
            active.lifecycleTimer = null
        }
    }

    private isCurrentActive(sessionId: string, active: ActiveSend): boolean {
        return this.activeSends.get(sessionId) === active
    }

    private watch(sessionId: string, child: NativeCodexChildProcess): void {
        let stderr = ''
        child.stderr?.setEncoding?.('utf8')
        child.stderr?.on?.('data', (chunk: unknown) => {
            if (stderr.length >= MAX_FAILURE_MESSAGE_LENGTH) return
            const next = typeof chunk === 'string' ? chunk : String(chunk)
            stderr = `${stderr}${next}`.slice(0, MAX_FAILURE_MESSAGE_LENGTH)
        })

        let finished = false
        const finish = (
            failure: string | null,
            failureCode: CodexLocalSessionDirectSendRecoveryReason = 'session_status_unknown'
        ) => {
            if (finished) return
            finished = true
            const active = this.activeSends.get(sessionId)
            if (active?.kind === 'exec-resume' && active.child === child) {
                this.finish(sessionId, active, failure ? trimFailureMessage(failure) : null, failureCode)
            }
        }

        child.once('error', (error: Error) => {
            finish(error.message)
        })
        child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            if (code === 0) {
                finish(null)
                return
            }
            const status = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`
            finish(stderr || `Codex direct send exited with ${status}`)
        })
    }

    private getQueuedMessages(sessionId: string): CodexLocalSessionQueuedMessage[] {
        return (this.queues.get(sessionId) ?? []).map(({ id, text, queuedAt, recoveryRequired, recoveryReason }) => ({
            id,
            text,
            queuedAt,
            ...(recoveryRequired ? { recoveryRequired: true } : {}),
            ...(recoveryReason ? { recoveryReason } : {})
        }))
    }

    /**
     * A page can disappear after submitting its POST but before observing the
     * 202 response. If it retries with the same browser id, report the
     * existing hand-off instead of starting or enqueueing the prompt twice.
     */
    private getExistingAcceptance(
        sessionId: string,
        clientMessageId: string
    ): SendCodexLocalSessionMessageRpcResponse | null {
        const active = this.activeSends.get(sessionId)
        if (active?.clientMessageId === clientMessageId) {
            return {
                ...this.getProcessingAcceptance(active),
                queuedMessages: this.getQueuedMessages(sessionId)
            }
        }

        const queue = this.queues.get(sessionId) ?? []
        const position = queue.findIndex((message) => message.id === clientMessageId)
        if (position === -1) return null
        const item = queue[position]!
        return {
            success: true,
            status: 'queued',
            queuedAt: item.queuedAt,
            queuePosition: position + 1,
            queueId: item.id,
            queuedMessages: this.getQueuedMessages(sessionId)
        }
    }

    private scheduleQueuePump(
        sessionId: string,
        delay = this.queuePollIntervalMs,
        options: { replacePending?: boolean } = {}
    ): void {
        const existing = this.queueTimers.get(sessionId)
        if (existing && options.replacePending) {
            clearTimeout(existing)
            this.queueTimers.delete(sessionId)
        }
        const queue = this.queues.get(sessionId)
        if (this.queueTimers.has(sessionId) || !queue?.length || queue[0]?.recoveryRequired) {
            return
        }
        const timer = setTimeout(() => {
            this.queueTimers.delete(sessionId)
            this.pumpQueue(sessionId)
        }, delay)
        // A waiting native queue must not keep an otherwise idle test process
        // alive. The production runner stays alive through its socket loop.
        timer.unref?.()
        this.queueTimers.set(sessionId, timer)
    }

    private pumpQueue(sessionId: string): void {
        const queue = this.queues.get(sessionId)
        if (!queue || queue.length === 0) {
            this.queues.delete(sessionId)
            this.persistOutbox()
            return
        }
        if (queue[0]?.recoveryRequired) {
            return
        }
        if (this.activeSends.has(sessionId)) {
            this.scheduleQueuePump(sessionId)
            return
        }

        const session = this.sessionLookup.getSummary(sessionId)
        // A delivery bridge must never race a second writer. Do not infer
        // ownership from a machine-global control socket: it may belong to a
        // different native Codex thread.
        if (session?.runState !== 'idle') {
            this.scheduleQueuePump(sessionId)
            return
        }

        const cwd = session.cwd?.trim()
        if (!cwd || !this.isDirectory(cwd)) {
            this.recentFailures.set(sessionId, {
                message: 'The original Codex workspace is no longer available',
                occurredAt: this.now(),
                clientMessageId: queue[0]?.id ?? null,
                code: 'launch_failed'
            })
            this.scheduleQueuePump(sessionId, NATIVE_QUEUE_RETRY_INTERVAL_MS)
            this.notifyStateChange(sessionId)
            return
        }

        const item = queue.shift()!
        if (queue.length === 0) {
            this.queues.delete(sessionId)
        }
        const result = this.start(sessionId, item.deliveryText, item.text, cwd, session.modifiedAt, item.id)
        if (result.success) {
            if (queue.length > 0) {
                // The active bridge owns the current command. Its completion
                // releases the next item after the native turn becomes idle.
                this.scheduleQueuePump(sessionId)
            }
            this.notifyStateChange(sessionId)
            return
        }

        queue.unshift(item)
        this.queues.set(sessionId, queue)
        this.persistOutbox()
        // Keep the item intact on a launch race/failure. The next attempt is
        // delayed so a broken Codex binary does not create a hot loop.
        this.scheduleQueuePump(sessionId, NATIVE_QUEUE_RETRY_INTERVAL_MS)
    }

    private getRecentFailure(sessionId: string): RecentFailure | null {
        const failure = this.recentFailures.get(sessionId)
        if (!failure) return null
        if (this.now() - failure.occurredAt <= RECENT_FAILURE_TTL_MS) {
            return failure
        }
        this.recentFailures.delete(sessionId)
        return null
    }

    private isDirectory(path: string): boolean {
        try {
            return existsSync(path) && statSync(path).isDirectory()
        } catch {
            return false
        }
    }

    private notifyStateChange(sessionId: string): void {
        try {
            this.stateChangeListener?.(sessionId)
        } catch {
            // Live invalidation is best effort; direct delivery must remain usable.
        }
    }
}
