import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeCodexTranscriptCache } from './nativeTranscriptCache'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
    if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
    } else {
        process.env.CODEX_HOME = originalCodexHome
    }
})

function transcriptRecord(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

describe('NativeCodexTranscriptCache', () => {
    it('serves a warm page from memory and advances only appended JSONL records', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-cache-'))
        const sessionId = 'a1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(
            file,
            [
                transcriptRecord({
                    type: 'session_meta',
                    payload: { id: sessionId, cwd: '/workspace/project' }
                }),
                transcriptRecord({
                    timestamp: '2026-08-28T10:00:00.000Z',
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'First prompt' }]
                    }
                }),
                transcriptRecord({
                    type: 'event_msg',
                    payload: { type: 'task_complete' }
                })
            ].join(''),
            'utf8'
        )
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache({ runnerEpoch: 'runner-a' })

        try {
            const first = cache.read(sessionId, { limit: 50 })
            expect(first?.timing.cache).toBe('miss')
            expect(first?.revision).toBe(1)
            expect(first?.version).toEqual({ runnerEpoch: 'runner-a', revision: 1 })
            expect(first?.data.importedMessages).toMatchObject([{ role: 'user', content: { text: 'First prompt' } }])
            expect(first?.data.session.runState).toBe('idle')

            const warm = cache.read(sessionId, { limit: 50 })
            expect(warm?.timing.cache).toBe('hit')
            expect(warm?.revision).toBe(first?.revision)
            expect(warm?.version).toEqual(first?.version)

            appendFileSync(
                file,
                [
                    transcriptRecord({
                        type: 'event_msg',
                        payload: { type: 'task_started' }
                    }),
                    transcriptRecord({
                        timestamp: '2026-08-28T10:00:02.000Z',
                        type: 'response_item',
                        payload: {
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'Fresh answer' }]
                        }
                    }),
                    transcriptRecord({
                        type: 'event_msg',
                        payload: { type: 'task_complete' }
                    })
                ].join(''),
                'utf8'
            )

            const advanced = cache.refreshCached(sessionId, { limit: 50 })
            expect(advanced?.timing.cache).toBe('miss')
            expect(advanced?.revision).toBe((first?.revision ?? 0) + 1)
            expect(advanced?.version).toEqual({ runnerEpoch: 'runner-a', revision: advanced?.revision })
            expect(advanced?.data.importedMessages).toMatchObject([
                { role: 'user', content: { text: 'First prompt' } },
                {
                    role: 'agent',
                    content: { data: { type: 'message', message: 'Fresh answer' } }
                }
            ])
            expect(advanced?.data.session.runState).toBe('idle')

            const warmAgain = cache.read(sessionId, { limit: 50 })
            expect(warmAgain?.timing.cache).toBe('hit')
            expect(warmAgain?.revision).toBe(advanced?.revision)
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('buffers an unfinished tail record until Codex completes it', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-partial-'))
        const sessionId = 'b1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(
            file,
            [
                transcriptRecord({
                    type: 'session_meta',
                    payload: { id: sessionId, cwd: '/workspace/project' }
                }),
                transcriptRecord({
                    timestamp: '2026-08-28T10:00:00.000Z',
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'Initial' }]
                    }
                })
            ].join(''),
            'utf8'
        )
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            expect(cache.read(sessionId, { limit: 50 })?.data.importedMessages).toHaveLength(1)
            const tail = transcriptRecord({
                timestamp: '2026-08-28T10:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Completed after two writes' }]
                }
            })
            const midpoint = Math.floor(tail.length / 2)
            appendFileSync(file, tail.slice(0, midpoint), 'utf8')

            const partial = cache.refreshCached(sessionId, { limit: 50 })
            expect(partial?.data.importedMessages).toHaveLength(1)

            appendFileSync(file, tail.slice(midpoint), 'utf8')
            const completed = cache.refreshCached(sessionId, { limit: 50 })
            expect(completed?.data.importedMessages).toMatchObject([
                { role: 'user', content: { text: 'Initial' } },
                {
                    role: 'agent',
                    content: {
                        data: { type: 'message', message: 'Completed after two writes' }
                    }
                }
            ])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('exposes bounded turn-scoped lifecycle records without putting them in RPC data', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-lifecycle-'))
        const sessionId = 'd1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } })
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            expect(cache.read(sessionId, { limit: 1 })?.lifecycleEvents).toEqual([
                { type: 'task_started', turnId: 'turn-a' },
                { type: 'task_complete', turnId: 'turn-a' }
            ])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('keeps cold lifecycle checks summary-only and inside the latest 16 KiB', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-summary-'))
        const sessionId = 'e1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-old' } }),
            transcriptRecord({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'x'.repeat(32 * 1024) }]
                }
            }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-live' } })
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            expect(cache.readSummary(sessionId)).toMatchObject({
                session: { id: sessionId, runState: 'processing' },
                lifecycleEvents: [{ type: 'task_started', turnId: 'turn-live' }]
            })
            const entries = (cache as unknown as {
                entries: Map<string, { importedMessages: unknown[] | null }>
            }).entries
            expect(entries.get(sessionId)?.importedMessages).toBeNull()
            expect(cache.readCached(sessionId, { limit: 1 })).toBeNull()
            expect(cache.refreshCached(sessionId, { limit: 1 })).toBeNull()
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('reconstructs a lifecycle record split across a cold summary read', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-summary-partial-'))
        const sessionId = 'f1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        const terminalRecord = transcriptRecord({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-a' }
        })
        const midpoint = Math.floor(terminalRecord.length / 2)
        writeFileSync(file, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } }),
            terminalRecord.slice(0, midpoint)
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            expect(cache.readSummary(sessionId)).toMatchObject({
                session: { id: sessionId, runState: 'processing' },
                lifecycleEvents: [{ type: 'task_started', turnId: 'turn-a' }]
            })

            appendFileSync(file, terminalRecord.slice(midpoint), 'utf8')

            expect(cache.refreshSummary(sessionId)).toMatchObject({
                session: { id: sessionId, runState: 'idle' },
                lifecycleEvents: [
                    { type: 'task_started', turnId: 'turn-a' },
                    { type: 'task_complete', turnId: 'turn-a' }
                ]
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('keeps native tool timing when a result arrives in a later append', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-tool-tail-'))
        const sessionId = 'c1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({
                timestamp: '2026-08-28T10:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call',
                    call_id: 'tail-tool',
                    name: 'exec',
                    input: 'pwd'
                }
            })
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            expect(cache.read(sessionId, { limit: 50 })?.data.importedMessages).toMatchObject([
                { content: { data: { type: 'tool-call', startedAt: Date.parse('2026-08-28T10:00:00.000Z') } } }
            ])
            appendFileSync(file, transcriptRecord({
                timestamp: '2026-08-28T10:00:01.250Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call_output',
                    call_id: 'tail-tool',
                    output: 'project'
                }
            }), 'utf8')

            const advanced = cache.refreshCached(sessionId, { limit: 50 })
            expect(advanced?.data.importedMessages[1]).toMatchObject({
                content: {
                    data: {
                        type: 'tool-call-result',
                        callId: 'tail-tool',
                        completedAt: Date.parse('2026-08-28T10:00:01.250Z'),
                        durationMs: 1_250
                    }
                }
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})
