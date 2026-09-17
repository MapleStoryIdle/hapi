import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import type { DecryptedMessage } from '@/types/api'

function makeMessage(content: unknown): DecryptedMessage {
    return {
        id: 'msg-1',
        seq: 1,
        localId: null,
        content,
        createdAt: 1_742_372_800_000
    }
}

describe('normalizeDecryptedMessage', () => {
    it('normalizes native HTTP 403 status records as timeline events', () => {
        const event = {
            type: 'task-status', status: 'failed', source: 'codex',
            code: 'http_forbidden', message: 'HTTP 403 Forbidden', recoverable: false
        }
        expect(normalizeDecryptedMessage(makeMessage({
            role: 'agent', content: { type: 'codex', data: event }
        }))).toMatchObject({ role: 'event', content: event })
    })
    it('normalizes automation heartbeats into formatted status events', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: '<heartbeat> <automation_id>bug</automation_id> <decision>DONT_NOTIFY</decision> <message>Nothing to report.</message> </heartbeat>'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'event',
            content: {
                type: 'automation-heartbeat',
                automationId: 'bug',
                decision: 'DONT_NOTIFY',
                message: 'Nothing to report.'
            }
        })
    })

    it('normalizes instruction-only automation heartbeats into formatted status events', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'user',
            content: {
                type: 'text',
                text: `<heartbeat>\n  <automation_id>bug</automation_id>\n  <current_time_iso>2026-08-15T00:54:47.781Z</current_time_iso>\n  <instructions>自动改bug</instructions>\n</heartbeat>`
            }
        }))

        expect(normalized).toMatchObject({
            role: 'event',
            content: {
                type: 'automation-heartbeat',
                automationId: 'bug',
                message: '自动改bug',
                currentTimeIso: '2026-08-15T00:54:47.781Z'
            }
        })
    })

    it('drops malformed automation heartbeat control messages', () => {
        expect(normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: '<heartbeat>truncated'
                }
            }
        }))).toBeNull()
    })

    it('drops unsupported Claude system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'stop_hook_summary',
                    uuid: 'sys-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('drops Claude init system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'init',
                    uuid: 'sys-init',
                    session_id: 'session-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('keeps known Claude system subtypes as normalized events', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    uuid: 'sys-2',
                    durationMs: 1200
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'turn-duration',
                durationMs: 1200
            }
        })
    })

    it('keeps the stringify fallback for unknown non-system agent payloads', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    foo: 'bar'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: false
        })

        expect(normalized?.role).toBe('agent')
        if (!normalized || normalized.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        const firstBlock = normalized.content[0]
        expect(firstBlock).toMatchObject({
            type: 'text',
        })
        if (firstBlock.type !== 'text') {
            throw new Error('Expected fallback text block')
        }
        expect(firstBlock.text).toContain('"foo": "bar"')
    })

    it('normalizes <task-notification> user output as sidechain (event extracted by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u-notif',
                    message: { content: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        // Normalizer emits as sidechain (preserving uuid for sentinel detection);
        // the reducer extracts the summary as an event.
        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'sidechain',
                prompt: expect.stringContaining('<task-notification>')
            })
        }
    })

    it('treats <task-notification> without summary as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    message: { content: '<task-notification> <status>killed</status> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('keeps Codex/OpenCode reasoning stream ids for snapshot merging', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'reasoning',
                    id: 'reasoning-stream-1',
                    message: 'thinking'
                }
            }
        }))

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'reasoning',
                text: 'thinking',
                streamId: 'reasoning-stream-1'
            }]
        })
    })

    it('normalizes agent error payloads as error events', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'error',
                    message: 'Cursor Agent failed: authentication required'
                }
            }
        }))

        expect(normalized).toMatchObject({
            role: 'event',
            content: {
                type: 'error',
                message: 'Cursor Agent failed: authentication required'
            }
        })
    })

    it('treats non-sidechain string user output as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    uuid: 'u1',
                    message: { content: 'This is a subagent prompt' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is a subagent prompt'
        })
    })

    it('treats <system-reminder> user output as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u2',
                    message: { content: '<system-reminder>Some internal reminder</system-reminder>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('treats sidechain user output with array content as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'This is an agent prompt in array form' }] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is an agent prompt in array form'
        })
    })

    it('keeps "No response requested." text in normalized output (filtered later by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-1',
                    message: { role: 'assistant', content: 'No response requested.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        // Normalizer preserves the text (uuid/parentUUID needed by tracer);
        // the reducer is responsible for suppressing it during rendering.
        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('agent')
        if (normalized?.role === 'agent') {
            expect(normalized.content).toHaveLength(1)
            expect(normalized.content[0]).toMatchObject({ type: 'text', text: 'No response requested.' })
        }
    })

    it('keeps assistant messages with real content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-2',
                    message: { role: 'assistant', content: 'Here is the answer.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('agent')
    })

    it('propagates parentUuid from assistant output data to text block parentUUID', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-3',
                    parentUuid: 'parent-injected-uuid',
                    message: { role: 'assistant', content: 'No response requested.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toHaveLength(1)
        expect(normalized.content[0]).toMatchObject({
            type: 'text',
            text: 'No response requested.',
            parentUUID: 'parent-injected-uuid'
        })
    })

    it('sets parentUUID to null when parentUuid is absent in assistant output', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-4',
                    // No parentUuid field
                    message: { role: 'assistant', content: 'Hello.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'text',
            parentUUID: null
        })
    })

    it('normalizes non-sidechain text-only array-content user output as user message', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u5',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: 'Regular user message' }] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: 'Regular user message' }
        })
    })

    it('treats sidechain user output with mixed tool_result + text array as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u6',
                    isSidechain: true,
                    message: { content: [
                        { type: 'tool_result', tool_use_id: 'tc-1', content: 'result' },
                        { type: 'text', text: 'Some subagent text' }
                    ] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'Some subagent text'
        })
    })

    it('preserves Codex tool-call-result errors for timeline state', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'call-1',
                    output: 'tool failed',
                    is_error: true,
                    id: 'result-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-result',
                    tool_use_id: 'call-1',
                    content: 'tool failed',
                    is_error: true
                }
            ]
        })
    })

    it('preserves CLI tool timing fields for Terminal and MCP cards', () => {
        const toolCall = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    callId: 'mcp-call-1',
                    name: 'mcp__node_repl__js',
                    input: { code: 'browser.status()' },
                    startedAt: 1_742_372_800_100,
                    id: 'call-1'
                }
            }
        }))
        const toolResult = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'mcp-call-1',
                    output: { ok: true },
                    completedAt: 1_742_372_803_600,
                    durationMs: 3_500,
                    id: 'result-1'
                }
            }
        }))

        expect(toolCall).toMatchObject({
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'mcp-call-1',
                startedAt: 1_742_372_800_100
            }]
        })
        expect(toolResult).toMatchObject({
            role: 'agent',
            content: [{
                type: 'tool-result',
                tool_use_id: 'mcp-call-1',
                completedAt: 1_742_372_803_600,
                durationMs: 3_500
            }]
        })
    })

    it('normalizes Codex review JSON messages as structured review content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: JSON.stringify({
                        findings: [{
                            title: '[P2] Remove retained sessions when sockets disconnect',
                            body: 'Retained sockets survive disconnects.',
                            confidence_score: 0.82,
                            priority: 2,
                            code_location: {
                                absolute_file_path: '/data/dz/wapair-ts/src/pairing/manager.ts',
                                line_range: { start: 1614, end: 1619 }
                            }
                        }],
                        overall_correctness: 'patch is incorrect',
                        overall_explanation: 'The message-sending feature retains long-lived sockets but does not fully manage their lifecycle.',
                        overall_confidence_score: 0.8
                    })
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'codex-review',
                review: {
                    overallCorrectness: 'patch is incorrect',
                    overallExplanation: 'The message-sending feature retains long-lived sockets but does not fully manage their lifecycle.',
                    overallConfidenceScore: 0.8,
                    findings: [{
                        title: '[P2] Remove retained sessions when sockets disconnect',
                        body: 'Retained sockets survive disconnects.',
                        priority: 2,
                        confidenceScore: 0.82,
                        filePath: '/data/dz/wapair-ts/src/pairing/manager.ts',
                        lineStart: 1614,
                        lineEnd: 1619
                    }]
                }
            }]
        })
    })

    it('normalizes Codex code-comment directives as structured review content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: `Review summary

::code-comment{title="[P1] 三方调用期间持有工作流锁" body="submit 本身是事务方法，建议避免在行锁范围内执行网络请求。" file="
JAVA
/workspace/homebar/CabinetInventoryRecordServiceImpl.java
" start=220 end=256 priority=1}`
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'agent',
            content: [{
                type: 'codex-review',
                review: {
                    overallCorrectness: null,
                    overallExplanation: 'Review summary',
                    overallConfidenceScore: null,
                    findings: [{
                        title: '[P1] 三方调用期间持有工作流锁',
                        body: 'submit 本身是事务方法，建议避免在行锁范围内执行网络请求。',
                        priority: 1,
                        confidenceScore: null,
                        filePath: '/workspace/homebar/CabinetInventoryRecordServiceImpl.java',
                        lineStart: 220,
                        lineEnd: 256
                    }]
                }
            }]
        })
    })

    it('collects multiple code comments and leaves malformed directives as text', () => {
        const structured = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: [
                        '::code-comment{title="First" body="One" file="/repo/a.ts" start=2 priority=2}',
                        '::code-comment{title="Second" body="Two" file="/repo/b.ts" start=4 priority=3}'
                    ].join('\n')
                }
            }
        })
        const malformedText = '::code-comment{title="Missing fields"}'
        const malformed = makeMessage({
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: malformedText } }
        })

        expect(normalizeDecryptedMessage(structured)).toMatchObject({
            content: [{
                type: 'codex-review',
                review: {
                    findings: [
                        { title: 'First', lineStart: 2, lineEnd: 2, priority: 2 },
                        { title: 'Second', lineStart: 4, lineEnd: 4, priority: 3 }
                    ]
                }
            }]
        })
        expect(normalizeDecryptedMessage(malformed)).toMatchObject({
            content: [{ type: 'text', text: malformedText }]
        })
    })

    it('keeps non-review Codex JSON messages as text', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: JSON.stringify({ status: 'ok', message: 'plain JSON' })
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: '{"status":"ok","message":"plain JSON"}'
            }]
        })
    })

    it('normalizes Codex message snapshots with a stable stream id', () => {
        // 验证正文快照进入普通文本流，并保留 streamId 供 timeline 合并同一个气泡。
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message-snapshot',
                    message: 'partial answer',
                    streamId: 'item-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: 'partial answer',
                streamId: 'item-1'
            }]
        })
    })

    it('marks completed Codex message streams as final', () => {
        // 验证 item/completed 产生的最终正文事件会带 final 标记，避免 Web 误判仍在流式更新。
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'complete answer',
                    streamId: 'item-1',
                    final: true
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: 'complete answer',
                streamId: 'item-1',
                final: true
            }]
        })
    })

    it('keeps malformed Codex review-looking messages as text', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: '{"findings": ['
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: '{"findings": ['
            }]
        })
    })

    it('normalizes ACP plan messages as completed update_plan snapshots', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan',
                    entries: [
                        { content: 'Inspect event stream', status: 'completed' },
                        { content: 'Render plan card', status: 'in_progress' }
                    ],
                    id: 'cursor-plan-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-call',
                    id: 'cursor-plan-state',
                    name: 'update_plan',
                    input: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'cursor'
                    }
                },
                {
                    type: 'tool-result',
                    tool_use_id: 'cursor-plan-state',
                    content: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'cursor'
                    }
                }
            ]
        })
    })

    it('normalizes Codex plan updates as completed update_plan snapshots', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan_update',
                    plan: [
                        { step: 'Inspect event stream', status: 'completed' },
                        { step: 'Render plan card', status: 'in_progress' }
                    ],
                    id: 'plan-update-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-call',
                    id: 'codex-plan-state',
                    name: 'update_plan',
                    input: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'codex'
                    }
                },
                {
                    type: 'tool-result',
                    tool_use_id: 'codex-plan-state',
                    content: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'codex',
                        status: 'updated'
                    }
                }
            ]
        })
    })

    it('normalizes Codex token_count as usage data for context display', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    info: {
                        total: {
                            inputTokens: 82_503,
                            cachedInputTokens: 71_808,
                            outputTokens: 166
                        },
                        modelContextWindow: 258_400
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'event',
            content: {
                type: 'token-count'
            },
            usage: {
                input_tokens: 82503,
                output_tokens: 166
            }
        })
    })

    it('normalizes Codex scoped snake_case usage fields', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    thread_id: 'child-thread',
                    scope: { role: 'child' },
                    info: {
                        last_token_usage: {
                            input_tokens: 321,
                            output_tokens: 12,
                            cached_input_tokens: 100
                        },
                        model_context_window: 258_400
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'event',
            usage: {
                input_tokens: 321,
                output_tokens: 12,
                cache_read_input_tokens: 100,
                context_tokens: 321,
                context_window: 258400,
                thread_id: 'child-thread',
                scope_role: 'child'
            }
        })
    })

    it('keeps turn usage attached to a native Codex final reply', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: 'Done',
                    final: true,
                    usage: {
                        input_tokens: 80,
                        output_tokens: 12,
                        cache_read_input_tokens: 40,
                        context_window: 258_400
                    }
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'agent',
            usage: {
                input_tokens: 80,
                output_tokens: 12,
                cache_read_input_tokens: 40,
                context_window: 258_400
            }
        })
    })

    it('normalizes token_count payloads with explicit contextTokens', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    info: {
                        total: {
                            inputTokens: 8_119,
                            outputTokens: 2,
                            cachedInputTokens: 5_760,
                            thoughtTokens: 11,
                            totalTokens: 13_892
                        },
                        contextTokens: 13_879,
                        modelContextWindow: 65_536
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'event',
            usage: {
                input_tokens: 8119,
                output_tokens: 2,
                cache_read_input_tokens: 5760,
                context_tokens: 13879,
                context_window: 65536
            }
        })
    })

    it('normalizes Codex context_compacted as a compact event', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'context_compacted',
                    trigger: 'auto',
                    pre_tokens: 1234
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'event',
            content: {
                type: 'compact',
                trigger: 'auto',
                preTokens: 1234
            }
        })
    })

    it('normalizes Codex agent-run events for timeline aggregation', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect files' },
                    status: 'starting'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'event',
            content: {
                type: 'agent-run-start',
                cardId: 'spawn-1',
                input: { message: 'inspect files' },
                status: 'starting'
            }
        })
    })


    it('normalizes supported Codex session events without payload details', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'agent', content: { type: 'codex', data: { type: 'codex-session-event', eventType: 'stream_error', secret: 'hidden' } }
        }))
        expect(normalized).toMatchObject({ role: 'event', content: { type: 'codex-session-event', eventType: 'stream_error' } })
        expect(JSON.stringify(normalized)).not.toContain('hidden')
    })

})
