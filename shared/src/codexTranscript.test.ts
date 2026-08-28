import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    getLocalCodexSessionData,
    getLocalCodexSessionRunState,
    listLocalCodexSessions,
    normalizeCodexCustomToolOutput
} from './codexTranscript'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
    if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
    } else {
        process.env.CODEX_HOME = originalCodexHome
    }
})

describe('getLocalCodexSessionData', () => {
    it('keeps heartbeat timestamps from the trigger for its final status response', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-heartbeat-test-'))
        const sessionId = '99999999-9999-4999-8999-999999999999'
        const heartbeatTime = '2026-08-15T00:54:47.781Z'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '15')
        mkdirSync(sessionDir, { recursive: true })
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, `${[
            { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
            {
                // Codex's line timestamp can be written much later than the
                // automation trigger, so the embedded heartbeat time wins.
                timestamp: '2026-08-15T03:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: `<heartbeat><automation_id>bug</automation_id><current_time_iso>${heartbeatTime}</current_time_iso><instructions>自动改bug</instructions></heartbeat>` }]
                }
            },
            {
                timestamp: '2026-08-15T03:00:05.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '<heartbeat><automation_id>bug</automation_id><decision>DONT_NOTIFY</decision><message>No new bugs.</message></heartbeat>' }]
                }
            }
        ].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const data = getLocalCodexSessionData(sessionId, { limit: 50 })
            expect(data?.importedMessages.map((message) => message.createdAt)).toEqual([
                Date.parse(heartbeatTime),
                Date.parse(heartbeatTime)
            ])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('normalizes native custom exec records into timed terminal messages', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-custom-tool-test-'))
        const sessionId = '66666666-6666-4666-8666-666666666666'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '26')
        mkdirSync(sessionDir, { recursive: true })
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, `${[
            { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
            {
                timestamp: '2026-08-26T09:59:59.000Z',
                type: 'turn_context',
                payload: { model: 'gpt-5.6-terra', effort: 'high' }
            },
            {
                timestamp: '2026-08-26T10:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'inspect the project' }]
                }
            },
            {
                timestamp: '2026-08-26T10:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call',
                    id: 'ctc-terminal',
                    call_id: 'call-terminal',
                    name: 'exec',
                    status: 'completed',
                    input: 'printf hello'
                }
            },
            {
                timestamp: '2026-08-26T10:00:02.250Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call_output',
                    id: 'ctco-terminal',
                    call_id: 'call-terminal',
                    output: [{
                        type: 'input_text',
                        text: 'Script completed\nWall time: 1.25 seconds\nOutput:\nhello'
                    }]
                }
            }
        ].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const data = getLocalCodexSessionData(sessionId, { limit: 20 })
            expect(data?.session).toMatchObject({
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high'
            })
            expect(data?.importedMessages).toHaveLength(3)
            expect(data?.importedMessages[1]).toMatchObject({
                role: 'agent',
                createdAt: Date.parse('2026-08-26T10:00:01.000Z'),
                content: {
                    data: {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: 'call-terminal',
                        input: { command: 'printf hello' },
                        startedAt: Date.parse('2026-08-26T10:00:01.000Z')
                    }
                }
            })
            expect(data?.importedMessages[2]).toMatchObject({
                role: 'agent',
                createdAt: Date.parse('2026-08-26T10:00:02.250Z'),
                content: {
                    data: {
                        type: 'tool-call-result',
                        callId: 'call-terminal',
                        output: 'Script completed\nWall time: 1.25 seconds\nOutput:\nhello',
                        completedAt: Date.parse('2026-08-26T10:00:02.250Z'),
                        durationMs: 1_250
                    }
                }
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('lifts desktop exec result envelopes into terminal output metadata', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-custom-envelope-test-'))
        const sessionId = '88888888-8888-4888-8888-888888888888'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '26')
        mkdirSync(sessionDir, { recursive: true })
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, `${[
            { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
            {
                timestamp: '2026-08-26T10:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call',
                    call_id: 'call-envelope',
                    name: 'exec',
                    input: 'printf hello',
                    status: 'completed'
                }
            },
            {
                timestamp: '2026-08-26T10:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call_output',
                    call_id: 'call-envelope',
                    output: [{
                        type: 'input_text',
                        text: JSON.stringify({
                            output: 'hello',
                            metadata: { exit_code: 0, duration_seconds: 0.125 }
                        })
                    }]
                }
            }
        ].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const data = getLocalCodexSessionData(sessionId, { limit: 20 })
            const toolResult = data?.importedMessages.find((message) => (
                message.role === 'agent'
                && typeof message.content.data === 'object'
                && message.content.data !== null
                && (message.content.data as { type?: unknown }).type === 'tool-call-result'
            ))
            expect(toolResult).toMatchObject({
                content: {
                    data: {
                        type: 'tool-call-result',
                        output: {
                            stdout: 'hello',
                            exit_code: 0,
                            durationMs: 125,
                            is_error: false
                        }
                    }
                }
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})

describe('listLocalCodexSessions', () => {
    it('can exclude HAPI-initiated threads before applying the limit', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-list-test-'))
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '15')
        const hapiSessionId = '11111111-1111-4111-8111-111111111111'
        const externalSessionId = '22222222-2222-4222-8222-222222222222'
        mkdirSync(sessionDir, { recursive: true })

        const writeTranscript = (sessionId: string, originator: string) => {
            const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
            writeFileSync(file, `${JSON.stringify({
                type: 'session_meta',
                payload: { id: sessionId, cwd: '/workspace/project', originator }
            })}\n`, 'utf-8')
            return file
        }

        const externalFile = writeTranscript(externalSessionId, 'codex-tui')
        const hapiFile = writeTranscript(hapiSessionId, 'hapi-codex-client')
        utimesSync(externalFile, new Date('2026-08-15T00:00:00.000Z'), new Date('2026-08-15T00:00:00.000Z'))
        utimesSync(hapiFile, new Date('2026-08-15T00:01:00.000Z'), new Date('2026-08-15T00:01:00.000Z'))
        process.env.CODEX_HOME = codexHome

        try {
            expect(listLocalCodexSessions(1).map((session) => session.id)).toEqual([hapiSessionId])
            expect(listLocalCodexSessions(1, { excludeHapiInitiated: true }).map((session) => session.id)).toEqual([externalSessionId])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})

describe('normalizeCodexCustomToolOutput', () => {
    it('does not reinterpret ordinary JSON command output as a result envelope', () => {
        const output = normalizeCodexCustomToolOutput([
            { type: 'input_text', text: '{"output":"payload"}' }
        ])

        expect(output).toBe('{"output":"payload"}')
    })
})

describe('getLocalCodexSessionRunState', () => {
    it('uses explicit task lifecycle records instead of transcript mtime', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-run-state-test-'))
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '26')
        const idleSessionId = '33333333-3333-4333-8333-333333333333'
        const activeSessionId = '44444444-4444-4444-8444-444444444444'
        const legacySessionId = '55555555-5555-4555-8555-555555555555'
        mkdirSync(sessionDir, { recursive: true })
        const writeTranscript = (sessionId: string, events: string[]) => {
            writeFileSync(join(sessionDir, `rollout-${sessionId}.jsonl`), [
                JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
                ...events.map((eventType) => JSON.stringify({ type: 'event_msg', payload: { type: eventType } }))
            ].join('\n'))
        }
        writeTranscript(idleSessionId, ['task_started', 'task_complete'])
        writeTranscript(activeSessionId, ['task_started', 'task_complete', 'task_started'])
        writeTranscript(legacySessionId, [])
        process.env.CODEX_HOME = codexHome

        try {
            expect(getLocalCodexSessionRunState(idleSessionId)).toBe('idle')
            expect(getLocalCodexSessionRunState(activeSessionId)).toBe('processing')
            expect(getLocalCodexSessionRunState(legacySessionId)).toBe('unknown')
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})
