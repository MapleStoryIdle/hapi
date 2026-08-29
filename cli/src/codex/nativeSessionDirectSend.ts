import type { ChildProcess } from 'node:child_process'
import spawnChildProcess from 'cross-spawn'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import {
    findLocalCodexSession,
    isHapiInitiatedCodexSession,
    type CodexLocalSessionSummary,
    type CodexLocalSessionQueuedMessage,
    type CodexLocalSessionStatusRpcResponse,
    type SendCodexLocalSessionMessageRpcResponse
} from '@hapi/protocol/codexTranscript'

type NativeCodexChildProcess = Pick<ChildProcess, 'once' | 'stderr'>

export type SpawnNativeCodexProcess = (args: string[], cwd: string) => NativeCodexChildProcess

export type NativeCodexSessionLookup = {
    getSummary: (sessionId: string) => CodexLocalSessionSummary | null
}

type ActiveSend = {
    startedAt: number
    child: NativeCodexChildProcess
}

type RecentFailure = {
    message: string
    occurredAt: number
}

type QueuedSend = CodexLocalSessionQueuedMessage

const RECENT_FAILURE_TTL_MS = 60_000
const MAX_FAILURE_MESSAGE_LENGTH = 400
const MAX_NATIVE_QUEUE_LENGTH = 50
const NATIVE_QUEUE_POLL_INTERVAL_MS = 1_000
const NATIVE_QUEUE_RETRY_INTERVAL_MS = 5_000

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

function defaultSpawnNativeCodexProcess(args: string[], cwd: string): NativeCodexChildProcess {
    return spawnChildProcess('codex', args, {
        cwd,
        // cross-spawn resolves Windows command shims without invoking a shell;
        // native transcript text may contain arbitrary user input.
        windowsHide: process.platform === 'win32',
        stdio: ['ignore', 'ignore', 'pipe']
    })
}

