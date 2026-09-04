import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
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
import { NativeKanbanFeedbackStore } from './nativeKanbanFeedbackStore'
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

const reviewGuard = {
    stagePath: '/runner-private/native-kanban-feedback/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/feedback.md',
    sha256: 'a'.repeat(64)
}

function acceptsReviewGuard() {
    return { success: true as const }
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
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
    it('rejects fresh SSH-controlled send and archive requests before creating a receipt or app-server call', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-controlled-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789099'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const externalControlChecker = vi.fn(async () => true)
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            null,
            null,
            null,
            externalControlChecker
        )
        const archiveAttempt = vi.fn(async () => ({ success: true as const }))

        try {
            await expect(sender.sendWithExternalControlCheck(sessionId, 'Do not queue this')).resolves.toMatchObject({
                success: false,
                code: 'external_writer_active'
            })
            await expect(sender.archive(sessionId, archiveAttempt)).resolves.toMatchObject({
                success: false,
                code: 'external_writer_active'
            })
            expect(spawn).not.toHaveBeenCalled()
            expect(archiveAttempt).not.toHaveBeenCalled()
            expect(externalControlChecker).toHaveBeenCalledTimes(2)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('checks SSH ownership again before starting an already queued native receipt', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-queue-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789098'
        let runState: 'idle' | 'processing' = 'processing'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        })
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const externalControlChecker = vi.fn(async () => true)
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1,
            { getSummary: lookup },
            null,
            null,
            null,
            externalControlChecker
        )

        try {
            expect(sender.send(sessionId, 'Keep this durable queue')).toMatchObject({ success: true, status: 'queued' })
            runState = 'idle'
            sender.notifyTranscriptChanged(sessionId)
            await new Promise((resolve) => setTimeout(resolve, 20))

            expect(externalControlChecker).toHaveBeenCalled()
            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                queuedMessages: [{ text: 'Keep this durable queue' }]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not start a queued bridge when shutdown wins an in-flight ownership check', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-dispose-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789097'
        let runState: 'idle' | 'processing' = 'processing'
        let resolveOwnership!: (held: boolean) => void
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const externalControlChecker = vi.fn(() => new Promise<boolean>((resolve) => {
            resolveOwnership = resolve
        }))
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState
                })
            },
            null,
            null,
            null,
            externalControlChecker
        )

        try {
            expect(sender.send(sessionId, 'Keep this receipt while stopping')).toMatchObject({
                success: true,
                status: 'queued'
            })
            runState = 'idle'
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushMicrotasks()
            expect(externalControlChecker).toHaveBeenCalledTimes(1)

            sender.dispose()
            resolveOwnership(false)
            await flushMicrotasks()

            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('reserves an idle native thread so a new send and queue pump cannot race archive', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-archive-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789013'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        let releaseArchive!: () => void
        const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve })
        const sender = new NativeCodexSessionDirectSender(spawn, () => 123, 1_000, { getSummary: lookup })

        try {
            const archive = sender.archive(sessionId, async () => {
                await archiveGate
                return { success: true as const }
            })
            await flushMicrotasks()

            expect(sender.send(sessionId, 'Do not race archive')).toEqual({
                success: false,
                code: 'session_busy',
                error: 'Native Codex session is being archived'
            })
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            expect(spawn).not.toHaveBeenCalled()

            releaseArchive()
            await expect(archive).resolves.toEqual({ success: true })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('allows destructive archive of external work but protects SHAPI hand-offs and queued receipts', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-archive-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789014'
        let runState: 'idle' | 'processing' | 'unknown' = 'processing'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        })
        const child = new FakeChildProcess()
        const archiveAttempt = vi.fn(async () => ({ success: true as const }))
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(() => child as never),
            () => 123,
            1_000,
            { getSummary: lookup }
        )

        try {
            await expect(sender.archive(sessionId, archiveAttempt)).resolves.toEqual({ success: true })
            runState = 'unknown'
            await expect(sender.archive(sessionId, archiveAttempt)).resolves.toEqual({ success: true })
            expect(archiveAttempt).toHaveBeenCalledTimes(2)

            runState = 'idle'
            expect(sender.send(sessionId, 'SHAPI hand-off before archive')).toMatchObject({ success: true, status: 'processing' })
            await expect(sender.archive(sessionId, archiveAttempt)).resolves.toMatchObject({
                success: false,
                code: 'session_busy'
            })
            child.emit('exit', 0, null)

            runState = 'processing'
            expect(sender.send(sessionId, 'Queued before archive')).toMatchObject({ success: true, status: 'queued' })
            runState = 'idle'
            await expect(sender.archive(sessionId, async () => ({ success: true as const }))).resolves.toMatchObject({
                success: false,
                code: 'session_queued'
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an accepted untrusted Kanban review idempotent across a runner restart', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789012'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const persisted: Array<Record<string, unknown>> = []
        const store = {
            load: () => persisted as never,
            save: (items: readonly Record<string, unknown>[]) => {
                persisted.splice(0, persisted.length, ...items.map((item) => ({ ...item })))
            }
        }
        const client = new FakeAppServerClient()
        const first = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: lookup },
            () => client,
            store as never,
            acceptsReviewGuard
        )
        try {
            expect(first.send(
                sessionId,
                'Read the staged review path only',
                'Review feedback: report.md',
                'hapi-kanban-review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                false,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()
            expect(client.resumeCalls[0]).toMatchObject({
                threadId: sessionId,
                sandbox: 'read-only',
                approvalPolicy: 'on-request'
            })
            expect(persisted).toEqual([expect.objectContaining({
                accepted: true,
                deliveryPolicy: 'untrusted-review',
                recoveryRequired: false
            })])
            client.emit('turn/completed', {
                thread: { id: sessionId },
                turn: { id: 'native-turn-1' },
                status: 'completed'
            })
            expect(persisted).toEqual([expect.objectContaining({
                accepted: true,
                completed: true,
                deliveryPolicy: 'untrusted-review'
            })])
            first.dispose()

            const secondClient = new FakeAppServerClient()
            const second = new NativeCodexSessionDirectSender(
                vi.fn<SpawnNativeCodexProcess>(),
                () => 124,
                1_000,
            { getSummary: lookup },
            () => secondClient,
            store as never,
            acceptsReviewGuard
            )
            expect(second.send(
                sessionId,
                'Read the staged review path only',
                'Review feedback: report.md',
                'hapi-kanban-review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                false,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({ success: true, status: 'processing' })
            expect(secondClient.connectCalls).toBe(0)
            expect(second.discard(sessionId, 'hapi-kanban-review:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({
                success: true,
                discarded: true
            })
        } finally {
            first.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an untrusted review read-only when app-server setup falls back to exec', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-exec-workspace-'))
        const sessionId = '80345678-1234-4234-8234-123456789013'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const client = new FakeAppServerClient()
        client.resumeError = new Error('bridge unavailable')
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            () => client,
            null,
            acceptsReviewGuard
        )

        try {
            expect(sender.send(
                sessionId,
                'Read only the staged path',
                'Review feedback: report.md',
                'hapi-kanban-review:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                false,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()
            expect(spawn).toHaveBeenCalledWith([
                '--sandbox', 'read-only', '--ask-for-approval', 'on-request',
                'exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'Read only the staged path'
            ], cwd)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an external-writer rejected review as a durable FIFO receipt until it can run', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-writer-workspace-'))
        const sessionId = '81345678-1234-4234-8234-123456789013'
        let runState: 'idle' | 'processing' = 'idle'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        })
        const persisted: Array<Record<string, unknown>> = []
        const saves: Array<Array<Record<string, unknown>>> = []
        const store = {
            load: () => persisted as never,
            save: (items: readonly Record<string, unknown>[]) => {
                const copy = items.map((item) => ({ ...item }))
                persisted.splice(0, persisted.length, ...copy)
                saves.push(copy)
            }
        }
        const client = new FakeAppServerClient()
        client.resumeError = new Error('thread-store conflict: active writer')
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1,
            { getSummary: lookup },
            () => client,
            store as never,
            acceptsReviewGuard
        )

        try {
            expect(sender.send(
                sessionId,
                'Read the staged review path only',
                'Review feedback: report.md',
                'hapi-kanban-review:cccccccccccccccccccccccccccccccc',
                false,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({ success: true, status: 'processing' })
            const savesBeforeConflict = saves.length
            await flushMicrotasks()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                queuedMessages: [expect.objectContaining({ id: 'hapi-kanban-review:cccccccccccccccccccccccccccccccc' })]
            })
            expect(persisted).toEqual([expect.objectContaining({
                id: 'hapi-kanban-review:cccccccccccccccccccccccccccccccc',
                deliveryPolicy: 'untrusted-review',
                recoveryRequired: false
            })])
            expect(saves.slice(savesBeforeConflict)).toEqual([[
                expect.objectContaining({
                    id: 'hapi-kanban-review:cccccccccccccccccccccccccccccccc',
                    deliveryPolicy: 'untrusted-review',
                    recoveryRequired: false
                })
            ]])

            client.resumeError = null
            runState = 'idle'
            sender.notifyTranscriptChanged(sessionId)
            await vi.advanceTimersByTimeAsync(5_000)
            expect(client.startTurnCalls).toHaveLength(1)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a recovery receipt when the atomic active-to-queue write fails', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-writer-save-workspace-'))
        const sessionId = '81445678-1234-4234-8234-123456789013'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const persisted: Array<Record<string, unknown>> = []
        const successfulSaves: Array<Array<Record<string, unknown>>> = []
        let saveAttempts = 0
        const store = {
            load: () => persisted as never,
            save: (items: readonly Record<string, unknown>[]) => {
                saveAttempts += 1
                if (saveAttempts === 2) throw new Error('disk temporarily unavailable')
                const copy = items.map((item) => ({ ...item }))
                persisted.splice(0, persisted.length, ...copy)
                successfulSaves.push(copy)
            }
        }
        const client = new FakeAppServerClient()
        client.resumeError = new Error('thread-store conflict: active writer')
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: lookup },
            () => client,
            store as never,
            acceptsReviewGuard
        )
        const reviewId = 'hapi-kanban-review:11111111111111111111111111111111'

        try {
            expect(sender.send(
                sessionId,
                'Read the staged review path only',
                'Review feedback: report.md',
                reviewId,
                false,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()
            expect(successfulSaves).toHaveLength(2)
            expect(successfulSaves.every((items) => items.length > 0)).toBe(true)
            expect(persisted).toEqual([expect.objectContaining({
                id: reviewId,
                recoveryRequired: true,
                recoveryReason: 'launch_failed',
                deliveryPolicy: 'untrusted-review'
            })])
            expect(sender.getStatus(sessionId)).toMatchObject({
                lastErrorCode: 'launch_failed',
                queuedMessages: [expect.objectContaining({ id: reviewId, recoveryRequired: true })]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps ambiguous review receipts after restart until a persisted terminal tombstone exists', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-revoke-workspace-'))
        const sessionId = '82345678-1234-4234-8234-123456789013'
        let summary: ReturnType<() => { id: string; title: string; cwd: string; file: string; modifiedAt: number; runState: 'idle' | 'processing' }> | null = {
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'processing'
        }
        const acceptedId = 'hapi-kanban-review:dddddddddddddddddddddddddddddddd'
        const recoveryId = 'hapi-kanban-review:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
        const completedId = 'hapi-kanban-review:ffffffffffffffffffffffffffffffff'
        const safeQueuedId = 'native:safe-queued'
        const persisted: Array<Record<string, unknown>> = [{
            sessionId,
            id: acceptedId,
            text: 'Review feedback: report.md',
            deliveryText: 'Read only staged review',
            queuedAt: 100,
            recoveryRequired: false,
            deliveryPolicy: 'untrusted-review',
            accepted: true,
            reviewGuard
        }, {
            sessionId,
            id: recoveryId,
            text: 'Review feedback: pending.md',
            deliveryText: 'Read only staged review',
            queuedAt: 101,
            recoveryRequired: true,
            recoveryReason: 'launch_failed',
            deliveryPolicy: 'untrusted-review',
            reviewGuard
        }, {
            sessionId,
            id: completedId,
            text: 'Review feedback: completed.md',
            deliveryText: 'Read only staged review',
            queuedAt: 102,
            recoveryRequired: false,
            deliveryPolicy: 'untrusted-review',
            accepted: true,
            completed: true,
            reviewGuard
        }, {
            sessionId,
            id: safeQueuedId,
            text: 'Safe queued message',
            deliveryText: 'Safe queued message',
            queuedAt: 103,
            recoveryRequired: false
        }]
        const store = {
            load: () => persisted as never,
            save: (items: readonly Record<string, unknown>[]) => {
                persisted.splice(0, persisted.length, ...items.map((item) => ({ ...item })))
            }
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: () => summary },
            null,
            store as never,
            acceptsReviewGuard
        )
        try {
            expect(sender.discard(sessionId, acceptedId)).toMatchObject({ success: true, discarded: false, active: true })
            expect(persisted.some((item) => item.id === acceptedId)).toBe(true)

            summary = { ...summary!, runState: 'idle' }
            expect(sender.discard(sessionId, acceptedId)).toMatchObject({ success: true, discarded: false, active: true })
            expect(persisted.some((item) => item.id === acceptedId)).toBe(true)

            summary = null
            expect(sender.discard(sessionId, recoveryId)).toMatchObject({ success: true, discarded: false, active: true })
            expect(sender.discard(sessionId, completedId)).toMatchObject({ success: true, discarded: true })
            expect(sender.discard(sessionId, safeQueuedId)).toMatchObject({ success: true, discarded: true })
            expect(persisted.map((item) => item.id)).toEqual([acceptedId, recoveryId])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not launch a queued review whose staged file changes before its idle hand-off', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-guard-workspace-'))
        const stageRoot = mkdtempSync(join(tmpdir(), 'hapi-native-review-stage-'))
        const sessionId = '83345678-1234-4234-8234-123456789013'
        const bytes = new TextEncoder().encode('# Untrusted feedback\n')
        const store = new NativeKanbanFeedbackStore(stageRoot)
        const staged = store.stage({
            artifactId: 'f'.repeat(32),
            codexSessionId: sessionId,
            filename: 'review.md',
            size: bytes.length,
            sha256: sha256(bytes),
            bytes
        })
        if (staged.success !== true) throw new Error(staged.error)
        let runState: 'idle' | 'processing' = 'processing'
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        })
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1,
            { getSummary: lookup },
            () => client,
            null,
            (id, guard) => store.verify(id, guard)
        )
        try {
            expect(sender.send(
                sessionId,
                'Read the staged review path only',
                'Review feedback: review.md',
                'hapi-kanban-review:ffffffffffffffffffffffffffffffff',
                false,
                'untrusted-review',
                { stagePath: staged.path, sha256: sha256(bytes) }
            )).toMatchObject({ success: true, status: 'queued' })
            writeFileSync(staged.path, '# altered after queueing\n')
            runState = 'idle'
            sender.notifyTranscriptChanged(sessionId)
            await vi.advanceTimersByTimeAsync(1)
            expect(client.connectCalls).toBe(0)
            expect(sender.getStatus(sessionId)).toMatchObject({
                queuedMessages: [expect.objectContaining({
                    id: 'hapi-kanban-review:ffffffffffffffffffffffffffffffff',
                    recoveryRequired: true
                })]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
            rmSync(stageRoot, { recursive: true, force: true })
        }
    })

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
            expect(sender.ownsActiveDelivery(sessionId)).toBe(false)

            await flushAsyncWork()
            expect(sender.ownsActiveDelivery(sessionId)).toBe(true)
            expect(client.connectCalls).toBe(1)
            expect(client.initializeCalls).toEqual([{
                clientInfo: {
                    name: 'hapi-native-session-bridge',
                    title: 'SHAPI Native Session Bridge',
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

    it('drops an external native writer conflict before turn/start without queueing the prompt', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-active-writer-workspace-'))
        const sessionId = '81845678-1234-4234-8234-123456789012'
        const lookup = vi.fn(() => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        }))
        const blockedClient = new FakeAppServerClient()
        blockedClient.resumeError = new Error('thread-store conflict: thread already has an active writer')
        const readyClient = new FakeAppServerClient()
        let nextClient = 0
        const createClient = vi.fn(() => [blockedClient, readyClient][nextClient++]!)
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const store = {
            load: vi.fn(() => []),
            save: vi.fn()
        }
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            createClient,
            store
        )

        try {
            expect(sender.send(sessionId, 'Ignore this locked prompt', undefined, 'native:active-writer')).toMatchObject({
                success: true,
                status: 'processing'
            })
            await flushMicrotasks()

            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                lastError: 'This native Codex session is currently controlled by another Codex client',
                lastErrorClientMessageId: 'native:active-writer',
                lastErrorCode: 'external_writer_active',
                queuedMessages: []
            })
            expect(store.save).toHaveBeenLastCalledWith([])

            // Once the Desktop owner releases the thread, a later message is
            // a fresh hand-off rather than a retry of the discarded prompt.
            expect(sender.send(sessionId, 'Send after the owner releases it', undefined, 'native:after-active-writer')).toMatchObject({
                success: true,
                status: 'processing'
            })
            await flushMicrotasks()

            expect(createClient).toHaveBeenCalledTimes(2)
            expect(readyClient.startTurnCalls).toEqual([{
                threadId: sessionId,
                input: [{ type: 'text', text: 'Send after the owner releases it' }]
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
            title: 'SHAPI-created thread',
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

    it('removes a recovery-required receipt from the persisted native outbox', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-discard-workspace-'))
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-native-direct-discard-store-'))
        const sessionId = '25445678-1234-4234-8234-123456789012'
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        try {
            store.save([{
                sessionId,
                id: 'native:discard-me',
                text: 'Do not retry this hand-off',
                deliveryText: 'Do not retry this hand-off',
                queuedAt: 600,
                recoveryRequired: true,
                recoveryReason: 'session_status_unknown'
            }, {
                sessionId,
                id: 'native:keep-me',
                text: 'Continue after the abandoned receipt',
                deliveryText: 'Continue after the abandoned receipt',
                queuedAt: 601,
                recoveryRequired: false
            }])
            // Construct after writing the file so the queue comes from the
            // runner-persisted outbox, not just this process's memory.
            const restored = new NativeCodexSessionDirectSender(
                vi.fn<SpawnNativeCodexProcess>(),
                () => 701,
                1_000,
                {
                    getSummary: () => ({
                        id: sessionId,
                        title: 'Native thread',
                        cwd,
                        file: '/not-read.jsonl',
                        modifiedAt: 100,
                        runState: 'processing'
                    })
                },
                null,
                store
            )
            try {
                expect(restored.discard(sessionId, 'native:discard-me')).toEqual({
                    success: true,
                    discarded: true,
                    queuedMessages: [{
                        id: 'native:keep-me',
                        text: 'Continue after the abandoned receipt',
                        queuedAt: 601
                    }]
                })
                expect(store.load()).toEqual([{
                    sessionId,
                    id: 'native:keep-me',
                    text: 'Continue after the abandoned receipt',
                    deliveryText: 'Continue after the abandoned receipt',
                    queuedAt: 601,
                    recoveryRequired: false
                }])
            } finally {
                restored.dispose()
            }
        } finally {
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
                status: 'unknown',
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

    it('does not unlock a raw native turn after a failed SHAPI-started child', () => {
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
