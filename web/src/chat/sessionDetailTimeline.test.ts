import { describe, expect, it } from 'vitest'
import type { AgentReasoningBlock, AgentTextBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
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

function reasoningBlock(id: string, createdAt: number, text: string): AgentReasoningBlock {
    return {
        kind: 'agent-reasoning',
        id,
        localId: null,
        createdAt,
        text
    }
}

describe('buildSessionDetailTimeline', () => {
    it('preserves earlier reasoning across an answered-question boundary while the next step runs', () => {
        const question = toolBlock()
        question.id = 'question'
        question.tool = {
            ...question.tool,
            id: 'question',
            name: 'request_user_input',
            input: { questions: [{ id: 'direction', question: 'Continue?', options: [{ label: 'Yes' }] }] },
            permission: { id: 'question', status: 'approved', answers: { direction: { answers: ['Yes'] } } }
        }
        const { visible } = buildSessionDetailTimeline([
            userBlock(), reasoningBlock('earlier-reasoning', 2, 'Inspecting'), toolBlock(), question,
            reasoningBlock('current-reasoning', 4, 'Verifying'), { ...toolBlock(), id: 'tool-2' }
        ], { hasMoreMessages: false, runActive: true, aggregateActiveProcess: true })

        expect(visible.map((block) => block.kind)).toEqual(['user-text', 'tool-group', 'question-answer', 'tool-group'])
        expect(visible.flatMap((block) => block.kind === 'tool-group' ? block.detailBlocks ?? [] : [])
            .filter((block) => block.kind === 'agent-reasoning').map((block) => block.id))
            .toEqual(['earlier-reasoning', 'current-reasoning'])
    })

    it.each([false, true])('folds historical reasoning when active=%s and the page ends in a tool', (runActive) => {
        const blocks = [
            userBlock(), toolBlock(), reasoningBlock('reasoning-history', 3, 'Checking'),
            agentBlock(), { ...toolBlock(), id: 'tool-history-end' },
            { ...userBlock(), id: 'next-user', createdAt: 5 },
            { ...toolBlock(), id: 'tool-current', createdAt: 6 },
            reasoningBlock('reasoning-current', 7, 'Verifying')
        ]
        const { visible } = buildSessionDetailTimeline(blocks, {
            hasMoreMessages: true, runActive, aggregateActiveProcess: true
        })
        expect(visible.some((block) => block.kind === 'agent-reasoning')).toBe(false)
        expect(visible.some((block) => block.id === 'agent-1')).toBe(true)
        const details = visible.flatMap((block) => block.kind === 'tool-group' ? block.detailBlocks ?? [] : [])
        expect(details.filter((block) => block.kind === 'agent-reasoning').map((block) => block.id)).toEqual([
            'reasoning-history', 'reasoning-current'
        ])
    })

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

    it('folds the latest reasoning trace into the nearest tool group while the current turn is running', () => {
        const timeline = buildSessionDetailTimeline([
            userBlock(),
            reasoningBlock('reasoning-1', 2, 'Inspecting'),
            toolBlock(),
            reasoningBlock('reasoning-2', 4, 'Verifying')
        ], { hasMoreMessages: false, runActive: true })

        expect(timeline.visible.map((block) => block.id)).toEqual([
            'user-1',
            'tool-group:tool-1'
        ])
        expect(timeline.visible[1]).toMatchObject({
            kind: 'tool-group',
            detailBlocks: [
                { id: 'tool-1' },
                { id: 'reasoning-2' }
            ]
        })
    })

    it('aggregates an active native turn into one process row', () => {
        const secondTool: ToolCallBlock = {
            ...toolBlock(),
            id: 'tool-2',
            createdAt: 5,
            tool: {
                ...toolBlock().tool,
                id: 'tool-2',
                createdAt: 5,
                startedAt: 5,
                completedAt: 6
            }
        }
        const timeline = buildSessionDetailTimeline([
            userBlock(),
            toolBlock(),
            reasoningBlock('reasoning-1', 3, 'Inspecting'),
            { ...agentBlock(), id: 'process-1', text: 'Checking the first result' },
            secondTool,
            reasoningBlock('reasoning-2', 7, 'Verifying')
        ], {
            hasMoreMessages: false,
            runActive: true,
            aggregateActiveProcess: true
        })

        expect(timeline.visible.map((block) => block.id)).toEqual([
            'user-1',
            'tool-group:active-process:tool-1'
        ])
        expect(timeline.visible[1]).toMatchObject({
            kind: 'tool-group',
            turnActive: true,
            tools: [{ id: 'tool-1' }, { id: 'tool-2' }],
            detailBlocks: [
                { id: 'tool-1' },
                { id: 'process-1' },
                { id: 'tool-2' },
                { id: 'reasoning-2' }
            ]
        })
    })

    it('keeps a reasoning-only active turn visible', () => {
        const timeline = buildSessionDetailTimeline([
            userBlock(),
            reasoningBlock('reasoning-1', 2, 'Inspecting')
        ], { hasMoreMessages: false, runActive: true })

        expect(timeline.visible.map((block) => block.id)).toEqual([
            'user-1',
            'reasoning-1'
        ])
    })

    it('folds completed reasoning-only details before the final answer', () => {
        const timeline = buildSessionDetailTimeline([
            userBlock(),
            reasoningBlock('reasoning-1', 2, 'Inspecting'),
            reasoningBlock('reasoning-2', 3, 'Verifying'),
            agentBlock()
        ], { hasMoreMessages: false })

        expect(timeline.visible.map((block) => block.kind)).toEqual([
            'user-text',
            'tool-group',
            'agent-text'
        ])
        expect(timeline.visible[1]).toMatchObject({
            kind: 'tool-group',
            showAgentIcon: false,
            detailBlocks: [
                { id: 'reasoning-1' },
                { id: 'reasoning-2' }
            ]
        })
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