/**
 * Delivers a prompt to the original native Codex thread with `codex exec
 * resume` after a lifecycle-confirmed idle check.
 *
 * A machine can have a global Codex app-server control socket even when it
 * does not own this particular thread. Sending `codex queue` through that
 * socket acknowledges a message but can leave it in an unrelated daemon's
 * durable queue forever. Keep a runner-local FIFO instead of treating that
 * global socket as thread ownership.
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
        private readonly sessionLookup: NativeCodexSessionLookup = defaultSessionLookup
    ) {
    }

    /** Notify the runner when queue/launch state changes for another web client. */
    setStateChangeListener(listener: ((sessionId: string) => void) | null): void {
        this.stateChangeListener = listener
    }

    /** Release timers when the runner client is being torn down. */
    dispose(): void {
        for (const timer of this.queueTimers.values()) {
            clearTimeout(timer)
        }
        this.queueTimers.clear()
    }

    getStatus(
        sessionId: string,
        summary?: CodexLocalSessionSummary | null
    ): CodexLocalSessionStatusRpcResponse {
        return this.getStatusForSession(
            sessionId,
            summary === undefined ? this.sessionLookup.getSummary(sessionId) : summary
        )
    }

    /** Let the watcher release a FIFO item as soon as the raw turn closes. */
    notifyTranscriptChanged(sessionId: string): void {
        if (this.activeSends.has(sessionId) || !this.queues.get(sessionId)?.length) {
            return
        }
        this.scheduleQueuePump(sessionId, 0, { replacePending: true })
    }

    private getStatusForSession(
        sessionId: string,
        session: CodexLocalSessionSummary | null
    ): CodexLocalSessionStatusRpcResponse {
        const active = this.activeSends.get(sessionId)
        const queuedMessages = this.getQueuedMessages(sessionId)
        if (queuedMessages.length > 0) {
            this.scheduleQueuePump(sessionId)
        }
        if (active) {
            return {
                success: true,
                status: 'processing',
                startedAt: active.startedAt,
                queuedMessages
            }
        }

        if (!session) {
            return { success: false, error: 'Codex session not found' }
        }

        const recentFailure = this.getRecentFailure(sessionId)
        // A failed HAPI child may leave an error worth showing, but it must
        // never override the raw lifecycle state. An external Codex turn can
        // begin between the child exit and this status read.
        return {
            success: true,
            status: session.runState ?? 'unknown',
            ...(recentFailure ? { lastError: recentFailure.message } : {}),
            queuedMessages
        }
    }

    send(sessionId: string, rawMessage: unknown): SendCodexLocalSessionMessageRpcResponse {
        const message = typeof rawMessage === 'string' ? rawMessage.trim() : ''
        if (!message) {
            return { success: false, code: 'invalid_message', error: 'Message is required' }
        }

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

        // Once a queue exists, preserve FIFO order even if the transcript has
        // already become idle but the pump has not run its next tick yet.
        if (status.status === 'processing' || (this.queues.get(sessionId)?.length ?? 0) > 0) {
            return this.enqueue(sessionId, message)
        }
        if (status.status === 'unknown') {
            return {
                success: false,
                code: 'session_status_unknown',
                error: 'Cannot confirm whether this native Codex session is idle'
            }
        }

        return this.start(sessionId, message, cwd)
    }

    private enqueue(sessionId: string, message: string): SendCodexLocalSessionMessageRpcResponse {
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
            id: randomUUID(),
            text: message,
            queuedAt
        }
        queue.push(item)
        this.queues.set(sessionId, queue)
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
        message: string,
        cwd: string
    ): SendCodexLocalSessionMessageRpcResponse {
        const startedAt = this.now()

        const args = ['exec', 'resume', '--json', sessionId, message]
        let child: NativeCodexChildProcess
        try {
            child = this.spawnProcess(args, cwd)
        } catch (error) {
            const failure = trimFailureMessage(error instanceof Error ? error.message : String(error))
            this.recentFailures.set(sessionId, { message: failure, occurredAt: startedAt })
            this.notifyStateChange(sessionId)
            return { success: false, code: 'launch_failed', error: failure }
        }

        this.recentFailures.delete(sessionId)
        this.activeSends.set(sessionId, { startedAt, child })
        this.watch(sessionId, child)
        this.notifyStateChange(sessionId)
        return { success: true, status: 'processing', startedAt }
    }

    private finish(sessionId: string, active: ActiveSend, failure: string | null): void {
        const current = this.activeSends.get(sessionId)
        if (current !== active) return
        this.activeSends.delete(sessionId)
        if (failure) {
            this.recentFailures.set(sessionId, {
                message: failure,
                occurredAt: this.now()
            })
        }
        if (this.queues.get(sessionId)?.length) {
            this.scheduleQueuePump(
                sessionId,
                failure
                    ? NATIVE_QUEUE_RETRY_INTERVAL_MS
                    : this.queuePollIntervalMs
            )
        }
        this.notifyStateChange(sessionId)
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
        const finish = (failure: string | null) => {
            if (finished) return
            finished = true
            const active = this.activeSends.get(sessionId)
            if (active?.child === child) {
                this.finish(sessionId, active, failure ? trimFailureMessage(failure) : null)
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
        return [...(this.queues.get(sessionId) ?? [])]
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
        if (this.queueTimers.has(sessionId) || !this.queues.get(sessionId)?.length) {
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
            return
        }
        if (this.activeSends.has(sessionId)) {
            this.scheduleQueuePump(sessionId)
            return
        }

        const session = this.sessionLookup.getSummary(sessionId)
        // `codex exec resume` needs an idle transcript to avoid a second
        // writer. Do not infer ownership from a machine-global control socket:
        // it may belong to a different native Codex thread.
        if (session?.runState !== 'idle') {
            this.scheduleQueuePump(sessionId)
            return
        }

        const cwd = session?.cwd?.trim()
        if (!cwd || !this.isDirectory(cwd)) {
            this.recentFailures.set(sessionId, {
                message: 'The original Codex workspace is no longer available',
                occurredAt: this.now()
            })
            this.scheduleQueuePump(sessionId, NATIVE_QUEUE_RETRY_INTERVAL_MS)
            this.notifyStateChange(sessionId)
            return
        }

        const item = queue[0]
        const result = this.start(sessionId, item.text, cwd)
        if (result.success) {
            queue.shift()
            if (queue.length === 0) {
                this.queues.delete(sessionId)
            } else {
                // The active child owns the current command. `watch` releases
                // the next item after its native turn becomes idle.
                this.scheduleQueuePump(sessionId)
            }
            this.notifyStateChange(sessionId)
            return
        }

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
