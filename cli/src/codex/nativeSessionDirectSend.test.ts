import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    NativeCodexSessionDirectSender,
    type SpawnNativeCodexProcess
} from './nativeSessionDirectSend'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
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
                startedAt: 123
            })
            expect(spawn).toHaveBeenCalledWith(
                ['exec', 'resume', '--json', sessionId, 'Continue this work'],
                cwd
            )
            expect(sender.getStatus(sessionId)).toEqual({
                success: true,
                status: 'processing',
                startedAt: 123,
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
        const sender = new NativeCodexSessionDirectSender(spawn, Date.now, 1_000, () => false, {
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
        const sender = new NativeCodexSessionDirectSender(spawn, () => 321, 1_000, () => false, {
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
                ['exec', 'resume', '--json', sessionId, 'release as soon as idle'],
                cwd
            )
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

    it('uses the native Codex queue when an app-server owns the thread lock', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-queue-command-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-queue-workspace-'))
        const sessionId = '62345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        // No lifecycle marker: the transcript alone cannot prove idle, but
        // the owner app-server can serialize this request safely.
        writeTranscript({ codexHome, sessionId, cwd, events: [] })

        const child = new FakeChildProcess()
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => child as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 456, 1, () => true)

        try {
            expect(sender.send(sessionId, 'send through the owner')).toEqual({
                success: true,
                status: 'processing',
                startedAt: 456
            })
            expect(spawn).toHaveBeenCalledWith(
                ['queue', '--thread', sessionId, '--message', 'send through the owner'],
                cwd
            )
            child.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('keeps native messages visible until the owner can deliver them after idle', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-direct-owner-queue-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-native-direct-owner-workspace-'))
        const sessionId = '72345678-1234-4234-8234-123456789012'
        process.env.CODEX_HOME = codexHome
        writeTranscript({ codexHome, sessionId, cwd, events: ['task_started'] })

        const firstChild = new FakeChildProcess()
        const secondChild = new FakeChildProcess()
        const children = [firstChild, secondChild]
        const spawn = vi.fn<SpawnNativeCodexProcess>(() => children.shift() as never)
        const sender = new NativeCodexSessionDirectSender(spawn, () => 789, 1, () => true)

        try {
            expect(sender.send(sessionId, 'first')).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 1,
                queuedMessages: [{ text: 'first' }]
            })
            expect(sender.send(sessionId, 'second')).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 2,
                queuedMessages: [{ text: 'first' }, { text: 'second' }]
            })

            // A running native turn must leave both prompts in the visible
            // FIFO; the app-server command is not issued early.
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(spawn).not.toHaveBeenCalled()

            // Once the transcript closes the native turn, the owner receives
            // the first prompt and the second one remains visible until then.
            writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete'] })
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(spawn).toHaveBeenNthCalledWith(
                1,
                ['queue', '--thread', sessionId, '--message', 'first'],
                cwd
            )
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [{ text: 'second' }]
            })

            firstChild.emit('exit', 0, null)
            await new Promise((resolve) => setTimeout(resolve, 20))
            expect(spawn).toHaveBeenNthCalledWith(
                2,
                ['queue', '--thread', sessionId, '--message', 'second'],
                cwd
            )
            secondChild.emit('exit', 0, null)
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
            expect(spawn).toHaveBeenNthCalledWith(1, ['exec', 'resume', '--json', sessionId, 'first'], cwd)
            expect(sender.getStatus(sessionId)).toMatchObject({
                success: true,
                status: 'processing',
                queuedMessages: [{ text: 'second' }]
            })

            writeTranscript({ codexHome, sessionId, cwd, events: ['task_started', 'task_complete', 'task_started', 'task_complete'] })
            firstChild.emit('exit', 0, null)
            await new Promise((resolve) => setTimeout(resolve, 40))

            expect(spawn).toHaveBeenCalledTimes(2)
            expect(spawn).toHaveBeenNthCalledWith(2, ['exec', 'resume', '--json', sessionId, 'second'], cwd)
            expect(sender.getStatus(sessionId)).toMatchObject({ success: true, status: 'processing', queuedMessages: [] })
            secondChild.emit('exit', 0, null)
        } finally {
            sender.dispose()
            rmSync(codexHome, { recursive: true, force: true })
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
