import { describe, expect, it } from 'vitest'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import type { CodexSubagentState, DecryptedMessage } from '@/types/api'
import { getSortedCodexSubagents, getSubagentEvents, isCodexSubagentActive } from './SubagentDock'

function makeSubagent(overrides: Partial<CodexSubagentState> & { id: string }): CodexSubagentState {
    return {
        status: 'running',
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        ...overrides
    }
}

function makeAgentEventMessage(id: string, data: Record<string, unknown>): DecryptedMessage {
    return {
        id,
        seq: null,
        localId: null,
        createdAt: 1_700_000_002_000,
        content: {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data
            }
        }
    }
}

describe('SubagentDock helpers', () => {
    /**
     * The badge should only count non-terminal subagents, while the popover
     * orders active work before completed historical entries.
     */
    it('sorts active subagents before terminal subagents', () => {
        const completed = makeSubagent({ id: 'done', status: 'completed', updatedAt: 30 })
        const running = makeSubagent({ id: 'running', status: 'running', updatedAt: 10 })
        const waiting = makeSubagent({ id: 'waiting', status: 'waiting', updatedAt: 20 })

        expect(isCodexSubagentActive(completed)).toBe(false)
        expect(getSortedCodexSubagents({ done: completed, running, waiting }).map((item) => item.id)).toEqual([
            'waiting',
            'running',
            'done'
        ])
    })

    /**
     * The drawer is fed by the session message stream. It must filter by the
     * selected subagent id/card id so two concurrent child agents do not leak
     * their traces into each other's drawer.
     */
    it('filters loaded agent-run messages for the selected subagent', () => {
        const subagent = makeSubagent({ id: 'agent-1', cardId: 'card-1' })
        const events = getSubagentEvents([
            makeAgentEventMessage('m1', {
                type: 'agent-run-update',
                agentId: 'agent-1',
                cardId: 'card-1',
                status: 'running',
                activity: 'Reading files'
            }),
            makeAgentEventMessage('m2', {
                type: 'agent-run-trace',
                agentId: 'agent-2',
                cardId: 'card-2',
                message: 'wrong agent'
            }),
            makeAgentEventMessage('m3', {
                type: 'agent-run-trace',
                agentId: 'agent-1',
                cardId: 'card-1',
                message: { text: 'found the bug' }
            })
        ], subagent)

        expect(events.map((event) => event.text)).toEqual(['Reading files', 'found the bug'])
    })
})
