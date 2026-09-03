import { describe, expect, it } from 'vitest'
import { foldTaskStatusEvents, parseMessageAsEvent } from './reducerEvents'
import type { AgentEvent, ChatBlock, NormalizedMessage } from './types'

function makeAgentTextMessage(text: string): NormalizedMessage {
    return {
        role: 'agent',
        content: [{ type: 'text', text, uuid: 'u1', parentUUID: null }],
        id: 'msg-1',
        localId: null,
        createdAt: Date.now(),
        isSidechain: false,
    }
}

function makeTaskStatusBlock(id: string, event: AgentEvent): ChatBlock {
    return {
        kind: 'agent-event',
        id,
        createdAt: Date.now(),
        event
    }
}

describe('parseMessageAsEvent — usage limit formats', () => {
    it('parses reached with limitType', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000|five_hour')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour',
        })
    })

    it('parses reached without limitType (backward compat)', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: '',
        })
    })

    it('parses warning with five_hour type', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774278000|90|five_hour')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour',
        })
    })

    it('parses warning with seven_day type', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774850400|85|seven_day')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 0.85,
            endsAt: 1774850400,
            limitType: 'seven_day',
        })
    })

    it('parses Codex usage updates into a compact event', () => {
        const text = 'Codex usage updated · GPT-5.3-Codex-Spark: primary 0% / 300 min, secondary 0% / 10080 min'

        expect(parseMessageAsEvent(makeAgentTextMessage(text))).toEqual({
            type: 'codex-usage-updated',
            message: text,
        })
    })

    it('handles missing limitType', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit warning|1774278000|100|')
        expect(parseMessageAsEvent(msg)).toEqual({
            type: 'limit-warning',
            utilization: 1,
            endsAt: 1774278000,
            limitType: '',
        })
    })

    it('returns null for non-limit text', () => {
        const msg = makeAgentTextMessage('Hello world')
        expect(parseMessageAsEvent(msg)).toBeNull()
    })

    it('returns null for sidechain messages', () => {
        const msg = makeAgentTextMessage('Claude AI usage limit reached|1774278000')
        msg.isSidechain = true
        expect(parseMessageAsEvent(msg)).toBeNull()
    })
})

describe('foldTaskStatusEvents', () => {
    it('keeps only the newest consecutive task status', () => {
        const retrying = makeTaskStatusBlock('retrying', {
            type: 'task-status',
            status: 'retrying',
            source: 'codex',
            code: 'system_error',
            message: 'Codex thread entered systemError',
            retryAttempt: 1,
            maxRetries: 3,
            recoverable: true
        })
        const failed = makeTaskStatusBlock('failed', {
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'usage_limit',
            message: "You've hit your usage limit.",
            recoverable: false
        })

        expect(foldTaskStatusEvents([retrying, failed])).toEqual([failed])
    })

    it('keeps a specific failure instead of a trailing generic failure', () => {
        const usageLimit = makeTaskStatusBlock('usage-limit', {
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'usage_limit',
            message: "You've hit your usage limit.",
            recoverable: false,
            actionUrl: 'https://chatgpt.com/codex/settings/usage',
            resetAtText: 'Sep 7th, 2026 10:26 AM'
        })
        const genericFailure = makeTaskStatusBlock('generic-failure', {
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'unknown',
            message: 'Task failed',
            recoverable: false
        })

        expect(foldTaskStatusEvents([usageLimit, genericFailure])).toEqual([usageLimit])
    })

    it('does not fold task statuses across normal messages', () => {
        const retrying = makeTaskStatusBlock('retrying', {
            type: 'task-status',
            status: 'retrying',
            source: 'codex',
            code: 'system_error',
            message: 'Codex thread entered systemError',
            retryAttempt: 1,
            maxRetries: 3,
            recoverable: true
        })
        const user: ChatBlock = {
            kind: 'user-text',
            id: 'user',
            localId: null,
            createdAt: Date.now(),
            text: 'next'
        }
        const failed = makeTaskStatusBlock('failed', {
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'usage_limit',
            message: "You've hit your usage limit.",
            recoverable: false
        })

        expect(foldTaskStatusEvents([retrying, user, failed])).toEqual([retrying, user, failed])
    })
})
