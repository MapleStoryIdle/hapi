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
    type NativeCodexSessionDirectSendStoredItem,
    type SpawnNativeCodexProcess
} from './nativeSessionDirectSend'
import { FileNativeCodexSessionControlStore, type NativeCodexSessionControlState, type NativeCodexSessionControlStore } from './nativeCodexControlStore'
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
    readonly handlers = new Map<string, (params: unknown, context?: { requestId: string | number | null }) => unknown>()
    registerRequestHandler(method: string, handler: (params: unknown, context?: { requestId: string | number | null }) => unknown): void {
        this.handlers.set(method, handler)
    }
    notificationHandler: ((method: string, params: unknown) => void) | null = null
    connectCalls = 0
    initializeCalls: InitializeParams[] = []
    resumeCalls: ThreadResumeParams[] = []
    startTurnCalls: TurnStartParams[] = []
    requestCalls: Array<{ method: string; params: unknown }> = []
    disconnectCalls = 0
    connectError: Error | null = null
    resumeError: Error | null = null
    startTurnError: Error | null = null
    requestError: Error | null = null
    queueAddResponse: unknown | null = null
    threadReadResponse: unknown = null
    interruptResponse: unknown = {}
    interruptError: Error | null = null
    interruptCalls: Array<{ threadId: string; turnId: string }> = []
    initializeHook: (() => void) | null = null

    async connect(): Promise<void> {
        this.connectCalls += 1
        if (this.connectError) throw this.connectError
    }

    async initialize(params: InitializeParams): Promise<unknown> {
        this.initializeCalls.push(params)
        this.initializeHook?.()
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

    async request(method: string, params?: unknown): Promise<unknown> {
        this.requestCalls.push({ method, params })
        if (this.requestError) throw this.requestError
        if (method === 'thread/queue/add') {
            const input = params as { clientUserMessageId?: unknown }
            return this.queueAddResponse ?? {
                queuedSubmission: {
                    id: 'native-queued-submission-1',
                    clientUserMessageId: input.clientUserMessageId
                }
            }
        }
        if (method === 'thread/read') {
            return this.threadReadResponse ?? { thread: { id: 'native-thread' }, turns: [] }
        }
        return {}
    }

    async interruptTurn(params: { threadId: string; turnId: string }): Promise<Record<string, unknown>> {
        this.interruptCalls.push(params)
        if (this.interruptError) throw this.interruptError
        return this.interruptResponse as Record<string, unknown>
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
    it('uses localImage for images and keeps other attachment paths inside the native prompt envelope', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-attachment-turn-'))
        const sessionId = '78345678-1234-4234-8234-123456789000'
        const client = new FakeAppServerClient()
        const attachmentIds = ['a'.repeat(32), 'b'.repeat(32)]
        const resolver = vi.fn(() => ({
            success: true as const,
            attachments: [
                {
                    id: attachmentIds[0]!,
                    filename: 'diagram.png',
                    mimeType: 'image/png',
                    size: 3,
                    kind: 'image' as const,
                    path: '/runner-private/diagram.png'
                },
                {
                    id: attachmentIds[1]!,
                    filename: 'notes.md',
                    mimeType: 'text/markdown',
                    size: 4,
                    kind: 'file' as const,
                    path: '/runner-private/notes.md'
                }
            ]
        }))
        const cleaner = vi.fn()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read.jsonl', modifiedAt: 100, runState: 'idle' }) },
            () => client,
            null,
            null,
            null,
            null,
            null,
            null,
            resolver,
            cleaner
        )

        try {
            expect(sender.send(
                sessionId,
                'Please inspect these files',
                undefined,
                'native-attachment-receipt',
                undefined,
                undefined,
                undefined,
                false,
                attachmentIds
            )).toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()

            expect(client.startTurnCalls).toHaveLength(1)
            const input = client.startTurnCalls[0]!.input
            expect(input).toContainEqual({ type: 'localImage', path: '/runner-private/diagram.png' })
            const text = input.find((part) => part.type === 'text')
            expect(text).toMatchObject({ type: 'text' })
            if (text?.type === 'text') {
                expect(text.text).toContain('/runner-private/notes.md')
                expect(text.text).not.toContain('/runner-private/diagram.png')
            }

            client.emit('turn/completed', {
                threadId: sessionId,
                turn: { id: 'native-turn-1', status: 'completed' }
            })
            expect(cleaner).toHaveBeenCalledWith(sessionId, attachmentIds)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('interrupts the exact private app-server turn and waits for its terminal notification', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-private-'))
        const sessionId = '78345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'processing' = 'idle'
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
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
            () => client
        )

        try {
            expect(sender.send(sessionId, 'private turn')).toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()
            expect(client.startTurnCalls).toHaveLength(1)

            await expect(sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'wrong-turn' },
                { controlledByCodexSsh: false, activeTurnId: 'wrong-turn' }
            )).resolves.toMatchObject({ success: false, code: 'turn_changed' })
            expect(client.interruptCalls).toEqual([])

            await expect(sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'native-turn-1' },
                { controlledByCodexSsh: false, activeTurnId: 'native-turn-1' }
            )).resolves.toMatchObject({
                success: true,
                controls: { stoppingTurnId: 'native-turn-1', queuePaused: true }
            })
            expect(client.interruptCalls).toEqual([{ threadId: sessionId, turnId: 'native-turn-1' }])

            // A stale idle snapshot or another turn's terminal must not
            // clear the exact stop marker before native Codex confirms this
            // turn's own terminal lifecycle.
            sender.notifyTranscriptLifecycle(sessionId, [{ type: 'task_complete', turnId: 'other-turn' }])
            expect(sender.getControls(sessionId).stoppingTurnId).toBe('native-turn-1')

            client.emit('turn/completed', {
                threadId: sessionId,
                turn: { id: 'native-turn-1', status: 'interrupted' }
            })
            runState = 'idle'
            expect(sender.getControls(sessionId, { controlledByCodexSsh: false, activeTurnId: null })).toMatchObject({
                queuePaused: true,
                canStop: false
            })
            expect(sender.getControls(sessionId).stoppingTurnId).toBeUndefined()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('requires a fresh exact shared thread/read before interrupting a Desktop turn', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-shared-'))
        const sessionId = '78345678-1234-4234-8234-123456789013'
        const client = new FakeAppServerClient()
        client.threadReadResponse = {
            thread: { id: 'another-thread' },
            turns: [{ id: 'desktop-turn', status: 'inProgress' }]
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Desktop thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'processing'
                })
            },
            null,
            null,
            null,
            async () => true,
            () => client
        )

        try {
            await expect(sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'desktop-turn' },
                { controlledByCodexSsh: true, activeTurnId: 'desktop-turn' }
            )).resolves.toMatchObject({ success: false, code: 'turn_changed' })
            expect(client.interruptCalls).toEqual([])

            client.threadReadResponse = {
                thread: { id: sessionId },
                turns: [{ id: 'desktop-turn', status: 'inProgress' }]
            }
            await expect(sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'desktop-turn' },
                { controlledByCodexSsh: true, activeTurnId: 'desktop-turn' }
            )).resolves.toMatchObject({ success: true, controls: { stoppingTurnId: 'desktop-turn' } })
            expect(client.interruptCalls).toEqual([{ threadId: sessionId, turnId: 'desktop-turn' }])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not manufacture a stopping marker when shared stop setup fails before interrupt bytes', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-shared-connect-fail-'))
        const sessionId = '78345678-1234-4234-8234-123456789016'
        const client = new FakeAppServerClient()
        client.connectError = new Error('socket unavailable')
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Desktop thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'processing'
                })
            },
            null,
            null,
            null,
            async () => true,
            () => client
        )

        try {
            await expect(sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'desktop-turn' },
                { controlledByCodexSsh: true, activeTurnId: 'desktop-turn' }
            )).resolves.toMatchObject({ success: false, code: 'control_failed' })
            expect(client.interruptCalls).toEqual([])
            expect(sender.getControls(sessionId, { controlledByCodexSsh: true, activeTurnId: 'desktop-turn' })).not.toHaveProperty('stoppingTurnId')
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a durable pause across restart and applies a captured configuration to the next private turn', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-persist-'))
        const sessionId = '78345678-1234-4234-8234-123456789014'
        const persisted: NativeCodexSessionControlState[] = [{
            sessionId,
            configuration: {},
            queuePaused: true
        }]
        const controlStore: NativeCodexSessionControlStore = {
            load: () => persisted.map((state) => ({ ...state, configuration: { ...state.configuration } })),
            save: (states) => {
                persisted.splice(0, persisted.length, ...states.map((state) => ({ ...state, configuration: { ...state.configuration } })))
            }
        }
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const client = new FakeAppServerClient()
        let runState: 'idle' | 'processing' = 'idle'
        const lookup = { getSummary: () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState
        }) }
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1,
            lookup,
            () => client,
            null,
            null,
            null,
            null,
            controlStore
        )

        try {
            await expect(sender.control(
                sessionId,
                { action: 'configure', configuration: { model: 'gpt-5.6', modelReasoningEffort: 'high', serviceTier: 'fast' } },
                { controlledByCodexSsh: false, activeTurnId: null }
            )).resolves.toMatchObject({ success: true })
            expect(sender.send(sessionId, 'configured message')).toMatchObject({ success: true, status: 'queued' })
            expect(spawn).not.toHaveBeenCalled()
            await expect(sender.control(
                sessionId,
                { action: 'resumeQueue' },
                { controlledByCodexSsh: false, activeTurnId: null }
            )).resolves.toMatchObject({ success: true, controls: { queuePaused: false } })
            await flushAsyncWork()
            await flushMicrotasks()
            expect(client.startTurnCalls[0]).toMatchObject({
                model: 'gpt-5.6',
                effort: 'high',
                serviceTierForTurn: 'priority'
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('carries captured model, effort, and tier into the exec fallback', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-exec-config-'))
        const sessionId = '78345678-1234-4234-8234-123456789017'
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 1, runState: 'idle' }) }
        )

        try {
            await expect(sender.control(
                sessionId,
                { action: 'configure', configuration: { model: 'gpt-5.6', modelReasoningEffort: 'high', serviceTier: 'fast' } },
                { controlledByCodexSsh: false, activeTurnId: null }
            )).resolves.toMatchObject({ success: true })
            expect(sender.send(sessionId, 'configured fallback')).toMatchObject({ success: true, status: 'processing' })
            expect(spawn).toHaveBeenCalledWith([
                'exec',
                'resume',
                '--model',
                'gpt-5.6',
                '-c',
                'model_reasoning_effort="high"',
                '-c',
                'service_tier="fast"',
                '--json',
                '--skip-git-repo-check',
                sessionId,
                'configured fallback'
            ], cwd)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('resumes an idle queued send after a concurrent configure releases its reservation', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-config-queue-'))
        const sessionId = '78345678-1234-4234-8234-123456789021'
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        let resolveValidation!: (result: { success: true }) => void
        const validation = new Promise<{ success: true }>((resolve) => {
            resolveValidation = resolve
        })
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            null,
            null,
            null,
            null,
            null,
            null,
            async () => validation
        )

        try {
            const configure = sender.control(
                sessionId,
                { action: 'configure', configuration: { model: 'gpt-5.6' } },
                { controlledByCodexSsh: false, activeTurnId: null }
            )
            await flushMicrotasks()
            expect(sender.send(sessionId, 'queued during configure')).toMatchObject({ success: true, status: 'queued' })
            expect(spawn).not.toHaveBeenCalled()

            resolveValidation({ success: true })
            await expect(configure).resolves.toMatchObject({ success: true })
            await flushAsyncWork()
            expect(spawn).toHaveBeenCalledTimes(1)
            // The send was accepted before configure committed, so its
            // immutable receipt correctly keeps the prior empty snapshot.
            expect(spawn).toHaveBeenCalledWith([
                'exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'queued during configure'
            ], cwd)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not let paused recovery bypass the native queue control gate', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-recovery-paused-'))
        const sessionId = '78345678-1234-4234-8234-123456789018'
        const clientMessageId = 'native:paused-recovery'
        const queued: NativeCodexSessionDirectSendStoredItem[] = [{
            sessionId,
            id: clientMessageId,
            text: 'needs confirmation',
            deliveryText: 'needs confirmation',
            queuedAt: 100,
            recoveryRequired: true,
            recoveryReason: 'session_status_unknown'
        }]
        const controlState: NativeCodexSessionControlState = {
            sessionId,
            configuration: {},
            queuePaused: true
        }
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            null,
            { load: () => [...queued], save: (items) => queued.splice(0, queued.length, ...items) },
            null,
            null,
            null,
            { load: () => [{ ...controlState }], save: () => {} }
        )

        try {
            expect(sender.send(sessionId, 'needs confirmation', undefined, clientMessageId, true)).toMatchObject({
                success: false,
                code: 'session_busy'
            })
            expect(spawn).not.toHaveBeenCalled()
            expect(queued[0]).toMatchObject({ id: clientMessageId, recoveryRequired: true })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('fails closed on corrupted native control state and never resumes a saved queue', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-control-corrupt-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-corrupt-workspace-'))
        const sessionId = '78345678-1234-4234-8234-123456789019'
        const controlPath = join(root, 'native-codex-controls.json')
        writeFileSync(controlPath, '{not-json')
        const queued: NativeCodexSessionDirectSendStoredItem[] = [{
            sessionId,
            id: 'native:restart-queued',
            text: 'saved queue item',
            deliveryText: 'saved queue item',
            queuedAt: 100,
            recoveryRequired: false
        }]
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            null,
            { load: () => [...queued], save: () => {} },
            null,
            null,
            null,
            new FileNativeCodexSessionControlStore(controlPath)
        )

        try {
            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                queuedMessages: [{ id: 'native:restart-queued' }]
            })
            expect(sender.getControls(sessionId)).toMatchObject({
                canStop: false,
                canConfigure: false,
                queuePaused: true,
                unavailableReason: 'unsupported'
            })
            expect(sender.send(sessionId, 'new message')).toMatchObject({ success: false, code: 'launch_failed' })
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(root, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not send an interrupt when persisting the stop reservation fails', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-fail-'))
        const sessionId = '78345678-1234-4234-8234-123456789015'
        const client = new FakeAppServerClient()
        const controlStore: NativeCodexSessionControlStore = {
            load: () => [],
            save: () => { throw new Error('disk full') }
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            () => client,
            null,
            null,
            null,
            null,
            controlStore
        )

        try {
            expect(sender.send(sessionId, 'hello')).toMatchObject({ success: true })
            await flushMicrotasks()
            await expect(sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'native-turn-1' },
                { controlledByCodexSsh: false, activeTurnId: 'native-turn-1' }
            )).resolves.toMatchObject({ success: false, code: 'control_failed' })
            expect(client.interruptCalls).toEqual([])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('rechecks the private active object if the ownership probe spans turn completion', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-control-private-race-'))
        const sessionId = '78345678-1234-4234-8234-123456789020'
        const client = new FakeAppServerClient()
        let runState: 'idle' | 'processing' = 'idle'
        let resolveOwnership!: (owned: boolean) => void
        const ownership = new Promise<boolean>((resolve) => {
            resolveOwnership = resolve
        })
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 1, runState }) },
            () => client,
            null,
            null,
            () => ownership
        )

        try {
            expect(sender.send(sessionId, 'race')).toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()
            const stopPromise = sender.control(
                sessionId,
                { action: 'stop', expectedTurnId: 'native-turn-1' },
                { controlledByCodexSsh: false, activeTurnId: 'native-turn-1' }
            )
            await flushMicrotasks()
            client.emit('turn/completed', { threadId: sessionId, turn: { id: 'native-turn-1', status: 'completed' } })
            runState = 'idle'
            resolveOwnership(false)
            await expect(stopPromise).resolves.toMatchObject({ success: false, code: 'turn_changed' })
            expect(client.interruptCalls).toEqual([])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('submits an idle SSH-controlled ordinary message with queue/add while archive stays locked', async () => {
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
        const sharedClient = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            { getSummary: lookup },
            null,
            null,
            null,
            externalControlChecker,
            () => sharedClient
        )
        const archiveAttempt = vi.fn(async () => ({ success: true as const }))

        try {
            await expect(sender.sendWithExternalControlCheck(sessionId, 'Use the existing SSH server', undefined, 'ssh:idle-1')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            await flushAsyncWork()
            expect(sharedClient.requestCalls).toEqual([
                {
                    method: 'thread/queue/add',
                    params: {
                        threadId: sessionId,
                        clientUserMessageId: 'ssh:idle-1',
                        input: [{ type: 'text', text: 'Use the existing SSH server' }]
                    }
                }
            ])
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])
            expect(sharedClient.disconnectCalls).toBe(1)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [expect.objectContaining({ id: 'ssh:idle-1', cancelBlocked: true })]
            })
            await expect(sender.archive(sessionId, archiveAttempt)).resolves.toMatchObject({
                success: false,
                code: 'session_busy'
            })
            expect(spawn).not.toHaveBeenCalled()
            expect(archiveAttempt).not.toHaveBeenCalled()
            expect(externalControlChecker).toHaveBeenCalledTimes(1)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an SSH-shared message local while active, then queue-adds only after a fresh idle observation', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-shared-queue-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789096'
        const sharedClient = new FakeAppServerClient()
        let runState: 'idle' | 'processing' = 'processing'
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1,
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
            async () => true,
            () => sharedClient
        )

        try {
            await expect(sender.sendWithExternalControlCheck(sessionId, 'Wait for SSH', undefined, 'ssh:active-1')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            await flushAsyncWork()

            expect(sharedClient.requestCalls).toEqual([])
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])
            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                queuedMessages: [expect.objectContaining({ id: 'ssh:active-1', text: 'Wait for SSH' })]
            })

            runState = 'idle'
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushAsyncWork()
            await flushAsyncWork()

            expect(sharedClient.requestCalls).toEqual([expect.objectContaining({ method: 'thread/queue/add' })])
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not turn-start when the transcript changes during SSH queue setup', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-idle-race-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789091'
        let runState: 'idle' | 'processing' = 'idle'
        const sharedClient = new FakeAppServerClient()
        sharedClient.initializeHook = () => {
            runState = 'processing'
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
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
            () => new FakeAppServerClient(),
            null,
            null,
            async () => true,
            () => sharedClient
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Do not steer a raced turn', undefined, 'ssh:race-1')
            await flushAsyncWork()
            expect(sharedClient.requestCalls).toEqual([])
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])

            sharedClient.initializeHook = null
            runState = 'idle'
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushAsyncWork()
            await flushAsyncWork()

            expect(sharedClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'ssh:race-1' })
            })])
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an SSH-shared untrusted review queued until the Desktop owner releases it', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-review-queue-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789095'
        let held = true
        const sharedClient = new FakeAppServerClient()
        const privateClient = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            () => privateClient,
            null,
            acceptsReviewGuard,
            async () => held,
            () => sharedClient
        )

        try {
            await expect(sender.sendWithExternalControlCheck(
                sessionId,
                'Review only after SSH releases',
                undefined,
                'ssh:review-1',
                false,
                'untrusted-review',
                reviewGuard
            )).resolves.toMatchObject({ success: true, status: 'queued' })
            expect(sharedClient.connectCalls).toBe(0)
            expect(privateClient.connectCalls).toBe(0)

            held = false
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushAsyncWork()
            await flushAsyncWork()

            expect(sharedClient.connectCalls).toBe(0)
            expect(privateClient.startTurnCalls).toEqual([{
                threadId: sessionId,
                input: [{ type: 'text', text: 'Review only after SSH releases' }]
            }])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('preserves a queue-add acknowledgement and its FIFO barrier across restart without replay', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-ack-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789094'
        const sharedClient = new FakeAppServerClient()
        const stored: import('./nativeSessionDirectSend').NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => [...stored],
            save: (items: readonly import('./nativeSessionDirectSend').NativeCodexSessionDirectSendStoredItem[]) => {
                stored.splice(0, stored.length, ...items)
            }
        }
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: lookup },
            null,
            store,
            null,
            async () => true,
            () => sharedClient
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Persist once', undefined, 'ssh:ack-1')
            await flushAsyncWork()
            expect(stored).toEqual([expect.objectContaining({
                id: 'ssh:ack-1',
                accepted: true
            })])
            expect(stored[0]?.completed).toBeUndefined()
            expect(stored[0]?.terminalAt).toBeUndefined()
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])

            const replacementClient = new FakeAppServerClient()
            const replacement = new NativeCodexSessionDirectSender(
                vi.fn<SpawnNativeCodexProcess>(),
                () => 124,
                1_000,
                { getSummary: lookup },
                () => new FakeAppServerClient(),
                store,
                null,
                async () => true,
                () => replacementClient
            )
            try {
                await expect(replacement.sendWithExternalControlCheck(sessionId, 'Persist once', undefined, 'ssh:ack-1')).resolves.toMatchObject({
                    success: true,
                    status: 'processing',
                    queuedMessages: [expect.objectContaining({ id: 'ssh:ack-1', cancelBlocked: true })]
                })
                expect(replacement.getStatus(sessionId)).toMatchObject({
                    queuedMessages: [expect.objectContaining({ id: 'ssh:ack-1', cancelBlocked: true })],
                    deliveryReceipts: [{ id: 'ssh:ack-1', state: 'accepted' }]
                })
                expect(replacementClient.requestCalls).toEqual([])
                expect(replacementClient.resumeCalls).toEqual([])
                expect(replacementClient.startTurnCalls).toEqual([])
            } finally {
                replacement.dispose()
            }
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('restores every later FIFO receipt when an incomplete shared ACK fills the normal queue cap', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-restore-cap-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789082'
        const acceptedId = 'ssh:restore-accepted'
        const lastQueuedId = 'ssh:restore-50'
        const stored: NativeCodexSessionDirectSendStoredItem[] = [
            {
                sessionId,
                id: acceptedId,
                text: 'Ambiguous shared acknowledgement',
                deliveryText: 'Ambiguous shared acknowledgement',
                queuedAt: 1,
                recoveryRequired: false,
                accepted: true
            },
            ...Array.from({ length: 50 }, (_, index): NativeCodexSessionDirectSendStoredItem => ({
                sessionId,
                id: `ssh:restore-${index + 1}`,
                text: `Later FIFO item ${index + 1}`,
                deliveryText: `Later FIFO item ${index + 1}`,
                queuedAt: index + 2,
                recoveryRequired: false
            }))
        ]
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            null,
            {
                load: () => [...stored],
                save: () => {}
            }
        )

        try {
            const status = sender.getStatus(sessionId)
            if (!status.success) throw new Error('Expected native queue status')
            expect(status.queuedMessages).toHaveLength(51)
            expect(status.activeClientMessageId).toBeUndefined()
            expect(status.queuedMessages?.[0]).toMatchObject({ id: acceptedId, cancelBlocked: true })
            expect(status.deliveryReceipts).toEqual([{ id: acceptedId, state: 'accepted' }])
            expect(status.queuedMessages?.[50]).toMatchObject({ id: lastQueuedId })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an in-flight SSH queue-add receipt when discard races its acknowledgement', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-discard-race-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789089'
        const clientMessageId = 'ssh:discard-race-1'
        const sharedClient = new FakeAppServerClient()
        const privateClient = new FakeAppServerClient()
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const stored: NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => [...stored],
            save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                stored.splice(0, stored.length, ...items)
            }
        }
        let acknowledgeQueueAdd!: (value: unknown) => void
        const queueAddAcknowledgement = new Promise<unknown>((resolve) => {
            acknowledgeQueueAdd = resolve
        })
        sharedClient.request = async (method, params) => {
            sharedClient.requestCalls.push({ method, params })
            return method === 'thread/queue/add' ? queueAddAcknowledgement : {}
        }
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            60_000,
            { getSummary: lookup },
            () => privateClient,
            store,
            null,
            async () => true,
            () => sharedClient
        )

        try {
            await expect(sender.sendWithExternalControlCheck(
                sessionId,
                'Keep this receipt until Codex answers',
                undefined,
                clientMessageId
            )).resolves.toMatchObject({ success: true, status: 'queued' })
            await flushMicrotasks()

            expect(sharedClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: clientMessageId })
            })])
            expect(stored).toEqual([{
                sessionId,
                id: clientMessageId,
                text: 'Keep this receipt until Codex answers',
                deliveryText: 'Keep this receipt until Codex answers',
                queuedAt: 123,
                recoveryRequired: true,
                recoveryReason: 'runner_restarted'
            }])
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                startedAt: 123,
                queuedMessages: [expect.objectContaining({ id: clientMessageId })]
            })
            expect(sender.discard(sessionId, clientMessageId)).toEqual({
                success: true,
                discarded: false,
                active: true,
                queuedMessages: [{
                    id: clientMessageId,
                    text: 'Keep this receipt until Codex answers',
                    cancelBlocked: true,
                    queuedAt: 123,
                    recoveryRequired: true,
                    recoveryReason: 'runner_restarted'
                }]
            })
            expect(stored).toHaveLength(1)

            acknowledgeQueueAdd({
                queuedSubmission: {
                    id: 'native-queued-submission-1',
                    clientUserMessageId: clientMessageId
                }
            })
            await flushMicrotasks()

            expect(stored).toEqual([expect.objectContaining({
                id: clientMessageId,
                accepted: true
            })])
            expect(stored[0]?.completed).toBeUndefined()
            expect(stored[0]?.terminalAt).toBeUndefined()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                startedAt: 123,
                queuedMessages: [expect.objectContaining({ id: clientMessageId, cancelBlocked: true })]
            })
            expect(sharedClient.requestCalls).toHaveLength(1)
            expect(privateClient.connectCalls).toBe(0)
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('releases a shared queue/add acknowledgement only after exact transcript delivery evidence', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-ack-barrier-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789088'
        let runState: 'idle' | 'processing' = 'idle'
        let modifiedAt = 100
        const firstClient = new FakeAppServerClient()
        const secondClient = new FakeAppServerClient()
        const sharedClients = [firstClient, secondClient]
        const stored: NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => [...stored],
            save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                stored.splice(0, stored.length, ...items)
            }
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            Date.now,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt,
                    runState
                })
            },
            null,
            store,
            null,
            async () => true,
            () => {
                const client = sharedClients.shift()
                if (!client) throw new Error('Unexpected shared queue client')
                return client
            }
        )

        try {
            await expect(sender.sendWithExternalControlCheck(sessionId, 'First shared item', undefined, 'ssh:barrier-a')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            await flushMicrotasks()
            expect(firstClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'ssh:barrier-a' })
            })])

            await expect(sender.sendWithExternalControlCheck(sessionId, 'Second shared item', undefined, 'ssh:barrier-b')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            await flushMicrotasks()
            expect(firstClient.requestCalls).toHaveLength(1)
            expect(secondClient.requestCalls).toEqual([])

            // Generic lifecycle state must not release A: it could describe
            // another Desktop turn in this shared thread.
            runState = 'idle'
            modifiedAt = 101
            sender.notifyTranscriptChanged(sessionId, [{
                text: 'A different native prompt',
                createdAt: Date.now()
            }])
            expect(stored.find((item) => item.id === 'ssh:barrier-a')).toMatchObject({ accepted: true })
            expect(stored.find((item) => item.id === 'ssh:barrier-a')?.completed).toBeUndefined()
            expect(secondClient.requestCalls).toEqual([])

            // A matching prompt record is receipt-specific. It clears the
            // false recovery barrier, but B still waits for the actual native
            // turn to leave processing.
            runState = 'processing'
            modifiedAt = Date.now()
            sender.notifyTranscriptChanged(sessionId, [{
                text: 'First shared item',
                createdAt: Date.now()
            }])
            await flushMicrotasks()

            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [expect.objectContaining({ id: 'ssh:barrier-b' })]
            })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('lastErrorCode')
            expect(stored.find((item) => item.id === 'ssh:barrier-a')).toMatchObject({
                accepted: true,
                transcriptConfirmed: true
            })
            expect(secondClient.requestCalls).toEqual([])

            await vi.advanceTimersByTimeAsync(20_000)
            const status = sender.getStatus(sessionId)
            expect(status.success).toBe(true)
            if (!status.success) throw new Error('Expected native queue status')
            expect(status.status).toBe('processing')
            expect(status).not.toHaveProperty('lastErrorCode')
            expect(status.queuedMessages).toEqual([expect.objectContaining({ id: 'ssh:barrier-b' })])
            expect(secondClient.requestCalls).toEqual([])

            runState = 'idle'
            modifiedAt = Date.now()
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushMicrotasks()
            expect(secondClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'ssh:barrier-b' })
            })])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it.each([
        'session_status_unknown',
        'runner_restarted'
    ] as const)('resolves a persisted ambiguous recovery receipt when the native transcript proves delivery (%s)', (recoveryReason) => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-recovery-evidence-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789086'
        const stored: NativeCodexSessionDirectSendStoredItem[] = [{
            sessionId,
            id: 'ssh:recovered-a',
            text: 'Already delivered prompt',
            deliveryText: 'Already delivered prompt',
            queuedAt: 1_000,
            recoveryRequired: true,
            recoveryReason
        }]
        const store = {
            load: () => [...stored],
            save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                stored.splice(0, stored.length, ...items)
            }
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 2_000,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 1_001,
                    runState: 'processing' as const
                })
            },
            null,
            store
        )

        try {
            expect(sender.needsTranscriptDeliveryEvidence(sessionId)).toBe(true)
            sender.notifyTranscriptChanged(sessionId, [{
                text: 'Already delivered prompt',
                createdAt: 1_001
            }])

            expect(stored).toEqual([expect.objectContaining({
                id: 'ssh:recovered-a',
                accepted: true,
                transcriptConfirmed: true,
                recoveryRequired: false
            })])
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: []
            })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('lastErrorCode')
            expect(sender.needsTranscriptDeliveryEvidence(sessionId)).toBe(false)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not reconcile a confirmed launch failure from matching transcript text', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-launch-failure-evidence-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789085'
        const stored: NativeCodexSessionDirectSendStoredItem[] = [{
            sessionId,
            id: 'native:launch-failed-a',
            text: 'Prompt that never launched',
            deliveryText: 'Prompt that never launched',
            queuedAt: 1_000,
            recoveryRequired: true,
            recoveryReason: 'launch_failed'
        }]
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 2_000,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 1_001,
                    runState: 'idle' as const
                })
            },
            null,
            {
                load: () => [...stored],
                save: (items) => {
                    stored.splice(0, stored.length, ...items)
                }
            }
        )

        try {
            expect(sender.needsTranscriptDeliveryEvidence(sessionId)).toBe(false)
            sender.notifyTranscriptChanged(sessionId, [{
                text: 'Prompt that never launched',
                createdAt: 1_001
            }])

            expect(stored).toEqual([expect.objectContaining({
                id: 'native:launch-failed-a',
                recoveryRequired: true,
                recoveryReason: 'launch_failed'
            })])
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                queuedMessages: [expect.objectContaining({
                    id: 'native:launch-failed-a',
                    recoveryRequired: true,
                    recoveryReason: 'launch_failed'
                })]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not start a private bridge when SSH setup is in flight and ownership flips false', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-setup-lease-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789087'
        let held = true
        let releaseConnect = () => {}
        const connectGate = new Promise<void>((resolve) => {
            releaseConnect = resolve
        })
        const sharedClient = new FakeAppServerClient()
        sharedClient.connect = async () => {
            sharedClient.connectCalls += 1
            await connectGate
        }
        const privateClient = new FakeAppServerClient()
        const spawn = vi.fn<SpawnNativeCodexProcess>()
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
                    runState: 'idle' as const
                })
            },
            () => privateClient,
            null,
            null,
            async () => held,
            () => sharedClient
        )

        try {
            await expect(sender.sendWithExternalControlCheck(sessionId, 'Shared setup item', undefined, 'ssh:setup-a')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            await flushMicrotasks()
            expect(sharedClient.connectCalls).toBe(1)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                startedAt: 123,
                queuedMessages: [expect.objectContaining({ id: 'ssh:setup-a' })]
            })

            held = false
            await expect(sender.sendWithExternalControlCheck(sessionId, 'Must wait behind setup', undefined, 'ssh:setup-b')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushMicrotasks()

            expect(privateClient.connectCalls).toBe(0)
            expect(privateClient.startTurnCalls).toEqual([])
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            releaseConnect()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('releases a hung shared setup lease and retries only the FIFO head', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-setup-timeout-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789082'
        let releaseInitialize = () => {}
        const initializeGate = new Promise<void>((resolve) => {
            releaseInitialize = resolve
        })
        const firstClient = new FakeAppServerClient()
        firstClient.initialize = async (params) => {
            firstClient.initializeCalls.push(params)
            await initializeGate
            return {}
        }
        const secondClient = new FakeAppServerClient()
        const clients = [firstClient, secondClient]
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            Date.now,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            null,
            null,
            null,
            async () => true,
            () => {
                const client = clients.shift()
                if (!client) throw new Error('Unexpected shared queue client')
                return client
            }
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Retry the first FIFO item', undefined, 'ssh:setup-timeout-a')
            await flushMicrotasks()
            await sender.sendWithExternalControlCheck(sessionId, 'Do not skip the first FIFO item', undefined, 'ssh:setup-timeout-b')
            await flushMicrotasks()

            expect(firstClient.connectCalls).toBe(1)
            expect(firstClient.initializeCalls).toHaveLength(1)
            expect(firstClient.requestCalls).toEqual([])
            expect(sender.getStatus(sessionId)).toMatchObject({ success: true, status: 'processing' })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('activeClientMessageId')

            await vi.advanceTimersByTimeAsync(15_000)

            expect(firstClient.disconnectCalls).toBe(1)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                queuedMessages: [
                    expect.objectContaining({ id: 'ssh:setup-timeout-a' }),
                    expect.objectContaining({ id: 'ssh:setup-timeout-b' })
                ]
            })
            expect(secondClient.requestCalls).toEqual([])

            // A late setup continuation is inert: it cannot submit the
            // expired socket after the retry lease is gone.
            releaseInitialize()
            await flushMicrotasks()
            expect(firstClient.requestCalls).toEqual([])

            await vi.advanceTimersByTimeAsync(5_000)
            await flushMicrotasks()

            expect(secondClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'ssh:setup-timeout-a' })
            })])
        } finally {
            sender.dispose()
            releaseInitialize()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('turns a hung shared queue-add into head recovery without sending its FIFO successor', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-submit-timeout-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789081'
        let resolveQueueAdd: (value: unknown) => void = () => {}
        const queueAddGate = new Promise<unknown>((resolve) => {
            resolveQueueAdd = resolve
        })
        const sharedClient = new FakeAppServerClient()
        sharedClient.request = async (method, params) => {
            sharedClient.requestCalls.push({ method, params })
            return method === 'thread/queue/add' ? queueAddGate : {}
        }
        const stored: NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => [...stored],
            save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                stored.splice(0, stored.length, ...items)
            }
        }
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            Date.now,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            null,
            store,
            null,
            async () => true,
            () => sharedClient
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Ambiguous first FIFO item', undefined, 'ssh:submit-timeout-a')
            await flushMicrotasks()
            await sender.sendWithExternalControlCheck(sessionId, 'Later FIFO item', undefined, 'ssh:submit-timeout-b')
            await flushMicrotasks()

            expect(sharedClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'ssh:submit-timeout-a' })
            })])
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                activeClientMessageId: 'ssh:submit-timeout-a'
            })

            await vi.advanceTimersByTimeAsync(20_000)

            expect(sharedClient.disconnectCalls).toBe(1)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'idle',
                lastErrorCode: 'session_status_unknown',
                queuedMessages: [
                    expect.objectContaining({
                        id: 'ssh:submit-timeout-a',
                        recoveryRequired: true,
                        recoveryReason: 'session_status_unknown'
                    }),
                    expect.objectContaining({ id: 'ssh:submit-timeout-b' })
                ]
            })
            expect(stored.map((item) => ({ id: item.id, recoveryRequired: item.recoveryRequired, recoveryReason: item.recoveryReason }))).toEqual([
                {
                    id: 'ssh:submit-timeout-a',
                    recoveryRequired: true,
                    recoveryReason: 'session_status_unknown'
                },
                {
                    id: 'ssh:submit-timeout-b',
                    recoveryRequired: false,
                    recoveryReason: undefined
                }
            ])
            await expect(sender.sendWithExternalControlCheck(
                sessionId,
                'Later FIFO item',
                undefined,
                'ssh:submit-timeout-b',
                true
            )).resolves.toMatchObject({ success: false, code: 'session_busy' })

            // A late, exact ACK resolves A without replaying it. B must still
            // wait for A's transcript evidence, not a generic idle snapshot.
            resolveQueueAdd({
                queuedSubmission: {
                    id: 'native-queued-submission-1',
                    clientUserMessageId: 'ssh:submit-timeout-a'
                }
            })
            await flushMicrotasks()
            expect(sharedClient.requestCalls).toHaveLength(1)
            const finalStatus = sender.getStatus(sessionId)
            if (!finalStatus.success) throw new Error('Expected native queue status')
            expect(finalStatus.queuedMessages).toEqual([
                expect.objectContaining({ id: 'ssh:submit-timeout-a', cancelBlocked: true }),
                expect.objectContaining({ id: 'ssh:submit-timeout-b' })
            ])
            expect(finalStatus.deliveryReceipts).toEqual([{ id: 'ssh:submit-timeout-a', state: 'accepted' }])
            expect(finalStatus.lastErrorCode).toBeUndefined()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a pre-write shared setup receipt discardable without stranding the next FIFO item', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-setup-discard-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789084'
        let releaseConnect = () => {}
        const connectGate = new Promise<void>((resolve) => {
            releaseConnect = resolve
        })
        const firstClient = new FakeAppServerClient()
        firstClient.connect = async () => {
            firstClient.connectCalls += 1
            await connectGate
        }
        const secondClient = new FakeAppServerClient()
        const clients = [firstClient, secondClient]
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            null,
            null,
            null,
            async () => true,
            () => {
                const client = clients.shift()
                if (!client) throw new Error('Unexpected shared queue client')
                return client
            }
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Discard before queue/add', undefined, 'ssh:setup-discard-a')
            await flushMicrotasks()
            await sender.sendWithExternalControlCheck(sessionId, 'Keep next FIFO item', undefined, 'ssh:setup-discard-b')
            expect(sender.discard(sessionId, 'ssh:setup-discard-a')).toMatchObject({
                success: true,
                discarded: true,
                queuedMessages: [expect.objectContaining({ id: 'ssh:setup-discard-b' })]
            })

            releaseConnect()
            await flushAsyncWork()
            await flushAsyncWork()

            expect(secondClient.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'ssh:setup-discard-b' })
            })])
        } finally {
            sender.dispose()
            releaseConnect()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not start a private bridge while a shared ACK still awaits terminal transcript evidence', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-ack-lease-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789085'
        let held = true
        const sharedClient = new FakeAppServerClient()
        const privateClient = new FakeAppServerClient()
        const spawn = vi.fn<SpawnNativeCodexProcess>()
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
                    runState: 'idle' as const
                })
            },
            () => privateClient,
            null,
            null,
            async () => held,
            () => sharedClient
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'ACK barrier item', undefined, 'ssh:ack-lease-a')
            await flushMicrotasks()
            expect(sharedClient.requestCalls).toHaveLength(1)

            held = false
            await expect(sender.sendWithExternalControlCheck(sessionId, 'Must stay behind ACK barrier', undefined, 'ssh:ack-lease-b')).resolves.toMatchObject({
                success: true,
                status: 'queued'
            })
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushMicrotasks()

            expect(sharedClient.requestCalls).toHaveLength(1)
            expect(privateClient.connectCalls).toBe(0)
            expect(privateClient.startTurnCalls).toEqual([])
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an acknowledged shared send pending beyond twenty seconds without replay or draining later work', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-ack-timeout-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789086'
        const firstClient = new FakeAppServerClient()
        const secondClient = new FakeAppServerClient()
        const sharedClients = [firstClient, secondClient]
        let runState: 'idle' | 'processing' = 'idle'
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            Date.now,
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
            async () => true,
            () => {
                const client = sharedClients.shift()
                if (!client) throw new Error('Unexpected shared queue client')
                return client
            }
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Ambiguous shared item', undefined, 'ssh:timeout-a')
            await flushMicrotasks()
            await sender.sendWithExternalControlCheck(sessionId, 'Later local FIFO item', undefined, 'ssh:timeout-b')
            await flushMicrotasks()
            expect(firstClient.requestCalls).toHaveLength(1)
            expect(secondClient.requestCalls).toEqual([])

            runState = 'processing'
            await vi.advanceTimersByTimeAsync(120_000)

            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                deliveryReceipts: [{ id: 'ssh:timeout-a', state: 'accepted' }],
                queuedMessages: [
                    expect.objectContaining({ id: 'ssh:timeout-a', cancelBlocked: true }),
                    expect.objectContaining({ id: 'ssh:timeout-b' })
                ]
            })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('lastErrorCode')
            expect(firstClient.requestCalls).toHaveLength(1)
            expect(secondClient.requestCalls).toEqual([])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('consumes each native user record once when two queued prompts have identical text', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-shared-identical-'))
        const sessionId = '89345678-1234-4234-8234-123456789087'
        const clients = [new FakeAppServerClient(), new FakeAppServerClient()]
        let clientIndex = 0
        let now = 100
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(), () => now, 1_000,
            { getSummary: () => ({ id: sessionId, title: 'Same prompts', cwd, file: '/not-read.jsonl', modifiedAt: now, runState: 'idle' }) },
            null, null, null, async () => true, () => clients[clientIndex++]!
        )
        try {
            await sender.sendWithExternalControlCheck(sessionId, '1-1', undefined, 'same:first')
            await flushMicrotasks()
            now = 150
            await sender.sendWithExternalControlCheck(sessionId, '1-1', undefined, 'same:second')
            await flushMicrotasks()
            now = 200
            sender.notifyTranscriptChanged(sessionId, [{ text: '1-1', createdAt: 200 }])
            await vi.advanceTimersByTimeAsync(1)
            await flushMicrotasks()
            sender.notifyTranscriptChanged(sessionId, [{ text: '1-1', createdAt: 200 }])
            expect(sender.getStatus(sessionId)).toMatchObject({
                queuedMessages: [expect.objectContaining({ id: 'same:second', cancelBlocked: true })],
                deliveryReceipts: [{ id: 'same:first', state: 'delivered' }, { id: 'same:second', state: 'accepted' }]
            })
            now = 300
            sender.notifyTranscriptChanged(sessionId, [{ text: '1-1', createdAt: 300 }])
            expect(sender.getStatus(sessionId)).toMatchObject({
                deliveryReceipts: [{ id: 'same:first', state: 'delivered' }, { id: 'same:second', state: 'delivered' }]
            })
            for (const client of clients) expect(client.requestCalls).toHaveLength(1)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a lost SSH queue-add response as an explicit recovery receipt without private fallback', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-ambiguous-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789093'
        const sharedClient = new FakeAppServerClient()
        sharedClient.requestError = new Error('shared queue response lost')
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const privateClient = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 123,
            1_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            () => privateClient,
            null,
            null,
            async () => true,
            () => sharedClient
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Never replay automatically', undefined, 'ssh:ambiguous-1')
            await flushAsyncWork()

            expect(spawn).not.toHaveBeenCalled()
            expect(sharedClient.resumeCalls).toEqual([])
            expect(sharedClient.startTurnCalls).toEqual([])
            expect(privateClient.connectCalls).toBe(0)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                lastError: 'shared queue response lost',
                lastErrorClientMessageId: 'ssh:ambiguous-1',
                queuedMessages: [expect.objectContaining({
                    id: 'ssh:ambiguous-1',
                    recoveryRequired: true,
                    recoveryReason: 'session_status_unknown'
                })]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('treats an untyped invalid SSH queue-add failure as ambiguous instead of retrying it', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-ssh-invalid-response-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789090'
        const sharedClient = new FakeAppServerClient()
        sharedClient.requestError = new Error('Invalid JSON-RPC message from Codex SSH app-server')
        const privateClient = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            () => privateClient,
            null,
            null,
            async () => true,
            () => sharedClient
        )

        try {
            await sender.sendWithExternalControlCheck(sessionId, 'Never replay an ambiguous rejection', undefined, 'ssh:invalid-1')
            await flushAsyncWork()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                lastErrorCode: 'session_status_unknown',
                queuedMessages: [expect.objectContaining({
                    id: 'ssh:invalid-1',
                    recoveryRequired: true,
                    recoveryReason: 'session_status_unknown'
                })]
            })
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            await flushAsyncWork()
            await flushAsyncWork()
            expect(sharedClient.requestCalls).toHaveLength(1)
            expect(privateClient.connectCalls).toBe(0)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps a completed ordinary client message id across a runner restart', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-client-id-tombstone-workspace-'))
        const sessionId = '89345678-1234-4234-8234-123456789092'
        const stored: import('./nativeSessionDirectSend').NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => [...stored],
            save: (items: readonly import('./nativeSessionDirectSend').NativeCodexSessionDirectSendStoredItem[]) => {
                stored.splice(0, stored.length, ...items)
            }
        }
        const lookup = () => ({
            id: sessionId,
            title: 'Native thread',
            cwd,
            file: '/not-read.jsonl',
            modifiedAt: 100,
            runState: 'idle' as const
        })
        const firstClient = new FakeAppServerClient()
        const first = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            1_000,
            { getSummary: lookup },
            () => firstClient,
            store
        )

        try {
            expect(first.send(sessionId, 'Only once', undefined, 'browser:once-1')).toMatchObject({ success: true, status: 'processing' })
            await flushAsyncWork()
            firstClient.emit('turn/completed', {
                thread: { id: sessionId },
                turn: { id: 'native-turn-1' },
                status: 'completed'
            })
            expect(stored).toEqual([expect.objectContaining({
                id: 'browser:once-1',
                accepted: true,
                completed: true,
                terminalAt: 123
            })])

            const secondClient = new FakeAppServerClient()
            const second = new NativeCodexSessionDirectSender(
                vi.fn<SpawnNativeCodexProcess>(),
                () => 124,
                1_000,
                { getSummary: lookup },
                () => secondClient,
                store
            )
            try {
                expect(second.send(sessionId, 'Only once', undefined, 'browser:once-1')).toMatchObject({
                    success: true,
                    status: 'processing'
                })
                expect(secondClient.connectCalls).toBe(0)
            } finally {
                second.dispose()
            }
        } finally {
            first.dispose()
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
        const unsentReviewId = 'native:unsent-review'
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
        }, {
            sessionId,
            id: unsentReviewId,
            text: 'Feedback rejected before delivery',
            deliveryText: 'Feedback rejected before delivery',
            queuedAt: 104,
            recoveryRequired: true,
            recoveryReason: 'review_guard_failed',
            deliveryPolicy: 'untrusted-review',
            reviewGuard
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
            expect(sender.discard(sessionId, unsentReviewId)).toMatchObject({ success: true, discarded: true })
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

    it('keeps a new guard-rejected review behind earlier FIFO work', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-guard-order-workspace-'))
        const sessionId = '83345678-1234-4234-8234-123456789011'
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'processing' as const
                })
            },
            null,
            null,
            () => ({ success: false as const, error: 'The staged review changed' })
        )

        try {
            expect(sender.send(sessionId, 'Earlier FIFO work', undefined, 'native:guard-order-a')).toMatchObject({
                success: true,
                status: 'queued'
            })
            expect(sender.send(
                sessionId,
                'Review only the staged file',
                'Review feedback: changed.md',
                'hapi-kanban-review:guard-order-b',
                false,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({
                success: false,
                code: 'launch_failed'
            })

            expect(sender.getStatus(sessionId)).toMatchObject({
                queuedMessages: [
                    expect.objectContaining({ id: 'native:guard-order-a' }),
                    expect.objectContaining({
                        id: 'hapi-kanban-review:guard-order-b',
                        recoveryRequired: true,
                        recoveryReason: 'review_guard_failed'
                    })
                ]
            })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not duplicate a recovery review when its guard check fails again', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-review-guard-recovery-workspace-'))
        const sessionId = '83345678-1234-4234-8234-123456789010'
        const reviewId = 'hapi-kanban-review:guard-recovery-b'
        const stored: NativeCodexSessionDirectSendStoredItem[] = [{
            sessionId,
            id: reviewId,
            text: 'Review feedback: changed.md',
            deliveryText: 'Review only the staged file',
            queuedAt: 100,
            recoveryRequired: true,
            recoveryReason: 'launch_failed',
            deliveryPolicy: 'untrusted-review',
            reviewGuard
        }]
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 123,
            60_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            null,
            {
                load: () => [...stored],
                save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                    stored.splice(0, stored.length, ...items)
                }
            },
            () => ({ success: false as const, error: 'The staged review changed again' })
        )

        try {
            expect(sender.send(
                sessionId,
                'Review only the staged file',
                'Review feedback: changed.md',
                reviewId,
                true,
                'untrusted-review',
                reviewGuard
            )).toMatchObject({
                success: false,
                code: 'launch_failed'
            })
            const status = sender.getStatus(sessionId)
            expect(status.success).toBe(true)
            if (!status.success) throw new Error('Expected native queue status')
            expect(status.queuedMessages).toEqual([expect.objectContaining({
                id: reviewId,
                recoveryRequired: true,
                recoveryReason: 'launch_failed'
            })])
            expect(stored.map((item) => item.id)).toEqual([reviewId])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps native questions pending until an exact user answer, not a status read', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-input-'))
        const sessionId = '80345678-1234-4234-8234-123456789012'
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(), () => 123, 1_000,
            { getSummary: () => ({ id: sessionId, title: 'Native', cwd, file: '/not-read', modifiedAt: 100, runState: 'idle' }) },
            () => client
        )
        try {
            sender.send(sessionId, 'Start', undefined, 'input-receipt')
            await flushMicrotasks()
            const input = { threadId: sessionId, turnId: 'native-turn-1', itemId: 'question-1', questions: [
                { id: 'choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Proceed' }] }
            ] }
            const settled = vi.fn()
            const answer = Promise.resolve(client.handlers.get('item/tool/requestUserInput')!(input)).then((value) => { settled(value); return value })
            await flushMicrotasks()
            expect(settled).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({ success: true, waitingForUserInput: true, pendingUserInput: input })
            const second = { ...input, itemId: 'question-2' }
            const secondAnswer = Promise.resolve(client.handlers.get('item/tool/requestUserInput')!(second))
            const context = { controlledByCodexSsh: false, activeTurnId: 'native-turn-1' }
            await expect(sender.control(sessionId, { action: 'answerUserInput', expectedTurnId: 'old-turn', requestId: 'question-1', answers: { choice: { answers: ['Yes'] } } }, context)).resolves.toMatchObject({ success: false, code: 'turn_changed' })
            expect(settled).not.toHaveBeenCalled()
            const action = { action: 'answerUserInput' as const, expectedTurnId: 'native-turn-1', requestId: 'question-1', answers: { choice: { answers: ['Yes'] } } }
            await expect(sender.control(sessionId, action, context)).resolves.toMatchObject({ success: true })
            await expect(answer).resolves.toEqual({ answers: { choice: { answers: ['Yes'] } } })
            await expect(sender.control(sessionId, action, context)).resolves.toMatchObject({ success: false, code: 'turn_changed' })
            expect(settled).toHaveBeenCalledTimes(1)
            expect(sender.getStatus(sessionId)).toMatchObject({ pendingUserInput: second })
            await expect(sender.control(sessionId, { ...action, requestId: 'question-2' }, context)).resolves.toMatchObject({ success: true })
            await expect(secondAnswer).resolves.toEqual({ answers: { choice: { answers: ['Yes'] } } })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('pendingUserInput')
            const third = { ...input, itemId: 'question-3' }
            const thirdAnswer = Promise.resolve(client.handlers.get('item/tool/requestUserInput')!(third, { requestId: 123 }))
            client.notificationHandler?.('serverRequest/resolved', { threadId: 'other-thread', requestId: 123 })
            expect(sender.getStatus(sessionId)).toMatchObject({ pendingUserInput: third })
            client.notificationHandler?.('serverRequest/resolved', { threadId: sessionId, requestId: 'question-3' })
            expect(sender.getStatus(sessionId)).toMatchObject({ pendingUserInput: third })
            client.notificationHandler?.('serverRequest/resolved', { threadId: sessionId, requestId: 123 })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('pendingUserInput')
            await thirdAnswer
            await expect(sender.control(sessionId, { ...action, requestId: 'question-3' }, context)).resolves.toMatchObject({ success: false, code: 'turn_changed' })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
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
                    history: [
                        { phase: 'launching', startedAt: 123 },
                        { phase: 'matching', startedAt: 123 }
                    ],
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
                activeClientMessageId: 'native:bridge-1',
                progress: {
                    phase: 'connected', transport: 'app-server',
                    history: [
                        { phase: 'launching', startedAt: 123 },
                        { phase: 'matching', startedAt: 123 },
                        { phase: 'connected', startedAt: 123 }
                    ]
                }
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
            expect(sender.getStatus(sessionId)).toEqual({
                success: true, status: 'idle', queuedMessages: [],
                deliveryReceipts: [{ id: 'native:bridge-1', state: 'delivered' }]
            })
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
                    attempt: 2,
                    history: [
                        { phase: 'launching', startedAt: 123 },
                        { phase: 'matching', startedAt: 123 },
                        { phase: 'retrying', startedAt: 123 }
                    ]
                }
            })
            expect(client.disconnectCalls).toBe(1)
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it.each(['idle-check', 'setup-error'] as const)('keeps an unsent bridge queued when status becomes unknown during %s', async (failurePoint) => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-unsent-unknown-'))
        const sessionId = '81845678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'unknown' = 'idle'
        const client = new FakeAppServerClient()
        client.initializeHook = () => {
            runState = 'unknown'
            if (failurePoint === 'setup-error') throw new Error('setup connection lost')
        }
        const nextClient = new FakeAppServerClient()
        const createClient = vi.fn().mockReturnValueOnce(client).mockReturnValue(nextClient)
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const store = { load: () => [], save: vi.fn() }
        const sender = new NativeCodexSessionDirectSender(spawn, () => 123, 10, {
            getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 100, runState })
        }, createClient, store)

        try {
            sender.send(sessionId, 'Wait until idle', undefined, 'native:unsent')
            await flushMicrotasks()
            expect(client.startTurnCalls).toHaveLength(0)
            expect(spawn).not.toHaveBeenCalled()
            expect(store.save).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'native:unsent', recoveryRequired: false })])
            expect(sender.getStatus(sessionId)).toMatchObject({
                status: 'unknown', queuedMessages: [{ id: 'native:unsent' }]
            })
            await vi.advanceTimersByTimeAsync(20)
            expect(createClient).toHaveBeenCalledTimes(1)

            runState = 'idle'
            await vi.advanceTimersByTimeAsync(20)
            expect(nextClient.startTurnCalls).toHaveLength(1)
            expect(sender.getStatus(sessionId)).toMatchObject({ queuedMessages: [] })
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it.each([false, true])('restores bridge setup safely while preserving an attempted=%s crash guard', async (attempted) => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-bridge-crash-edge-'))
        const sessionId = '81845678-1234-4234-8234-123456789012'
        const lookup = { getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 100, runState: 'idle' as const }) }
        let saved: NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => structuredClone(saved),
            save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => { saved = structuredClone([...items]) }
        }
        const client = new FakeAppServerClient()
        if (attempted) client.startTurn = () => new Promise<TurnStartResponse>(() => {})
        else client.connect = () => new Promise<void>(() => {})
        const sender = new NativeCodexSessionDirectSender(vi.fn(), () => 123, 10, lookup, () => client, store)
        const replacementClient = new FakeAppServerClient()
        let replacement: NativeCodexSessionDirectSender | null = null
        try {
            sender.send(sessionId, 'Only retry if unsent', undefined, 'native:crash-edge')
            await flushMicrotasks()
            expect(saved).toEqual([expect.objectContaining({ id: 'native:crash-edge', recoveryRequired: attempted })])
            sender.dispose()
            replacement = new NativeCodexSessionDirectSender(vi.fn(), () => 124, 10, lookup, () => replacementClient, store)
            await vi.advanceTimersByTimeAsync(20)
            expect(replacementClient.startTurnCalls).toHaveLength(attempted ? 0 : 1)
            if (attempted) expect(replacement.getStatus(sessionId)).toMatchObject({
                queuedMessages: [{ id: 'native:crash-edge', recoveryRequired: true, recoveryReason: 'runner_restarted' }]
            })
        } finally {
            sender.dispose()
            replacement?.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not attempt turn/start if its crash guard cannot be saved', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-bridge-guard-write-'))
        const sessionId = '81845678-1234-4234-8234-123456789012'
        let rejectGuard = true
        const store = {
            load: () => [],
            save: vi.fn((items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                if (rejectGuard && items.some(item => item.recoveryRequired)) throw new Error('disk unavailable')
            })
        }
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(vi.fn(), () => 123, 10, {
            getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 100, runState: 'idle' })
        }, () => client, store)
        try {
            sender.send(sessionId, 'Save before send', undefined, 'native:guard-write')
            await flushMicrotasks()
            expect(client.startTurnCalls).toHaveLength(0)
            expect(store.save).toHaveBeenLastCalledWith([expect.objectContaining({ recoveryRequired: false })])
            rejectGuard = false
            await vi.advanceTimersByTimeAsync(5_000)
            expect(client.startTurnCalls).toHaveLength(1)
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps an external native writer conflict before turn/start in the durable FIFO', async () => {
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
        const createClient = vi.fn(() => blockedClient)
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
                queuedMessages: [expect.objectContaining({
                    id: 'native:active-writer',
                    text: 'Ignore this locked prompt'
                })]
            })
            expect(store.save).toHaveBeenLastCalledWith([expect.objectContaining({
                id: 'native:active-writer',
                recoveryRequired: false
            })])
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('hands an exec-resume active-writer conflict to the shared FIFO without blocking later messages', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-exec-active-writer-workspace-'))
        const sessionId = '81845678-1234-4234-8234-123456789099'
        const child = new FakeChildProcess()
        const privateClient = new FakeAppServerClient()
        privateClient.resumeError = new Error('bridge unavailable')
        const sharedClients = [new FakeAppServerClient(), new FakeAppServerClient()]
        let sharedClientIndex = 0
        let ownershipChecks = 0
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(() => child as never),
            () => 123,
            1_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Externally owned native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            () => privateClient,
            null,
            null,
            async () => {
                ownershipChecks += 1
                return ownershipChecks > 1
            },
            () => sharedClients[sharedClientIndex++]!
        )

        try {
            await expect(sender.sendWithExternalControlCheck(
                sessionId,
                '1-1',
                undefined,
                'native:exec-conflict-first'
            )).resolves.toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()

            child.stderr.emit('data', 'failed to initialize thread persistence: thread-store conflict: thread already has an active writer')
            child.emit('exit', 1, null)
            await flushAsyncWork()

            expect(sharedClients[0]!.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({
                    threadId: sessionId,
                    clientUserMessageId: 'native:exec-conflict-first'
                })
            })])
            expect(sender.getStatus(sessionId)).not.toHaveProperty('lastErrorCode')

            await expect(sender.sendWithExternalControlCheck(
                sessionId,
                '1-2',
                undefined,
                'native:exec-conflict-second'
            )).resolves.toMatchObject({ success: true, status: 'queued' })
            expect(sharedClients[1]!.requestCalls).toEqual([])

            sender.notifyTranscriptChanged(sessionId, [{ text: '1-1', createdAt: 124 }])
            await flushAsyncWork()
            expect(sharedClients[1]!.requestCalls).toEqual([expect.objectContaining({
                method: 'thread/queue/add',
                params: expect.objectContaining({ clientUserMessageId: 'native:exec-conflict-second' })
            })])
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

    it('keeps an accepted bridge alive when transcript feedback is delayed', async () => {
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
            now = 120_001
            await vi.advanceTimersByTimeAsync(1_000)

            expect(client.disconnectCalls).toBe(0)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                deliveryReceipts: [{ id: 'native:unknown-bridge', state: 'accepted' }],
                queuedMessages: []
            })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('lastErrorCode')
        } finally {
            sender.dispose()
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('does not kill a live fallback child just because transcript evidence is delayed', async () => {
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

            expect(kill).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                activeClientMessageId: 'native:unknown-exec', queuedMessages: []
            })
            expect(sender.getStatus(sessionId)).not.toHaveProperty('lastErrorCode')
            // Only an actual child failure closes the live hand-off.
            child.emit('error', new Error('Native child exited unexpectedly'))
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

    it('never uses the earlier identical prompt to confirm a later ambiguous send', async () => {
        vi.useFakeTimers()
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-exec-timeout-evidence-workspace-'))
        const sessionId = '85345678-1234-4234-8234-123456789012'
        let now = 0
        const stored: NativeCodexSessionDirectSendStoredItem[] = []
        const firstChild = new FakeChildProcess()
        const secondChild = new FakeChildProcess()
        const firstKill = vi.fn(() => true)
        const secondKill = vi.fn(() => true)
        Object.assign(firstChild, { kill: firstKill })
        Object.assign(secondChild, { kill: secondKill })
        const children = [firstChild, secondChild]
        const sender = new NativeCodexSessionDirectSender(
            () => children.shift() as never,
            () => now,
            1_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'Native thread',
                    cwd,
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    runState: 'idle' as const
                })
            },
            null,
            {
                load: () => [...stored],
                save: (items) => {
                    stored.splice(0, stored.length, ...items)
                }
            }
        )

        try {
            expect(sender.send(sessionId, '1+1', undefined, 'native:first')).toMatchObject({ success: true, status: 'processing' })
            sender.notifyTranscriptChanged(sessionId, [{ text: '1+1', createdAt: now }])
            firstChild.emit('exit', 0, null)
            now = 500
            expect(sender.send(sessionId, '1+1', undefined, 'native:second')).toMatchObject({ success: true, status: 'processing' })
            now = 20_501
            await vi.advanceTimersByTimeAsync(1_000)
            expect(secondKill).not.toHaveBeenCalled()
            secondChild.emit('error', new Error('Lost child response'))
            // The old identical record may appear again in a watcher window.
            sender.notifyTranscriptChanged(sessionId, [{ text: '1+1', createdAt: 0 }])
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true, status: 'idle', lastErrorClientMessageId: 'native:second',
                lastErrorCode: 'session_status_unknown', queuedMessages: [expect.objectContaining({
                    id: 'native:second', recoveryRequired: true, recoveryReason: 'session_status_unknown'
                })]
            })
            expect(stored).toEqual(expect.arrayContaining([expect.objectContaining({
                id: 'native:second', recoveryRequired: true, recoveryReason: 'session_status_unknown'
            })]))
            expect(stored.find((item) => item.id === 'native:second')?.transcriptConfirmed).not.toBe(true)
            expect(sender.needsTranscriptDeliveryEvidence(sessionId)).toBe(true)
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
                    history: [{ phase: 'launching', startedAt: 123 }],
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
                    history: [{ phase: 'launching', startedAt: 123 }],
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
                    history: [{ phase: 'launching', startedAt: 789 }],
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
                    history: [{ phase: 'launching', startedAt: 789 }],
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

    it('allows an explicitly authorized local handoff to resume a SHAPI-origin thread', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-released-direct-workspace-'))
        const sessionId = '11345678-1234-4234-8234-123456789013'
        const client = new FakeAppServerClient()
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            Date.now,
            1_000,
            { getSummary: () => ({
                id: sessionId,
                title: 'Locally handed-off SHAPI thread',
                cwd,
                file: '/not-read.jsonl',
                modifiedAt: 0,
                originator: 'hapi-codex-client',
                runState: 'idle'
            }) },
            () => client,
            null,
            null,
            async () => false
        )

        try {
            await expect(sender.sendWithExternalControlCheck(
                sessionId,
                'continue after handoff',
                undefined,
                'native:released-handoff',
                undefined,
                undefined,
                undefined,
                undefined,
                true
            )).resolves.toMatchObject({ success: true, status: 'processing' })
            await flushMicrotasks()
            expect(client.resumeCalls).toEqual([expect.objectContaining({ threadId: sessionId })])
            expect(client.startTurnCalls).toHaveLength(1)
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

    it('allows an exact queued receipt to be discarded after the transcript is recognized as SHAPI-managed', () => {
        const storeDir = mkdtempSync(join(tmpdir(), 'hapi-managed-direct-discard-store-'))
        const sessionId = '35445678-1234-4234-8234-123456789012'
        const store = new FileNativeCodexSessionDirectSendStore(join(storeDir, 'native-outbox.json'))
        store.save([{
            sessionId,
            id: 'native:discard-managed',
            text: 'Do not retry this message',
            deliveryText: 'Do not retry this message',
            queuedAt: 600,
            recoveryRequired: false
        }])
        const sender = new NativeCodexSessionDirectSender(
            vi.fn<SpawnNativeCodexProcess>(),
            () => 701,
            1_000,
            {
                getSummary: () => ({
                    id: sessionId,
                    title: 'SHAPI-managed thread',
                    cwd: '/workspace',
                    file: '/not-read.jsonl',
                    modifiedAt: 100,
                    originator: 'hapi-codex-client',
                    runState: 'processing'
                })
            },
            null,
            store
        )

        try {
            expect(sender.discard(sessionId, 'native:discard-managed')).toEqual({
                success: true,
                discarded: true,
                queuedMessages: []
            })
            expect(store.load()).toEqual([])
        } finally {
            sender.dispose()
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

    it('does not let an orphan recovery bypass an earlier local FIFO receipt', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-recovery-fifo-workspace-'))
        const sessionId = '26445678-1234-4234-8234-123456789013'
        let runState: 'idle' | 'processing' = 'processing'
        const spawn = vi.fn<SpawnNativeCodexProcess>()
        const sender = new NativeCodexSessionDirectSender(
            spawn,
            () => 500,
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
            }
        )

        try {
            expect(sender.send(sessionId, 'Earlier FIFO message', undefined, 'native:fifo-a')).toMatchObject({
                success: true,
                status: 'queued'
            })
            runState = 'idle'

            expect(sender.send(
                sessionId,
                'Orphan recovery must wait',
                undefined,
                'native:fifo-b',
                true
            )).toEqual({
                success: false,
                code: 'session_busy',
                error: 'An earlier native message must be recovered first'
            })
            expect(spawn).not.toHaveBeenCalled()
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                queuedMessages: [expect.objectContaining({ id: 'native:fifo-a' })]
            })
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

    it('queues while the native transcript is processing and keeps unknown receipts safe', () => {
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
            expect(sender.send(legacySessionId, 'hello', undefined, 'native:unknown-receipt')).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 1,
                queuedMessages: [{ id: 'native:unknown-receipt', text: 'hello' }]
            })
            expect(sender.getStatus(legacySessionId)).toMatchObject({
                success: true,
                status: 'unknown',
                queuedMessages: [{ id: 'native:unknown-receipt', text: 'hello' }]
            })
            expect(spawn).not.toHaveBeenCalled()
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('persists unknown-state receipts in FIFO and starts only after an idle observation', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-unknown-queue-workspace-'))
        const sessionId = '33345678-1234-4234-8234-123456789012'
        let runState: 'idle' | 'unknown' = 'unknown'
        const persisted: NativeCodexSessionDirectSendStoredItem[] = []
        const store = {
            load: () => [...persisted],
            save: (items: readonly NativeCodexSessionDirectSendStoredItem[]) => {
                persisted.splice(0, persisted.length, ...items)
            }
        }
        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
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
            store
        )

        try {
            expect(sender.send(sessionId, 'first unknown receipt', undefined, 'native:unknown-first')).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 1
            })
            expect(sender.send(sessionId, 'second unknown receipt', undefined, 'native:unknown-second')).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 2
            })
            expect(persisted.map((item) => ({ id: item.id, recoveryRequired: item.recoveryRequired }))).toEqual([
                { id: 'native:unknown-first', recoveryRequired: false },
                { id: 'native:unknown-second', recoveryRequired: false }
            ])

            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)
            expect(spawn).not.toHaveBeenCalled()

            runState = 'idle'
            ;(sender as unknown as { pumpQueue: (id: string) => void }).pumpQueue(sessionId)

            expect(spawn).toHaveBeenCalledTimes(1)
            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'first unknown receipt'],
                cwd
            )
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [{ id: 'native:unknown-second', text: 'second unknown receipt' }]
            })
        } finally {
            sender.dispose()
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
