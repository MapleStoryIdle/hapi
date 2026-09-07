import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    FileNativeCodexSessionDirectSendStore, NativeCodexSessionDirectSender,
    type NativeCodexAppServerClient
} from './nativeSessionDirectSend'
import { FileNativeCodexSessionControlStore } from './nativeCodexControlStore'
import type { TurnStartParams } from './appServerTypes'

const sessionId = '78345678-1234-4234-8234-123456789025'
const idleContext = { controlledByCodexSsh: false, activeTurnId: null }
const cleanups: Array<() => void> = []
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    vi.useRealTimers()
})

function bridge(turnId: string) {
    let handler: ((method: string, params: unknown) => void) | null = null
    const client = {
        connect: vi.fn(async () => {}), initialize: vi.fn(async () => ({})),
        resumeThread: vi.fn(async () => ({})),
        startTurn: vi.fn(async (_params: TurnStartParams) => ({ turn: { id: turnId } })),
        interruptTurn: vi.fn(async () => ({})), disconnect: vi.fn(async () => {}),
        setNotificationHandler: (next: typeof handler) => { handler = next }
    } satisfies NativeCodexAppServerClient
    return {
        client,
        complete: () => handler?.('turn/completed', { threadId: sessionId, turn: { id: turnId, status: 'completed' } })
    }
}

async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5)
}

function temporaryDirectory() {
    const path = mkdtempSync(join(tmpdir(), 'shapi-native-control-regression-'))
    cleanups.push(() => rmSync(path, { recursive: true, force: true }))
    return path
}

