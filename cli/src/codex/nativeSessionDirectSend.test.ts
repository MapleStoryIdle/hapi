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
            expect(sender.getStatus(sessionId)).toEqual({ success: true, status: 'idle' })
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
                startedAt: 123
            })

            child.emit('exit', 0, null)
            expect(sender.getStatus(sessionId)).toEqual({ success: true, status: 'idle' })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })

    it('locks when the native transcript is processing or cannot prove an idle state', () => {
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
            expect(sender.send(activeSessionId, 'hello')).toMatchObject({
                success: false,
                code: 'session_busy'
            })
            expect(sender.send(legacySessionId, 'hello')).toMatchObject({
                success: false,
                code: 'session_status_unknown'
            })
            expect(spawn).not.toHaveBeenCalled()
        } finally {
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
            rmSync(codexHome, { recursive: true, force: true })
            rmSync(cwd, { recursive: true, force: true })
        }
    })
})
