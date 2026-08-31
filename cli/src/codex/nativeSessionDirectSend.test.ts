import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    FileNativeCodexSessionDirectSendStore,
    NativeCodexSessionDirectSender,
    type NativeCodexAppServerClient,
    type SpawnNativeCodexProcess
} from './nativeSessionDirectSend'
import type { InitializeParams, ThreadResumeParams, TurnStartParams, TurnStartResponse } from './appServerTypes'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
    vi.useRealTimers()
    if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
    } else {
        process.env.CODEX_HOME = originalCodexHome
    }
})

class FakeChildProcess extends EventEmitter {
    readonly stderr = Object.assign(new EventEmitter(), {
        setEncoding: () => {}
    })
}

class FakeAppServerClient implements NativeCodexAppServerClient {
    notificationHandler: ((method: string, params: unknown) => void) | null = null
    connectCalls = 0
    initializeCalls: InitializeParams[] = []
    resumeCalls: ThreadResumeParams[] = []
    startTurnCalls: TurnStartParams[] = []
    disconnectCalls = 0
    resumeError: Error | null = null
    startTurnError: Error | null = null

    async connect(): Promise<void> {
        this.connectCalls += 1
    }

    async initialize(params: InitializeParams): Promise<unknown> {
        this.initializeCalls.push(params)
        return {}
    }

    async resumeThread(params: ThreadResumeParams): Promise<unknown> {
        this.resumeCalls.push(params)
        if (this.resumeError) throw this.resumeError
        return { thread: { id: params.threadId } }
    }

    async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
        this.startTurnCalls.push(params)
        if (this.startTurnError) throw this.startTurnError
        return { turn: { id: 'native-turn-1' } }
    }

    async disconnect(): Promise<void> {
        this.disconnectCalls += 1
    }

    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler
    }

    emit(method: string, params: unknown): void {
        this.notificationHandler?.(method, params)
    }
}

async function flushAsyncWork(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
        await Promise.resolve()
    }
}

function writeTranscript(options: {
    codexHome: string
    sessionId: string
    cwd: string
    events: string[]
}): void {
    const sessionDir = join(options.codexHome, 'sessions', '2026', '08', '26')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, `rollout-${options.sessionId}.jsonl`), [
        JSON.stringify({ type: 'session_meta', payload: { id: options.sessionId, cwd: options.cwd } }),
        ...options.events.map((eventType) => JSON.stringify({ type: 'event_msg', payload: { type: eventType } }))
    ].join('\n'))
}

