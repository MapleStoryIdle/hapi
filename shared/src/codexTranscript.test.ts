import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    appendCodexTranscriptImportLines,
    createCodexTranscriptImportAccumulator,
    getCodexSessionDisplayTitle,
    getCodexTranscriptLifecycleEvents,
    getCodexTranscriptTailSummary,
    getCodexTranscriptUserInputEvents,
    getCodexTranscriptUserInputState,
    getLocalCodexSessionData,
    getLocalCodexSessionRunState,
    listLocalCodexSessions,
    normalizeCodexCustomToolOutput,
    readLocalCodexSessionSummary
} from './codexTranscript'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
    if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
    } else {
        process.env.CODEX_HOME = originalCodexHome
    }
})

describe('getCodexSessionDisplayTitle', () => {
    it('uses the first meaningful prompt line instead of a standalone URL', () => {
        expect(getCodexSessionDisplayTitle([
            '[https://github.com/tiann/hapi](https://github.com/tiann/hapi)',
            '这里有什么新功能适合我当前改造后的版本'
        ].join('\n'))).toBe('这里有什么新功能适合我当前改造后的版本')
    })

    it('keeps a compact single-line title for ordinary multi-line prompts', () => {
        expect(getCodexSessionDisplayTitle('第一行任务\n第二行补充')).toBe('第一行任务')
    })
})

