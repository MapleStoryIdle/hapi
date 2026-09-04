import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
    it('refreshes native child cards when only a direct subagent transcript changes', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-subagent-'))
        const parentId = 'a1234567-1234-4234-8234-123456789012'
        const childId = 'b1234567-1234-4234-8234-123456789012'
        const turnId = 'c1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '09', '04')
        const parentFile = join(transcriptDir, `rollout-${parentId}.jsonl`)
        const childFile = join(transcriptDir, `rollout-${childId}.jsonl`)
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(parentFile, [
            transcriptRecord({ type: 'session_meta', payload: { id: parentId, cwd: '/workspace/project' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-turn' } })
        ].join(''), 'utf8')
        writeFileSync(childFile, [
            transcriptRecord({
                type: 'session_meta',
                payload: {
                    id: childId,
                    parent_thread_id: parentId,
                    source: {
                        subagent: {
                            thread_spawn: {
                                parent_thread_id: parentId,
                                agent_nickname: 'Ada',
                                agent_role: 'reviewer'
                            }
                        }
                    }
                }
            }),
            transcriptRecord({ type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'high' } }),
            transcriptRecord({
                timestamp: '2026-09-04T10:00:00.000Z',
                type: 'event_msg',
                payload: { type: 'task_started', turn_id: turnId }
            })
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        let now = 1_000
        const cache = new NativeCodexTranscriptCache({ now: () => now, runnerEpoch: 'runner-a' })

        try {
            const first = cache.read(parentId, { limit: 50 })
            expect(first?.data.subagents).toMatchObject([{
                id: childId,
                name: 'Ada',
                role: 'reviewer',
                status: 'running',
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high'
            }])

            appendFileSync(childFile, transcriptRecord({
                timestamp: '2026-09-04T10:00:01.000Z',
                type: 'event_msg',
                payload: { type: 'task_complete', turn_id: turnId }
            }))
            now += 5_001
            const completed = cache.readCached(parentId, { limit: 50 })
            expect(completed?.data.subagents).toMatchObject([{
                id: childId,
                status: 'completed',
                completedAt: Date.parse('2026-09-04T10:00:01.000Z')
            }])
            expect(completed?.revision).toBeGreaterThan(first?.revision ?? 0)
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('discovers a newly spawned child immediately from the parent control record', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-subagent-spawn-'))
        const parentId = 'd1234567-1234-4234-8234-123456789012'
        const childId = 'e1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '09', '04')
        const parentFile = join(transcriptDir, `rollout-${parentId}.jsonl`)
        const childFile = join(transcriptDir, `rollout-${childId}.jsonl`)
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(parentFile, transcriptRecord({
            type: 'session_meta',
            payload: { id: parentId, cwd: '/workspace/project' }
        }), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache({ now: () => 1_000, runnerEpoch: 'runner-a' })

        try {
            expect(cache.read(parentId, { limit: 50 })?.data.subagents).toEqual([])
            writeFileSync(childFile, [
                transcriptRecord({
                    type: 'session_meta',
                    payload: {
                        id: childId,
                        parent_thread_id: parentId,
                        source: {
                            subagent: {
                                thread_spawn: {
                                    parent_thread_id: parentId,
                                    agent_nickname: 'Grace'
                                }
                            }
                        }
                    }
                }),
                transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } })
            ].join(''), 'utf8')
            appendFileSync(parentFile, transcriptRecord({
                type: 'response_item',
                payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-child' }
            }))

            expect(cache.refreshCached(parentId, { limit: 50 })?.data.subagents).toMatchObject([{
                id: childId,
                name: 'Grace',
                status: 'running'
            }])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('switches a hot thread to a rotated active transcript and keeps earlier history', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-rotation-'))
        const sessionId = 'a1234567-1234-4234-8234-123456789012'
        const turnId = 'b1234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '09', '04')
        const firstFile = join(transcriptDir, `rollout-2026-09-04T10-00-00-${sessionId}.jsonl`)
        const rotatedFile = join(transcriptDir, `rollout-2026-09-04T10-05-00-${sessionId}_${turnId}.jsonl`)
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(firstFile, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Earlier prompt' }]
                }
            }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-one' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-one' } })
        ].join(''), 'utf8')
        const now = Date.now()
        utimesSync(firstFile, new Date(now - 10_000), new Date(now - 10_000))
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            const first = cache.read(sessionId, { limit: 50 })
            expect(first?.data.session.runState).toBe('idle')
            expect(first?.data.importedMessages).toMatchObject([
                { role: 'user', content: { type: 'text', text: 'Earlier prompt' } }
            ])

            writeFileSync(rotatedFile, [
                transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
                transcriptRecord({
                    type: 'response_item',
                    payload: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'Current prompt' }]
                    }
                }),
                transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-two' } })
            ].join(''), 'utf8')
            utimesSync(rotatedFile, new Date(now), new Date(now))

            const rotated = cache.refreshCachedFromFile(sessionId, rotatedFile, { limit: 50 })
            expect(rotated?.data.session).toMatchObject({ file: rotatedFile, runState: 'processing' })
            expect(rotated?.lifecycleEvents).toEqual([{ type: 'task_started', turnId: 'turn-two' }])
            expect(rotated?.data.importedMessages).toMatchObject([
                { role: 'user', content: { type: 'text', text: 'Earlier prompt' } },
                { role: 'user', content: { type: 'text', text: 'Current prompt' } }
            ])

            const coldRead = new NativeCodexTranscriptCache().read(sessionId, { limit: 50 })
            expect(coldRead?.data.session).toMatchObject({ file: rotatedFile, runState: 'processing' })
            expect(coldRead?.data.importedMessages).toMatchObject([
                { role: 'user', content: { type: 'text', text: 'Earlier prompt' } },
                { role: 'user', content: { type: 'text', text: 'Current prompt' } }
            ])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

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

    it('tracks native local-input waits from the bounded summary tail without retaining content', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-input-'))
        const sessionId = 'd2234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } }),
            transcriptRecord({
                type: 'response_item',
                turn_id: 'turn-a',
                payload: {
                    type: 'function_call',
                    name: 'request_user_input',
                    call_id: 'call-a',
                    arguments: '{"question":"PRIVATE"}'
                }
            })
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            expect(cache.readSummary(sessionId)).toMatchObject({
                session: { id: sessionId, runState: 'processing', waitingForUserInput: true },
                userInputEvents: [
                    { type: 'turn_started', turnId: 'turn-a' },
                    { type: 'requested', requestId: 'call-a', turnId: 'turn-a' }
                ]
            })

            appendFileSync(file, transcriptRecord({
                type: 'response_item',
                payload: { type: 'function_call_output', call_id: 'call-other', output: 'PRIVATE' }
            }), 'utf8')
            expect(cache.refreshSummary(sessionId)?.session.waitingForUserInput).toBe(true)

            appendFileSync(file, transcriptRecord({
                type: 'response_item',
                turn_id: 'turn-a',
                payload: { type: 'function_call_output', call_id: 'call-a', output: 'PRIVATE' }
            }), 'utf8')
            expect(cache.refreshSummary(sessionId)?.session.waitingForUserInput).toBe(false)
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

    it('retains the active native plan outside a short message page and clears it on task_failed', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-transcript-plan-'))
        const sessionId = 'c2234567-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const file = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, [
            transcriptRecord({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            transcriptRecord({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-plan' } }),
            transcriptRecord({
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'update_plan',
                    call_id: 'plan-call',
                    arguments: JSON.stringify({
                        plan: [
                            { step: 'Inspect current behavior', status: 'completed' },
                            { step: 'Render native plan', status: 'in_progress' }
                        ]
                    })
                }
            }),
            transcriptRecord({
                type: 'response_item',
                payload: {
                    type: 'function_call_output',
                    call_id: 'plan-call',
                    output: 'Plan updated'
                }
            }),
            transcriptRecord({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Plan is now being implemented.' }]
                }
            })
        ].join(''), 'utf8')
        process.env.CODEX_HOME = codexHome
        const cache = new NativeCodexTranscriptCache()

        try {
            const first = cache.read(sessionId, { limit: 1 })
            expect(first?.data.importedMessages).toHaveLength(1)
            expect(first?.plan).toEqual({
                turnId: 'turn-plan',
                callId: 'plan-call',
                steps: [
                    { text: 'Inspect current behavior', status: 'completed' },
                    { text: 'Render native plan', status: 'in_progress' }
                ]
            })

            appendFileSync(file, transcriptRecord({
                type: 'event_msg',
                payload: { type: 'task_failed', turn_id: 'turn-plan' }
            }), 'utf8')
            expect(cache.refreshCached(sessionId, { limit: 1 })?.plan).toBeNull()
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})