describe('native controls persistence and race regression', () => {
    it.each([false, true])('uses an existing shared receipt snapshot instead of newer defaults (recovery=%s)', async (recover) => {
        vi.useFakeTimers()
        const cwd = temporaryDirectory()
        const outbox = new FileNativeCodexSessionDirectSendStore(join(cwd, 'outbox.json'))
        outbox.save([{ sessionId, id: 'old-receipt', text: 'old message', deliveryText: 'old message', queuedAt: Date.now(),
            recoveryRequired: true, recoveryReason: 'session_status_unknown', configuration: {} }])
        const controlStore = new FileNativeCodexSessionControlStore(join(cwd, 'controls.json'))
        controlStore.save([{ sessionId, configuration: { model: 'new-default' }, queuePaused: false }])
        const request = vi.fn(async (method: string) => method === 'thread/read'
            ? { thread: { id: sessionId, status: { type: 'idle' }, turns: [] } }
            : { queuedSubmission: { id: 'submission', clientUserMessageId: 'old-receipt' } })
        const shared = { ...bridge('unused').client, request }
        const sender = new NativeCodexSessionDirectSender(
            () => { throw new Error('Unexpected exec fallback') }, Date.now, 1,
            { getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            null, outbox, null, async () => true, () => shared, controlStore
        )
        cleanups.push(() => sender.dispose())
        expect(sender.send(sessionId, 'old message', undefined, 'old-receipt', recover, undefined, undefined, true))
            .toMatchObject({ success: true, status: 'queued' })
        expect(sender.getControls(sessionId).queuePaused).toBe(false)
        await settle()
        if (recover) {
            expect(request).toHaveBeenCalledWith('thread/queue/add', {
                threadId: sessionId, clientUserMessageId: 'old-receipt', input: [{ type: 'text', text: 'old message' }]
            })
        } else expect(request).not.toHaveBeenCalled()
        expect(sender.getControls(sessionId).queuePaused).toBe(false)
    })

    it('does not restore a completed stop marker when asynchronous configuration validation finishes', async () => {
        vi.useFakeTimers()
        const cwd = temporaryDirectory()
        const active = bridge('turn-current')
        let resolveValidation!: (value: { success: true }) => void
        const validate = vi.fn(() => new Promise<{ success: true }>((resolve) => { resolveValidation = resolve }))
        const sender = new NativeCodexSessionDirectSender(
            () => { throw new Error('Unexpected exec fallback') }, Date.now, 1,
            { getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            () => active.client, null, null, null, null, null, validate
        )
        cleanups.push(() => sender.dispose())
        sender.send(sessionId, 'run', undefined, 'run')
        await settle()
        await sender.control(sessionId, { action: 'stop', expectedTurnId: 'turn-current' }, { ...idleContext, activeTurnId: 'turn-current' })
        expect(sender.getControls(sessionId).stoppingTurnId).toBe('turn-current')
        const saving = sender.control(sessionId, { action: 'configure', configuration: { model: 'model-a' } }, idleContext)
        await settle()
        active.complete()
        expect(sender.getControls(sessionId).stoppingTurnId).toBeUndefined()
        resolveValidation({ success: true })
        await saving
        expect(sender.getControls(sessionId)).toMatchObject({ queuePaused: true, configuration: { model: 'model-a' } })
        expect(sender.getControls(sessionId).stoppingTurnId).toBeUndefined()
    })

    it('wakes a message accepted while configuration validation held the control reservation', async () => {
        vi.useFakeTimers()
        const cwd = temporaryDirectory()
        const active = bridge('turn-current')
        let resolveValidation!: (value: { success: true }) => void
        const validate = vi.fn(() => new Promise<{ success: true }>((resolve) => { resolveValidation = resolve }))
        const sender = new NativeCodexSessionDirectSender(
            () => { throw new Error('Unexpected exec fallback') }, Date.now, 1,
            { getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            () => active.client, null, null, null, null, null, validate
        )
        cleanups.push(() => sender.dispose())
        const saving = sender.control(sessionId, { action: 'configure', configuration: { model: 'model-a' } }, idleContext)
        await settle()
        expect(validate).toHaveBeenCalledTimes(1)
        expect(sender.send(sessionId, 'accepted during configuration', undefined, 'during-config')).toMatchObject({ success: true, status: 'queued' })
        expect(active.client.startTurn).not.toHaveBeenCalled()
        resolveValidation({ success: true })
        await saving
        await settle()
        expect(active.client.startTurn).toHaveBeenCalledTimes(1)
        await settle()
        expect(active.client.startTurn).toHaveBeenCalledTimes(1)
    })

    it('restores the real paused files and preserves each queued settings snapshot across changes and restart', async () => {
        vi.useFakeTimers()
        const cwd = temporaryDirectory()
        const outbox = new FileNativeCodexSessionDirectSendStore(join(cwd, 'outbox.json'))
        const controlStore = new FileNativeCodexSessionControlStore(join(cwd, 'controls.json'))
        controlStore.save([{ sessionId, configuration: {}, queuePaused: true }])
        const first = bridge('first-turn')
        const second = bridge('second-turn')
        const factory = vi.fn().mockReturnValueOnce(first.client).mockReturnValueOnce(second.client)
        const spawn = vi.fn(() => { throw new Error('Unexpected exec fallback') })
        const lookup = { getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 1, runState: 'idle' as const }) }
        const makeSender = () => {
            const sender = new NativeCodexSessionDirectSender(spawn, Date.now, 1, lookup, factory, outbox, null, null, null, controlStore)
            cleanups.push(() => sender.dispose())
            return sender
        }
        const beforeRestart = makeSender()
        await beforeRestart.control(sessionId, { action: 'configure', configuration: { model: 'model-a', modelReasoningEffort: 'high', serviceTier: 'fast' } }, idleContext)
        expect(beforeRestart.send(sessionId, 'first', undefined, 'first')).toMatchObject({ success: true, status: 'queued' })
        await beforeRestart.control(sessionId, { action: 'configure', configuration: { model: 'model-b', modelReasoningEffort: 'low', serviceTier: 'standard' } }, idleContext)
        expect(beforeRestart.send(sessionId, 'second', undefined, 'second')).toMatchObject({ success: true, status: 'queued' })
        beforeRestart.dispose()
        const restored = makeSender()
        await settle()
        expect(factory).not.toHaveBeenCalled()
        expect(restored.getControls(sessionId).queuePaused).toBe(true)
        await restored.control(sessionId, { action: 'resumeQueue' }, idleContext)
        await settle()
        expect(first.client.startTurn).toHaveBeenCalledExactlyOnceWith({
            threadId: sessionId, input: [{ type: 'text', text: 'first' }],
            model: 'model-a', effort: 'high', serviceTierForTurn: 'priority'
        })
        first.complete()
        await settle()
        expect(second.client.startTurn).toHaveBeenCalledExactlyOnceWith({
            threadId: sessionId, input: [{ type: 'text', text: 'second' }],
            model: 'model-b', effort: 'low', serviceTierForTurn: 'default'
        })
        expect(factory).toHaveBeenCalledTimes(2)
        expect(spawn).not.toHaveBeenCalled()
    })

    it('does not interrupt an old private client when its turn completes during the ownership check', async () => {
        vi.useFakeTimers()
        const cwd = temporaryDirectory()
        const active = bridge('turn-current')
        let resolveOwner!: (held: boolean) => void
        const checkOwner = vi.fn(async () => false)
        const sender = new NativeCodexSessionDirectSender(
            () => { throw new Error('Unexpected exec fallback') }, Date.now, 1,
            { getSummary: () => ({ id: sessionId, cwd, title: 'Native', file: '/not-read', modifiedAt: 1, runState: 'idle' }) },
            () => active.client, null, null, checkOwner
        )
        cleanups.push(() => sender.dispose())
        expect(sender.send(sessionId, 'run')).toMatchObject({ success: true })
        await settle()
        expect(active.client.startTurn).toHaveBeenCalledTimes(1)
        checkOwner.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveOwner = resolve }))
        const stopping = sender.control(sessionId, { action: 'stop', expectedTurnId: 'turn-current' }, { ...idleContext, activeTurnId: 'turn-current' })
        await Promise.resolve()
        active.complete()
        resolveOwner(false)
        expect(await stopping).toMatchObject({ success: false, code: 'turn_changed' })
        expect(active.client.interruptTurn).not.toHaveBeenCalled()
        expect(sender.getControls(sessionId)).toMatchObject({ queuePaused: false })
        expect(sender.getControls(sessionId).stoppingTurnId).toBeUndefined()
    })
})