describe('getLocalCodexSessionData', () => {
    it('coalesces canonical reasoning summaries and suppresses same-turn mirrors', () => {
        const accumulator = createCodexTranscriptImportAccumulator()
        const line = (record: unknown) => JSON.stringify(record)

        appendCodexTranscriptImportLines(accumulator, [
            line({ type: 'event_msg', payload: { type: 'task_started' } }),
            line({
                timestamp: '2026-09-01T10:00:00.000Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning_delta', delta: 'partial text' }
            }),
            line({
                timestamp: '2026-09-01T10:00:01.000Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning', text: 'Inspect the source' }
            })
        ])

        expect(accumulator.messages).toHaveLength(1)

        appendCodexTranscriptImportLines(accumulator, [
            line({
                timestamp: '2026-09-01T10:00:01.001Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning', text: 'Plan the smallest fix' }
            }),
            line({
                timestamp: '2026-09-01T10:00:01.010Z',
                type: 'response_item',
                payload: {
                    type: 'reasoning',
                    id: 'reasoning-item-1',
                    encrypted_content: 'not-for-display',
                    summary: [
                        { type: 'summary_text', text: 'Inspect the source' },
                        { type: 'summary_text', text: 'Plan the smallest fix' }
                    ]
                }
            })
        ])

        expect(accumulator.messages).toHaveLength(1)
        expect(accumulator.messages[0]).toMatchObject({
            role: 'agent',
            content: {
                data: {
                    type: 'reasoning',
                    id: 'reasoning-item-1',
                    message: 'Inspect the source\n\nPlan the smallest fix'
                }
            }
        })

        appendCodexTranscriptImportLines(accumulator, [
            line({
                timestamp: '2026-09-01T10:00:02.000Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning', text: 'Inspect the source' }
            }),
            line({
                timestamp: '2026-09-01T10:00:02.001Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning', text: 'Plan the smallest fix' }
            }),
            line({
                timestamp: '2026-09-01T10:00:02.010Z',
                type: 'response_item',
                payload: {
                    type: 'reasoning',
                    id: 'reasoning-item-duplicate',
                    summary: [
                        { type: 'summary_text', text: 'Inspect the source' },
                        { type: 'summary_text', text: 'Plan the smallest fix' }
                    ]
                }
            }),
            line({ type: 'event_msg', payload: { type: 'task_complete' } }),
            line({ type: 'event_msg', payload: { type: 'task_started' } }),
            line({
                timestamp: '2026-09-01T10:01:00.000Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning', text: 'Inspect the source' }
            }),
            line({
                timestamp: '2026-09-01T10:01:00.001Z',
                type: 'event_msg',
                payload: { type: 'agent_reasoning', text: 'Plan the smallest fix' }
            }),
            line({
                timestamp: '2026-09-01T10:01:00.010Z',
                type: 'response_item',
                payload: {
                    type: 'reasoning',
                    id: 'reasoning-item-next-turn',
                    summary: [
                        { type: 'summary_text', text: 'Inspect the source' },
                        { type: 'summary_text', text: 'Plan the smallest fix' }
                    ]
                }
            })
        ])

        const reasoningMessages = accumulator.messages.filter((message) => (
            message.role === 'agent'
            && typeof message.content.data === 'object'
            && message.content.data !== null
            && (message.content.data as { type?: unknown }).type === 'reasoning'
        ))
        expect(reasoningMessages).toHaveLength(2)
        expect(reasoningMessages.map((message) => (
            message.role === 'agent'
                ? (message.content.data as { id?: unknown }).id
                : null
        ))).toEqual(['reasoning-item-1', 'reasoning-item-next-turn'])
    })

    it('uses normalized user text for titles, previews, context, and imports', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-user-normalization-test-'))
        const sessionId = '13131313-1313-4313-8313-131313131313'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '31')
        mkdirSync(sessionDir, { recursive: true })
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        const firstWrapper = [
            '# Files mentioned by the user:',
            '## brief.txt: /private/generated/brief.txt',
            '## My request:',
            'Summarize the attachment.'
        ].join('\n')
        const latestWrapper = [
            '<in-app-browser-context source="ambient-ui-state">',
            'private page metadata',
            '</in-app-browser-context>',
            '## My request for Codex:',
            'Fix the visible form.'
        ].join('\n')
        const records = [
            { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
            {
                timestamp: '2026-08-31T10:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: '<environment_context>internal</environment_context>' }]
                }
            },
            {
                timestamp: '2026-08-31T10:00:01.499Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstWrapper }] }
            },
            {
                timestamp: '2026-08-31T10:00:01.501Z',
                type: 'event_msg',
                payload: { type: 'user_message', message: firstWrapper }
            },
            {
                timestamp: '2026-08-31T10:00:02.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'The Files mentioned marker is generated context.' }]
                }
            },
            {
                timestamp: '2026-08-31T10:00:03.000Z',
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: latestWrapper }] }
            }
        ]
        writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const data = getLocalCodexSessionData(sessionId, { limit: 50 })
            expect(data?.session).toMatchObject({
                title: 'Summarize the attachment.',
                lastUserMessage: 'Fix the visible form.'
            })
            expect(data?.context).toEqual([
                { role: 'user', text: 'Summarize the attachment.' },
                { role: 'assistant', text: 'The Files mentioned marker is generated context.' },
                { role: 'user', text: 'Fix the visible form.' }
            ])
            expect(data?.importedMessages.filter((message) => message.role === 'user').map((message) => (
                message.role === 'user' ? message.content.text : ''
            ))).toEqual(['Summarize the attachment.', 'Fix the visible form.'])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

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

    it('imports native context compaction as its own transcript event', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-context-compact-test-'))
        const sessionId = '12121212-1212-4212-8212-121212121212'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '30')
        mkdirSync(sessionDir, { recursive: true })
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, `${[
            { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
            {
                timestamp: '2026-08-30T01:02:03.000Z',
                type: 'event_msg',
                payload: { type: 'context_compacted' }
            }
        ].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const data = getLocalCodexSessionData(sessionId, { limit: 20 })
            expect(data?.importedMessages).toHaveLength(1)
            expect(data?.importedMessages[0]).toMatchObject({
                role: 'agent',
                createdAt: Date.parse('2026-08-30T01:02:03.000Z'),
                content: { data: { type: 'context_compacted' } }
            })
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

    it('reads only the header and tail metadata for a large transcript summary', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-large-list-test-'))
        const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '29')
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        mkdirSync(sessionDir, { recursive: true })
        writeFileSync(file, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ type: 'response_item', payload: {
                type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first prompt' }]
            } }),
            JSON.stringify({ type: 'response_item', payload: {
                type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(600_000) }]
            } }),
            JSON.stringify({ type: 'event_msg', payload: {
                type: 'mcp_tool_call_end',
                invocation: { tool: 'change_title', arguments: { title: 'Tail title' } }
            } }),
            JSON.stringify({ type: 'response_item', payload: {
                type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest tail prompt' }]
            } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'), 'utf-8')

        try {
            const summary = readLocalCodexSessionSummary(file)
            expect(summary).toMatchObject({
                id: sessionId,
                cwd: '/workspace/project',
                title: 'Tail title',
                lastUserMessage: 'latest tail prompt',
                runState: 'idle'
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('reads past the injected context to recover a large transcript title', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-large-title-test-'))
        const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '30')
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        mkdirSync(sessionDir, { recursive: true })
        writeFileSync(file, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ type: 'response_item', payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `# AGENTS.md instructions\n${'x'.repeat(80_000)}` }]
            } }),
            JSON.stringify({ type: 'response_item', payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Use the real first prompt as this session title' }]
            } }),
            JSON.stringify({ type: 'response_item', payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'x'.repeat(600_000) }]
            } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'), 'utf-8')

        try {
            expect(readLocalCodexSessionSummary(file)).toMatchObject({
                id: sessionId,
                title: 'Use the real first prompt as this session title',
                cwd: '/workspace/project',
                runState: 'idle'
            })
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

describe('getCodexTranscriptTailSummary', () => {
    it('uses the extracted request for the latest user preview', () => {
        const wrapper = [
            '# Applications mentioned by the user:',
            'Application metadata: private-app-id',
            '## My request:',
            'Open the selected application.'
        ].join('\n')
        const summary = getCodexTranscriptTailSummary([
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: wrapper }]
                }
            })
        ])

        expect(summary.lastUserMessage).toBe('Open the selected application.')
    })
})