describe('NativeCodexSessionDirectSender', () => {
    it('uses one short-lived app-server bridge for an exact native thread', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-bridge-workspace-'))
        const sessionId = '80345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'idle'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        }))
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: lookup },
            () => client
        )

        try {
            expect(sender.send(sessionId, 'Continue through the bridge', undefined, 'native:bridge-1')).toEqual({
                success: true,
                status: 'processing',
                startedAt: 123,
                progress: {
                    phase: 'matching',
                    startedAt: 123,
                    phaseStartedAt: 123,
                    transport: 'app-server'
                }
            })

            await flushAsyncWork()
            expect(client.connectCalls).toBe(1)
            expect(client.initializeCalls).toEqual([{
                clientInfo: {
                    name: 'hapi-native-session-bridge',
                    title: 'HAPI Native Session Bridge',
                    version: '1.0.0'
                },
                capabilities: { experimentalApi: true }
            }])
            expect(client.resumeCalls).toEqual([{ threadId: sessionId }])
            expect(client.startTurnCalls).toEqual([{
                threadId: sessionId,
                input: [{ type: 'text', text: 'Continue through the bridge' }]
            }])
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                progress: { phase: 'connected', transport: 'app-server' }
            })

            // The app-server can announce the turn a few milliseconds before
            // the transcript watcher sees its first append. Do not dispose
            // the bridge just because the cached transcript is still idle.
            client.emit('turn/started', {
                thread: { id: sessionId },
                turn: { id: 'native-turn-1' }
            })
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                progress: { phase: 'reasoning' }
            })
            expect(client.disconnectCalls).toBe(0)

            runState = 'processing'
            sender.notifyTranscriptChanged(sessionId)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                progress: { phase: 'reasoning' }
            })

            runState = 'idle'
            client.emit('turn/completed', {
                thread: { id: sessionId },
                turn: { id: 'native-turn-1' },
                status: 'completed'
            })
            expect(sender.getStatus(sessionId)).toEqual({ success: true, status: 'idle', queuedMessages: [] })
            expect(client.disconnectCalls).toBe(1)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('falls back to exact exec resume only when bridge setup fails before turn start', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-bridge-fallback-workspace-'))
        const sessionId = '81345678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const client = new FakeAppServerClient()
        client.resumeError = new Error('resume unavailable')
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            () => client
        )

        try {
            expect(sender.send(sessionId, 'Fallback exactly once')).toMatchObject({
                success: true,
                status: 'processing',
                progress: { transport: 'app-server', phase: 'matching' }
            })
            await flushAsyncWork()

            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'Fallback exactly once'],
                cwd
            )
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                progress: {
                    phase: 'retrying',
                    transport: 'exec-resume',
                    attempt: 2
                }
            })
            expect(client.disconnectCalls).toBe(1)
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('waits for an external native writer before retrying a safe pre-turn conflict', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-active-writer-workspace-'))
        const sessionId = '81845678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'idle'
        let modifiedAt = 100
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt,
            runState
        }))
        const blockedClient = new FakeAppServerClient()
        blockedClient.resumeError = new Error('thread-store conflict: thread already has an active writer')
        const readyClient = new FakeAppServerClient()
        let nextClient = 0
        const createClient = vi.fn(() => [blockedClient, readyClient][nextClient++]!)
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            createClient
        )

        try {
            expect(sender.send(sessionId, 'Wait for the original Codex turn', undefined, 'native:active-writer')).toMatchObject({
                success: true,
                status: 'processing'
            })
            expect(sender.send(sessionId, 'Stay behind the first prompt', undefined, 'native:after-active-writer')).toMatchObject({
                success: true,
                status: 'queued'
            })
            await flushMicrotasks()

            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toEqual({
                success: true,
                status: 'idle',
                queuedMessages: [{
                    id: 'native:active-writer',
                    text: 'Wait for the original Codex turn',
                    queuedAt: 123
                }, {
                    id: 'native:after-active-writer',
                    text: 'Stay behind the first prompt',
                    queuedAt: 123
                }]
            })

            // The cache can still say idle immediately after the conflict. Do
            // not keep opening bridges until the original native turn appears.
            await vi.advanceTimersByTimeAsync(5_000)
            expect(createClient).toHaveBeenCalledTimes(1)

            runState = 'processing'
            modifiedAt = 101
            sender.notifyTranscriptChanged(sessionId)
            await vi.advanceTimersByTimeAsync(0)
            expect(createClient).toHaveBeenCalledTimes(1)

            runState = 'idle'
            modifiedAt = 102
            sender.notifyTranscriptChanged(sessionId)
            await vi.advanceTimersByTimeAsync(0)
            await flushMicrotasks()

            expect(createClient).toHaveBeenCalledTimes(2)
            expect(readyClient.startTurnCalls).toEqual([{
                threadId: sessionId,
                input: [{ type: 'text', text: 'Wait for the original Codex turn' }]
            }])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not fall back after turn/start could already have accepted the prompt', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-bridge-ambiguous-workspace-'))
        const sessionId = '82345678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const client = new FakeAppServerClient()
        client.startTurnError = new Error('turn start response lost')
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            () => client
        )

        try {
            expect(sender.send(sessionId, 'Never duplicate this', undefined, 'native:ambiguous-1')).toMatchObject({
                success: true,
                status: 'processing'
            })
            await flushAsyncWork()

            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                lastError: 'turn start response lost',
                lastErrorClientMessageId: 'native:ambiguous-1'
            })
            expect(client.disconnectCalls).toBe(1)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('stops an accepted bridge that stays unknown and saves an explicit recovery receipt', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-bridge-unknown-workspace-'))
        const sessionId = '83345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'unknown' = 'idle'
        let now = 0
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        }))
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => now,
            1_000,
            { getSummary: lookup },
            () => client
        )

        try {
            expect(sender.send(sessionId, 'Do not spin forever', undefined, 'native:unknown-bridge')).toMatchObject({
                success: true,
                status: 'processing'
            })
            await flushMicrotasks()
            expect(client.startTurnCalls).toHaveLength(1)

            runState = 'unknown'
            now = 20_001
            await vi.advanceTimersByTimeAsync(1_000)

            expect(client.disconnectCalls).toBe(1)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'unknown',
                lastErrorClientMessageId: 'native:unknown-bridge',
                lastErrorCode: 'session_status_unknown',
                queuedMessages: [{
                    id: 'native:unknown-bridge',
                    text: 'Do not spin forever',
                    recoveryRequired: true,
                    recoveryReason: 'session_status_unknown'
                }]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('stops a fallback child with no transcript evidence and saves it for recovery', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-exec-unknown-workspace-'))
        const sessionId = '84345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'unknown' = 'idle'
        let now = 0
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        }))
        const child = new FakeChildProcess()
        const kill = vi.fn(() => true)
        Object.assign(child, { kill })
        const sender = new NativeCodexSessionDirectSender(
            () => child as never,
            () => now,
            1_000,
            { getSummary: lookup }
        )

        try {
            expect(sender.send(sessionId, 'Confirm fallback delivery', undefined, 'native:unknown-exec')).toMatchObject({
                success: true,
                status: 'processing',
                progress: { phase: 'launching', transport: 'exec-resume' }
            })

            runState = 'unknown'
            now = 20_001
            await vi.advanceTimersByTimeAsync(1_000)

            expect(kill).toHaveBeenCalledWith('SIGTERM')
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'unknown',
                lastErrorCode: 'session_status_unknown',
                queuedMessages: [{
                    id: 'native:unknown-exec',
                    recoveryRequired: true,
                    recoveryReason: 'session_status_unknown'
                }]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('starts codex exec resume only for a lifecycle-confirmed idle native thread', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-codex-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-workspace-'))
        const sessionId = '12345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete'] })

        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 123)

        try {
            expect(sender.getStatus(sessionId)).toEqual({ success: true, status: 'idle', queuedMessages: [] })
            expect(sender.send(sessionId, '  Continue this work  ')).toEqual({
                success: true,
                status: 'processing',
                startedAt: 123,
                progress: {
                    phase: 'launching',
                    startedAt: 123,
                    phaseStartedAt: 123,
                    transport: 'exec-resume'
                }
            })
            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'Continue this work'],
                cwd
            )
            expect(sender.getStatus(sessionId)).toEqual({
                success: true,
                status: 'processing',
                startedAt: 123,
                progress: {
                    phase: 'launching',
                    startedAt: 123,
                    phaseStartedAt: 123,
                    transport: 'exec-resume'
                },
                queuedMessages: []
            })

            child.emit('exit', 0, null)
            expect(sender.getStatus(sessionId)).toEqual({ success: true, status: 'idle', queuedMessages: [] })
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('treats a retried browser receipt as the same native hand-off', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-idempotent-workspace-'))
        const sessionId = '10345678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 0,
            runState: 'idle' as const
        }))
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 789, 1_000, { getSummary: lookup })

        try {
            expect(sender.send(sessionId, 'Continue after navigation', undefined, 'native:receipt-1')).toEqual({
                success: true,
                status: 'processing',
                startedAt: 789,
                progress: {
                    phase: 'launching',
                    startedAt: 789,
                    phaseStartedAt: 789,
                    transport: 'exec-resume'
                }
            })
            expect(sender.send(sessionId, 'Continue after navigation', undefined, 'native:receipt-1')).toEqual({
                success: true,
                status: 'processing',
                startedAt: 789,
                progress: {
                    phase: 'launching',
                    startedAt: 789,
                    phaseStartedAt: 789,
                    transport: 'exec-resume'
                },
                queuedMessages: []
            })
            expect(spawn).toHaveBeenCalledTimes(1)
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not send through an unrelated machine-global app-server socket', async () => {
        // Windows does not expose Unix socket paths through this test harness.
        if (process.platform === 'win32') return

        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-global-socket-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-global-socket-workspace-'))
        const sessionId = '13345678-1234-4234-8234-123456789012'
        const socketDir = join(codexHome, 'app-server-control')
        const socketPath = join(socketDir, 'app-server-control.sock')
        mkdirSync(socketDir, { recursive: true })
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete'] })

        const controlServer = createServer()
        await new Promise<void>((resolve, reject) => {
            controlServer.once('error', reject)
            controlServer.listen(socketPath, resolve)
        })
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 456)

        try {
            expect(sender.send(sessionId, 'do not use the global queue')).toMatchObject({
                success: true,
                status: 'processing'
            })
            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'do not use the global queue'],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            await new Promise<void>((resolve) => controlServer.close(() => resolve()))
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('uses one cached lookup and lets only original native threads receive direct prompts', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-cache-workspace-'))
        const sessionId = '11345678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'HAPI-created thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 0,
            originator: 'hapi-codex-client',
            runState: 'idle' as const
        }))
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(spawn, Date.now, 1_000, {
            getSummary: lookup
        })

        try {
            expect(sender.send(sessionId, 'do not forward')).toEqual({
                success: false,
                code: 'not_native_session',
                error: 'Only original native Codex sessions support direct delivery'
            })
            expect(lookup).toHaveBeenCalledTimes(1)
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('releases a queued prompt immediately when the transcript watcher sees idle', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-watcher-workspace-'))
        const sessionId = '21345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'processing'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 0,
            runState
        }))
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 321, 1_000, {
            getSummary: lookup
        })

        try {
            expect(sender.send(sessionId, 'release as soon as idle')).toMatchObject({
                success: true,
                status: 'queued'
            })
            runState = 'idle'
            sender.notifyTranscriptChanged(sessionId)

            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'release as soon as idle'],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a queued native message through a runner restart', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-persisted-queue-workspace-'))
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-native-direct-persisted-queue-store-'))
        const sessionId = '24345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'processing'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        }))
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        const firstSender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 500,
            10,
            { getSummary: lookup },
            null,
            store
        )
        const child = new FakeChildProcess()
        const resumedSpawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        let replacementSender: NativeCodexSessionDirectSender | null = null

        try {
            expect(firstSender.send(sessionId, 'keep this message', undefined, 'native:persisted-queue')).toMatchObject({
                success: true,
                status: 'queued'
            })
            firstSender.dispose()
            replacementSender = new NativeCodexSessionDirectSender(
                resumedSpawn,
                () => 501,
                10,
                { getSummary: lookup },
                null,
                store
            )

            expect(replacementSender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [{ id: 'native:persisted-queue', text: 'keep this message' }]
            })

            runState = 'idle'
            replacementSender.notifyTranscriptChanged(sessionId)
            await new Promise((resolve) => setTimeout(resolve, 20))

            expect(resumedSpawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'keep this message'],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            firstSender.dispose()
            replacementSender?.dispose()
            rmSync(cwd, { recursive: true, force: true })
            rmSync(storeDir, { recursive: true, force: true })
        }
    })

    it('resumes a safe persisted queue after restart without reopening the thread', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-persisted-autopump-workspace-'))
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-native-direct-persisted-autopump-store-'))
        const sessionId = '24445678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'processing'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        }))
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        const firstSender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 500,
            10,
            { getSummary: lookup },
            null,
            store
        )
        const child = new FakeChildProcess()
        const resumedSpawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        let replacementSender: NativeCodexSessionDirectSender | null = null

        try {
            expect(firstSender.send(sessionId, 'deliver without reopening', undefined, 'native:persisted-autopump')).toMatchObject({
                success: true,
                status: 'queued'
            })
            firstSender.dispose()

            runState = 'idle'
            replacementSender = new NativeCodexSessionDirectSender(
                resumedSpawn,
                () => 501,
                10,
                { getSummary: lookup },
                null,
                store
            )

            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(resumedSpawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'deliver without reopening'],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            firstSender.dispose()
            replacementSender?.dispose()
            rmSync(cwd, { recursive: true, force: true })
            rmSync(storeDir, { recursive: true, force: true })
        }
    })

    it('requires an explicit retry when the runner stopped during a native hand-off', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-recovery-workspace-'))
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-native-direct-recovery-store-'))
        const sessionId = '25345678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        const firstChild = new FakeChildProcess()
        const firstSender = new NativeCodexSessionDirectSender(
            () => firstChild as never,
            () => 600,
            10,
            { getSummary: lookup },
            null,
            store
        )
        const retryChild = new FakeChildProcess()
        const retrySpawn = vi.fn<SpawnNativeCodexProcess>(() => retryChild as never)
        let replacementSender: NativeCodexSessionDirectSender | null = null

        try {
            expect(firstSender.send(sessionId, 'confirm before retry', undefined, 'native:uncertain-handoff')).toMatchObject({
                success: true,
                status: 'processing'
            })
            expect(firstSender.send(sessionId, 'wait behind the uncertain hand-off', undefined, 'native:after-uncertain')).toMatchObject({
                success: true,
                status: 'queued'
            })
            firstSender.dispose()
            replacementSender = new NativeCodexSessionDirectSender(
                retrySpawn,
                () => 601,
                10,
                { getSummary: lookup },
                null,
                store
            )

            expect(replacementSender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                queuedMessages: [{
                    id: 'native:uncertain-handoff',
                    text: 'confirm before retry',
                    recoveryRequired: true
                }, {
                    id: 'native:after-uncertain',
                    text: 'wait behind the uncertain hand-off'
                }]
            })
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(retrySpawn).not.toHaveBeenCalled()

            expect(replacementSender.send(
                sessionId,
                'confirm before retry',
                undefined,
                'native:uncertain-handoff',
                true
            )).toMatchObject({ success: true, status: 'processing' })
            expect(retrySpawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'confirm before retry'],
                cwd
            )
        } finally {
            firstSender.dispose()
            replacementSender?.dispose()
            rmSync(cwd, { recursive: true, force: true })
            rmSync(storeDir, { recursive: true, force: true })
        }
    })

    it('persists a failed native hand-off as a recovery-required receipt', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-failed-recovery-workspace-'))
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-native-direct-failed-recovery-store-'))
        const sessionId = '25545678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        const failedChild = new FakeChildProcess()
        const firstSender = new NativeCodexSessionDirectSender(
            () => failedChild as never,
            () => 700,
            10,
            { getSummary: lookup },
            null,
            store
        )
        const resumedSpawn = vi.fn<SpawnNativeCodexProcess>()
        let replacementSender: NativeCodexSessionDirectSender | null = null

        try {
            expect(firstSender.send(sessionId, 'keep uncertain failure', undefined, 'native:failed-handoff')).toMatchObject({
                success: true,
                status: 'processing'
            })
            failedChild.emit('exit', 1, null)
            expect(firstSender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                lastErrorClientMessageId: 'native:failed-handoff',
                queuedMessages: [{
                    id: 'native:failed-handoff',
                    text: 'keep uncertain failure',
                    recoveryRequired: true
                }]
            })

            firstSender.dispose()
            replacementSender = new NativeCodexSessionDirectSender(
                resumedSpawn,
                () => 701,
                10,
                { getSummary: lookup },
                null,
                store
            )
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(replacementSender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                queuedMessages: [{
                    id: 'native:failed-handoff',
                    recoveryRequired: true
                }]
            })
            expect(resumedSpawn).not.toHaveBeenCalled()
        } finally {
            firstSender.dispose()
            replacementSender?.dispose()
            rmSync(cwd, { recursive: true, force: true })
            rmSync(storeDir, { recursive: true, force: true })
        }
    })

    it('retries a synchronous launch failure automatically because no native turn started', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-launch-failure-workspace-'))
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-native-direct-launch-failure-store-'))
        const sessionId = '25645678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        const retryChild = new FakeChildProcess()
        let launchAttempts = 0
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => {
            launchAttempts += 1
            if (launchAttempts === 1) {
                throw new Error('codex executable unavailable')
            }
            return retryChild as never
        })
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 700,
            10,
            { getSummary: lookup },
            null,
            store
        )

        try {
            expect(sender.send(sessionId, 'Keep this launch failure', undefined, 'native:launch-failure')).toMatchObject({
                success: true,
                status: 'queued',
                queueId: 'native:launch-failure'
            })
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                queuedMessages: [{
                    id: 'native:launch-failure',
                    text: 'Keep this launch failure'
                }]
            })

            await vi.advanceTimersByTimeAsync(5_000)
            expect(spawn).toHaveBeenCalledTimes(2)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                progress: { transport: 'exec-resume' },
                queuedMessages: []
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
            rmSync(storeDir, { recursive: true, force: true })
        }
    })

    it('marks a quiet processing transcript as stalled and only recovers it after confirmation', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-stalled-workspace-'))
        const sessionId = '26345678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 1,
            runState: 'processing' as const
        }))
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 5 * 60 * 1_000 + 1,
            10,
            { getSummary: lookup }
        )

        try {
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                stalledSince: 1
            })
            expect(sender.send(sessionId, 'recover this', undefined, 'native:stalled')).toMatchObject({
                success: true,
                status: 'queued'
            })
            expect(spawn).not.toHaveBeenCalled()

            expect(sender.send(sessionId, 'recover this', undefined, 'native:stalled', true)).toMatchObject({
                success: true,
                status: 'processing'
            })
            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'recover this'],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not let a recovery confirmation overlap an active native hand-off', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-recovery-overlap-workspace-'))
        const sessionId = '26445678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 500, 10, { getSummary: lookup })

        try {
            expect(sender.send(sessionId, 'first hand-off', undefined, 'native:first-active')).toMatchObject({
                success: true,
                status: 'processing'
            })

            expect(sender.send(
                sessionId,
                'do not overlap',
                undefined,
                'native:second-recovery',
                true
            )).toEqual({
                success: false,
                code: 'session_busy',
                error: 'A native message is already being delivered'
            })
            expect(spawn).toHaveBeenCalledTimes(1)
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('notifies the runner when direct-send lifecycle state changes', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-notify-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-notify-workspace-'))
        const sessionId = '92345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete'] })

        const child = new FakeChildProcess()
        const sender = new NativeCodexSessionDirectSender(() => child as never)
        const onStateChange = vi.fn()
        sender.setStateChangeListener(onStateChange)

        try {
            expect(sender.send(sessionId, 'continue')).toMatchObject({ success: true, status: 'processing' })
            child.emit('exit', 0, null)

            expect(onStateChange).toHaveBeenNthCalledWith(1, sessionId)
            expect(onStateChange).toHaveBeenNthCalledWith(2, sessionId)
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('queues while the native transcript is processing and keeps unknown state locked', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-state-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-workspace-'))
        const activeSessionId = '22345678-1234-4234-8234-123456789012'
        const legacySessionId = '32345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId: activeSessionId, cwd, events: ['task_started'] })
        writeTranscript({ codexHome, sessionId: legacySessionId, cwd, events: [] })
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(spawn)

        try {
            const queued = sender.send(activeSessionId, 'hello')
            expect(queued).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 1,
                queuedMessages: [{ text: 'hello' }]
            })
            expect(sender.getStatus(activeSessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [{ text: 'hello' }]
            })
            expect(sender.send(legacySessionId, 'hello')).toMatchObject({
                success: false,
                code: 'session_status_unknown'
            })
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('releases queued messages in order after the native turn becomes idle', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-queue-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-queue-workspace-'))
        const sessionId = '52345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId, cwd, events: ['task_started'] })

        const firstChild = new FakeChildProcess()
        const secondChild = new FakeChildProcess()
        const children = [firstChild, secondChild]
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => children.shift() as never)
        const sender = new NativeCodexSessionDirectSender(spawn, Date.now, 10)

        try {
            expect(sender.send(sessionId, 'first')).toMatchObject({ success: true, status: 'queued' })
            expect(sender.send(sessionId, 'second')).toMatchObject({ success: true, status: 'queued', queuePosition: 2 })

            writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete'] })
            await new Promise((resolve) => setTimeout(resolve, 40))

            expect(spawn).toHaveBeenCalledTimes(1)
            expect(spawn).toHaveBeenNthCalledWith(1, ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'first'], cwd)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [{ text: 'second' }]
            })

            writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete', 'task_started', 'task_complete'] })
            firstChild.emit('exit', 0, null)
            await new Promise((resolve) => setTimeout(resolve, 40))

            expect(spawn).toHaveBeenCalledTimes(2)
            expect(spawn).toHaveBeenNthCalledWith(2, ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'second'], cwd)
            expect(sender.getStatus(sessionId)).toMatchObject({ success: true, status: 'processing', queuedMessages: [] })
            secondChild.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a custom-command shorthand in the queue while delivering its expanded prompt', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-display-workspace-'))
        const sessionId = '62345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'processing'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 0,
            runState
        }))
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, Date.now, 10, { getSummary: lookup })

        try {
            const deliveryText = 'Review the requested code.\n\nUser arguments: src/index.ts'
            expect(sender.send(sessionId, deliveryText, '/review src/index.ts')).toMatchObject({
                success: true,
                status: 'queued',
                queuedMessages: [{ text: '/review src/index.ts' }]
            })

            runState = 'idle'
            sender.notifyTranscriptChanged(sessionId)
            await new Promise((resolve) => setTimeout(resolve, 20))

            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, deliveryText],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not unlock a raw native turn after a failed HAPI-started child', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-failure-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-workspace-'))
        const sessionId = '42345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete'] })

        const child = new FakeChildProcess()
        const sender = new NativeCodexSessionDirectSender(() => child as never)

        try {
            expect(sender.send(sessionId, 'hello')).toMatchObject({ success: true })
            // A native turn may have started immediately after the child was
            // launched. Its explicit lifecycle must win over our local error.
            writeTranscript({ codexHome, sessionId, cwd, events: ['task_started'] })
            child.emit('exit', 1, null)

            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                lastError: 'Codex direct send exited with exit 1'
            })
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })
})
