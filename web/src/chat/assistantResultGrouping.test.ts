import { describe, expect, it } from 'vitest'
import type { AgentTextBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
import { groupAssistantResultDetails } from '@/chat/assistantResultGrouping'
import { isToolGroupBlock, type VisibleChatBlock } from '@/chat/toolGroups'

function userText(id: string): UserTextBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt: 1,
        text: 'user'
    }
}

function agentText(id: string, text: string): AgentTextBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text
    }
}

function toolCall(id: string, name = 'Bash'): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
    }
}

describe('groupAssistantResultDetails', () => {
    it('moves assistant process blocks into a top detail group when the last assistant block is text', () => {
        const tool = toolCall('tool-1')
        const processText = agentText('text-1', '我先说明过程')
        const resultText = agentText('text-2', '最终结果')
        const blocks: VisibleChatBlock[] = [tool, processText, resultText]

        const visible = groupAssistantResultDetails(blocks)

        expect(visible).toHaveLength(2)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(resultText)

        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected result detail group')
        }
        expect(visible[0].tools).toEqual([tool])
        expect(visible[0].detailBlocks).toEqual([tool, processText])
        expect(visible[0].showAgentIcon).toBe(true)
        expect(visible[0].forceGenericCompactTitle).toBe(true)
    })

    it('does not group process blocks while the current run is active', () => {
        const tool = toolCall('tool-1')
        const processText = agentText('text-1', '我先说明过程')
        const resultText = agentText('text-2', '阶段输出')
        const blocks: VisibleChatBlock[] = [tool, processText, resultText]

        const visible = groupAssistantResultDetails(blocks, { runActive: true })

        expect(visible).toBe(blocks)
    })

    it('preserves the original detail order inside the result detail group', () => {
        const firstText = agentText('text-1', '先说明')
        const firstTool = toolCall('tool-1')
        const secondText = agentText('text-2', '再说明')
        const secondTool = toolCall('tool-2')
        const resultText = agentText('text-3', '最终结果')
        const blocks: VisibleChatBlock[] = [firstText, firstTool, secondText, secondTool, resultText]

        const visible = groupAssistantResultDetails(blocks)

        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected result detail group')
        }
        expect(visible[0].detailBlocks?.map((block) => block.id)).toEqual([
            'text-1',
            'tool-1',
            'text-2',
            'tool-2'
        ])
    })

    it('leaves assistant groups without a final text result unchanged', () => {
        const blocks: VisibleChatBlock[] = [
            agentText('text-1', '过程'),
            toolCall('tool-1')
        ]

        const visible = groupAssistantResultDetails(blocks)
        expect(visible).toEqual(blocks)
        expect(visible[0]).toBe(blocks[0])
        expect(visible[1]).toBe(blocks[1])
    })

    it('leaves single text-only assistant groups unchanged', () => {
        const text = agentText('text-1', '最终结果')

        const visible = groupAssistantResultDetails([text])

        expect(visible).toEqual([text])
        expect(visible[0]).toBe(text)
    })

    it('leaves multi-block text-only assistant groups unchanged', () => {
        const processText = agentText('text-1', '先解释背景')
        const resultText = agentText('text-2', '最终结论')

        const visible = groupAssistantResultDetails([processText, resultText])

        expect(visible).toEqual([processText, resultText])
        expect(visible[0]).toBe(processText)
        expect(visible[1]).toBe(resultText)
    })

    it('splits assistant groups on user boundaries', () => {
        const firstResult = agentText('text-1', '第一轮结果')
        const tool = toolCall('tool-1')
        const secondResult = agentText('text-2', '第二轮结果')
        const blocks: VisibleChatBlock[] = [
            firstResult,
            userText('user-1'),
            tool,
            secondResult
        ]

        const visible = groupAssistantResultDetails(blocks)

        expect(visible).toHaveLength(4)
        expect(visible[0]).toBe(firstResult)
        expect(visible[1].kind).toBe('user-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)
        expect(visible[3]).toBe(secondResult)
    })
})
