import { describe, expect, it } from 'vitest'
import type { AgentTextBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
import {
    buildIncrementalSessionDetailTimeline,
    buildSessionDetailTimeline
} from './sessionDetailTimeline'

function userBlock(): UserTextBlock {
    return {
        kind: 'user-text',
        id: 'user-1',
        localId: null,
        createdAt: 1,
        text: 'Please inspect this'
    }
}

function toolBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 2,
        invokedAt: 2,
        tool: {
            id: 'tool-1',
            name: 'Read',
            state: 'completed',
            input: { file_path: 'src/App.tsx' },
            createdAt: 2,
            startedAt: 2,
            completedAt: 3,
            description: null,
            result: 'content'
        },
        children: []
    }
}

function agentBlock(): AgentTextBlock {
    return {
        kind: 'agent-text',
        id: 'agent-1',
        localId: null,
        createdAt: 4,
        text: 'Done'
    }
}

describe('buildSessionDetailTimeline', () => {
    it('uses the same compact result grouping policy for either detail source', () => {
        const blocks = [userBlock(), toolBlock(), agentBlock()]
        const hapi = buildSessionDetailTimeline(blocks, { hasMoreMessages: false })
        const native = buildSessionDetailTimeline(blocks, { hasMoreMessages: false })

        expect(native).toEqual(hapi)
        expect(native.visible).toHaveLength(3)
        expect(native.visible[0]?.kind).toBe('user-text')
        expect(native.visible[1]?.kind).toBe('tool-group')
        expect(native.visible[2]?.kind).toBe('agent-text')
    })

    it('keeps the current turn expanded while it is running', () => {
        const processBlock: AgentTextBlock = {
            ...agentBlock(),
            id: 'agent-process',
            text: 'Working'
        }
        const timeline = buildSessionDetailTimeline(
            [userBlock(), toolBlock(), processBlock, agentBlock()],
            { hasMoreMessages: false, runActive: true }
        )

        expect(timeline.visible.map((block) => block.kind)).toEqual([
            'user-text',
            'tool-group',
            'agent-text',
            'agent-text'
        ])
    })

    it('only rebuilds the stream tail after the latest user-message boundary', () => {
        const firstUser = userBlock()
        const firstTool = toolBlock()
        const firstAgent = agentBlock()
        const secondUser: UserTextBlock = {
            ...userBlock(),
            id: 'user-2',
            createdAt: 5,
            text: 'Continue'
        }
        const secondTool: ToolCallBlock = {
            ...toolBlock(),
            id: 'tool-2',
            createdAt: 6,
            invokedAt: 6,
            tool: {
                ...toolBlock().tool,
                id: 'tool-2',
                createdAt: 6,
                startedAt: 6,
                completedAt: null
            }
        }
        const streamingAgent: AgentTextBlock = {
            ...agentBlock(),
            id: 'agent-2',
            createdAt: 7,
            text: 'Working'
        }
        const initialBlocks = [firstUser, firstTool, firstAgent, secondUser, secondTool, streamingAgent]
        const options = { hasMoreMessages: false }
        const initial = buildIncrementalSessionDetailTimeline(initialBlocks, options, null)

        const updatedBlocks = [
            firstUser,
            firstTool,
            firstAgent,
            secondUser,
            secondTool,
            { ...streamingAgent, text: 'Working on the next step' }
        ]
        const incremental = buildIncrementalSessionDetailTimeline(updatedBlocks, options, initial.cache)
        const full = buildSessionDetailTimeline(updatedBlocks, options)

        expect(incremental.reusedPrefix).toBe(true)
        expect(incremental.timeline).toEqual(full)
        // Completed history keeps its original object identity, so React can
        // skip those message subtrees too.
        expect(incremental.timeline.visible[0]).toBe(initial.timeline.visible[0])
    })

    it('falls back to a complete derivation when run state changes grouping policy', () => {
        const blocks = [userBlock(), toolBlock(), agentBlock()]
        const initial = buildIncrementalSessionDetailTimeline(blocks, { hasMoreMessages: false }, null)
        const next = buildIncrementalSessionDetailTimeline(
            blocks,
            { hasMoreMessages: false, runActive: true },
            initial.cache
        )

        expect(next.reusedPrefix).toBe(false)
        expect(next.timeline).toEqual(buildSessionDetailTimeline(blocks, { hasMoreMessages: false, runActive: true }))
    })
})