describe('getCodexTranscriptLifecycleEvents', () => {
    it('retains only turn-scoped task lifecycle routing metadata', () => {
        expect(getCodexTranscriptLifecycleEvents([
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a', prompt: 'TOP_SECRET' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turnId: 'turn-a' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'ignore' } })
        ])).toEqual([
            { type: 'task_started', turnId: 'turn-a' },
            { type: 'task_complete', turnId: 'turn-a' },
            { type: 'turn_aborted' }
        ])
    })
})

describe('native request_user_input lifecycle', () => {
    const request = JSON.stringify({
        type: 'response_item',
        turn_id: 'turn-a',
        payload: {
            type: 'function_call',
            name: 'request_user_input',
            call_id: 'call-a',
            arguments: '{"question":"PRIVATE"}'
        }
    })
    const unrelatedOutput = JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-other', output: 'PRIVATE' }
    })
    const answer = JSON.stringify({
        type: 'response_item',
        turn_id: 'turn-a',
        payload: { type: 'function_call_output', call_id: 'call-a', output: 'PRIVATE' }
    })

    it('retains only request routing metadata and matches the answer by call id', () => {
        expect(getCodexTranscriptUserInputEvents([request, unrelatedOutput, answer])).toEqual([
            { type: 'requested', requestId: 'call-a', turnId: 'turn-a' },
            { type: 'resolved', requestId: 'call-other' },
            { type: 'resolved', requestId: 'call-a', turnId: 'turn-a' }
        ])
        expect(getCodexTranscriptUserInputState([request, unrelatedOutput])).toEqual({
            seen: true,
            waiting: true
        })
        expect(getCodexTranscriptUserInputState([request, unrelatedOutput, answer])).toEqual({
            seen: true,
            waiting: false
        })

        const accumulator = createCodexTranscriptImportAccumulator()
        appendCodexTranscriptImportLines(accumulator, [request, answer])
        expect(accumulator.messages).toEqual([])
    })

    it('clears a pending request when its turn terminates', () => {
        expect(getCodexTranscriptUserInputState([
            request,
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } })
        ])).toEqual({ seen: true, waiting: false })
    })
})
