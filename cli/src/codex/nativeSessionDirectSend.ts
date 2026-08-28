import type { ChildProcess } from 'node:child_process'
import spawnChildProcess from 'cross-spawn'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import {
    findLocalCodexSession,
    getLocalCodexSessionRunState,
    type CodexLocalSessionQueuedMessage,
    type CodexLocalSessionStatusRpcResponse,
    type SendCodexLocalSessionMessageRpcResponse
} from '@hapi/protocol/codexTranscript'
import { hasCodexAppServerControlSocket } from './codexControlSocket'

type NativeCodexChildProcess = Pick<ChildProcess, 'once' | 'stderr'>

export type SpawnNativeCodexProcess = (args: string[], cwd: string) => NativeCodexChildProcess

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
 * Delivers a prompt to the original native Codex thread. When a long-lived
 * app-server is present, delivery uses `codex queue`; otherwise it falls back
 * to `codex exec resume` after a lifecycle-confirmed idle check.
 *
 * This controller does not create a HAPI Session or an app-server thread. Its
 * fallback path keeps a runner-local mutex plus a small per-thread FIFO queue.
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
        private readonly hasControlSocket: () => boolean = hasCodexAppServerControlSocket
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

    getStatus(sessionId: string): CodexLocalSessionStatusRpcResponse {
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

        const state = getLocalCodexSessionRunState(sessionId)
        if (state === null) {
            return { success: false, error: 'Codex session not found' }
        }

        const recentFailure = this.getRecentFailure(sessionId)
        // A failed HAPI child may leave an error worth showing, but it must
        // never override the raw lifecycle state. An external Codex turn can
        // begin between the child exit and this status read.
        return {
            success: true,
            status: state,
            ...(recentFailure ? { lastError: recentFailure.message } : {}),
            queuedMessages
        }
    }

    send(sessionId: string, rawMessage: unknown): SendCodexLocalSessionMessageRpcResponse {
        const message = typeof rawMessage === 'string' ? rawMessage.trim() : ''
        if (!message) {
            return { success: false, code: 'invalid_message', error: 'Message is required' }
        }

        const status = this.getStatus(sessionId)
        if (status.success === false) {
            return { success: false, code: 'session_not_found', error: status.error }
        }

        const session = findLocalCodexSession(sessionId)
        const cwd = session?.cwd?.trim()
        if (!cwd || !this.isDirectory(cwd)) {
            return {
                success: false,
                code: 'workspace_unavailable',
                error: 'The original Codex workspace is no longer available'
            }
        }

        // A prompt sent while the native turn is running must remain visible
        // in HAPI's queue until that turn is idle. The app-server control
        // socket is still used for the eventual delivery, but it must not
        // bypass the queue here (otherwise the first queued prompt is hidden
        // from the web client).
        const controlSocketAvailable = this.hasControlSocket()
        // Once a queue exists, preserve FIFO order even if the transcript has
        // already become idle but the pump has not run its next tick yet.
        if (status.status === 'processing' || (this.queues.get(sessionId)?.length ?? 0) > 0) {
            return this.enqueue(sessionId, message)
        }
        if (status.status === 'unknown') {
            // An app-server control socket can serialize a prompt even when
            // older transcript formats do not expose lifecycle markers. There
            // is no trustworthy local waiting state in this case, so let the
            // owner accept it directly rather than blocking forever.
            if (controlSocketAvailable) {
                return this.start(sessionId, message, cwd, true)
            }
            return {
                success: false,
                code: 'session_status_unknown',
                error: 'Cannot confirm whether this native Codex session is idle'
            }
        }

        return this.start(sessionId, message, cwd, controlSocketAvailable)
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
        cwd: string,
        useControlSocket = this.hasControlSocket()
    ): SendCodexLocalSessionMessageRpcResponse {
        const startedAt = this.now()

        // When the native desktop/TUI app-server is alive it owns the thread
        // writer lock. `codex exec resume` would open a second writer and fail
        // with `thread-store conflict`. The official `codex queue` command
        // submits through that existing writer and is safe for both idle and
        // running threads.
        const args = useControlSocket
            ? ['queue', '--thread', sessionId, '--message', message]
            : ['exec', 'resume', '--json', sessionId, message]
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
                failure ? NATIVE_QUEUE_RETRY_INTERVAL_MS : this.queuePollIntervalMs
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

    private scheduleQueuePump(sessionId: string, delay = this.queuePollIntervalMs): void {
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

        // Keep a prompt visible in HAPI until the native transcript confirms
        // that the current turn is idle. This is important even when the
        // app-server control socket exists: submitting immediately would make
        // `codex queue` consume the local item before the user can see it.
        const state = getLocalCodexSessionRunState(sessionId)
        if (state !== 'idle') {
            this.scheduleQueuePump(sessionId)
            return
        }
        const controlSocketAvailable = this.hasControlSocket()

        const session = findLocalCodexSession(sessionId)
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
        const result = this.start(sessionId, item.text, cwd, controlSocketAvailable || undefined)
        if (result.success) {
            queue.shift()
            if (queue.length === 0) {
                this.queues.delete(sessionId)
            } else {
                // The active child owns the current message. The next item is
                // released by `watch` after this turn exits and the transcript
                // returns to idle.
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
