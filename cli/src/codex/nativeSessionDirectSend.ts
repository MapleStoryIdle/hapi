import type { ChildProcess } from 'node:child_process'
import spawnChildProcess from 'cross-spawn'
import { existsSync, statSync } from 'node:fs'
import {
    findLocalCodexSession,
    getLocalCodexSessionRunState,
    type CodexLocalSessionStatusRpcResponse,
    type SendCodexLocalSessionMessageRpcResponse
} from '@hapi/protocol/codexTranscript'

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

const RECENT_FAILURE_TTL_MS = 60_000
const MAX_FAILURE_MESSAGE_LENGTH = 400

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
 * Starts a one-shot `codex exec resume` against the original native thread.
 *
 * This controller does not create a HAPI Session or an app-server thread. Its
 * only state is a runner-local mutex, which protects concurrent sends issued
 * through HAPI while transcript lifecycle records protect against a native
 * Codex turn already in progress.
 */
export class NativeCodexSessionDirectSender {
    private readonly activeSends = new Map<string, ActiveSend>()
    private readonly recentFailures = new Map<string, RecentFailure>()

    constructor(
        private readonly spawnProcess: SpawnNativeCodexProcess = defaultSpawnNativeCodexProcess,
        private readonly now: () => number = Date.now
    ) {
    }

    getStatus(sessionId: string): CodexLocalSessionStatusRpcResponse {
        const active = this.activeSends.get(sessionId)
        if (active) {
            return {
                success: true,
                status: 'processing',
                startedAt: active.startedAt
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
            ...(recentFailure ? { lastError: recentFailure.message } : {})
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
        if (status.status === 'processing') {
            return { success: false, code: 'session_busy', error: 'This native Codex session is still processing' }
        }
        if (status.status === 'unknown') {
            return {
                success: false,
                code: 'session_status_unknown',
                error: 'Cannot confirm whether this native Codex session is idle'
            }
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

        const startedAt = this.now()
        let child: NativeCodexChildProcess
        try {
            // No model, effort, permission, or sandbox override is supplied.
            // `resume` reopens the exact source thread with its own stored
            // configuration instead of creating a HAPI-managed replacement.
            child = this.spawnProcess(['exec', 'resume', '--json', sessionId, message], cwd)
        } catch (error) {
            const failure = trimFailureMessage(error instanceof Error ? error.message : String(error))
            this.recentFailures.set(sessionId, { message: failure, occurredAt: startedAt })
            return { success: false, code: 'launch_failed', error: failure }
        }

        this.recentFailures.delete(sessionId)
        this.activeSends.set(sessionId, { startedAt, child })
        this.watch(sessionId, child)
        return { success: true, status: 'processing', startedAt }
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
                this.activeSends.delete(sessionId)
            }
            if (failure) {
                this.recentFailures.set(sessionId, {
                    message: trimFailureMessage(failure),
                    occurredAt: this.now()
                })
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
}
