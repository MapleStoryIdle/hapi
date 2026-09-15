import { describe, expect, it } from 'vitest'
import type { AgentTextBlock, GeneratedImageBlock, ToolCallBlock, UserTextBlock } from '@/chat/types'
import { groupAssistantResultDetails } from '@/chat/assistantResultGrouping'
import { isToolGroupBlock, summarizeToolGroup, type ToolGroupBlock, type VisibleChatBlock } from '@/chat/toolGroups'

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

function generatedImage(id: string): GeneratedImageBlock {
    return {
        kind: 'generated-image',
        id,
        localId: null,
        createdAt: 1,
        imageId: 'image-1',
        fileName: 'generated.png',
        mimeType: 'image/png'
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
        expect(visible[0].forceCompact).toBe(true)
    })

    it('does not group process blocks while the current run is active', () => {
        const tool = toolCall('tool-1')
        const processText = agentText('text-1', '我先说明过程')
        const resultText = agentText('text-2', '阶段输出')
        const blocks: VisibleChatBlock[] = [tool, processText, resultText]

        const visible = groupAssistantResultDetails(blocks, { runActive: true })

        expect(visible).toBe(blocks)
    })

    it('keeps the latest completed tool group processing until the turn becomes idle', () => {
        const tool = toolCall('tool-current')
        const group: ToolGroupBlock = {
            kind: 'tool-group', id: 'tool-group:current', createdAt: 2, invokedAt: 2,
            firstToolId: tool.id, lastToolId: tool.id, tools: [tool], defaultOpen: false,
            historyState: 'complete', needsOlderHistory: false, summary: summarizeToolGroup([tool])
        }

        const visible = groupAssistantResultDetails([userText('user-current'), group], { runActive: true })

        expect(visible[1]).toMatchObject({ kind: 'tool-group', turnActive: true, defaultOpen: true })
    })

    it('keeps context compaction events outside active process groups', () => {
        const firstTool = toolCall('tool-1', 'Read')
        const secondTool = toolCall('tool-2', 'Bash')
        const processText = agentText('text-1', 'Checking the result')
        const compactingEvent: VisibleChatBlock = {
            kind: 'agent-event',
            id: 'compacting-1',
            createdAt: 3,
            event: {
                type: 'task-status',
                status: 'compacting',
                source: 'codex',
                code: 'context_window',
                message: 'Context is too large',
                recoverable: true
            }
        }
        const compactEvent: VisibleChatBlock = {
            kind: 'agent-event',
            id: 'compact-1',
            createdAt: 4,
            event: { type: 'compact', trigger: 'auto', preTokens: 0 }
        }
        const compactedEvent: VisibleChatBlock = {
            kind: 'agent-event',
            id: 'compacted-1',
            createdAt: 5,
            event: {
                type: 'task-status',
                status: 'compacted',
                source: 'codex',
                code: 'context_window',
                message: 'Context compacted; retrying',
                recoverable: true
            }
        }
        const blocks: VisibleChatBlock[] = [
            userText('user-current'),
            firstTool,
            {
                kind: 'agent-reasoning',
                id: 'reasoning-1',
                localId: null,
                createdAt: 2,
                text: '**Inspecting files**'
            },
            compactingEvent,
            compactEvent,
            compactedEvent,
            secondTool,
            processText
        ]

        const visible = groupAssistantResultDetails(blocks, {
            runActive: true,
            aggregateActiveProcess: true
        })

        expect(visible).toHaveLength(6)
        expect(visible[0]).toBe(blocks[0])
        expect(visible[1]).toMatchObject({
            kind: 'tool-group',
            id: 'tool-group:active-process:tool-1',
            turnActive: true,
            defaultOpen: false,
            tools: [firstTool],
            detailBlocks: [firstTool, { id: 'reasoning-1' }]
        })
        expect(visible[2]).toBe(compactingEvent)
        expect(visible[3]).toBe(compactEvent)
        expect(visible[4]).toBe(compactedEvent)
        expect(visible[5]).toMatchObject({
            kind: 'tool-group',
            id: 'tool-group:active-process:tool-2',
            turnActive: true,
            defaultOpen: true,
            tools: [secondTool],
            detailBlocks: [secondTool, processText]
        })
    })

    it('does not hide an active permission request inside a process group', () => {
        const permission = toolCall('permission-1')
        permission.tool.permission = { id: 'permission-1', status: 'pending' }

        const visible = groupAssistantResultDetails([permission], {
            runActive: true,
            aggregateActiveProcess: true
        })

        expect(visible).toEqual([permission])
    })

    it('keeps context compaction outside completed processed details', () => {
        const tool = toolCall('tool-1')
        const processText = agentText('process-1', 'Checking the result')
        const finalText = agentText('final-1', 'Done')
        const compactEvent: VisibleChatBlock = {
            kind: 'agent-event',
            id: 'compact-1',
            createdAt: 2,
            event: { type: 'compact', trigger: 'auto', preTokens: 0 }
        }

        const visible = groupAssistantResultDetails([
            userText('user-current'),
            tool,
            processText,
            compactEvent,
            toolCall('tool-2'),
            finalText,
        ], { aggregateActiveProcess: true })

        expect(visible).toContain(compactEvent)
        expect(visible.some((block) => (
            isToolGroupBlock(block) && block.detailBlocks?.some((detail) => detail.id === compactEvent.id)
        ))).toBe(false)
    })

    it('still groups completed history while the latest turn is active', () => {
        const historicalTool = toolCall('tool-history')
        const historicalProcess = agentText('history-process', '历史过程')
        const historicalResult = agentText('history-result', '历史结果')
        const currentUser = userText('user-current')
        const currentTool = toolCall('tool-current')
        const currentProcess = agentText('current-process', '当前过程')
        const blocks: VisibleChatBlock[] = [
            historicalTool,
            historicalProcess,
            historicalResult,
            currentUser,
            currentTool,
            currentProcess
        ]

        const visible = groupAssistantResultDetails(blocks, { runActive: true })

        expect(visible).toHaveLength(5)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(historicalResult)
        expect(visible[2]).toBe(currentUser)
        expect(visible[3]).toBe(currentTool)
        expect(visible[4]).toBe(currentProcess)
    })

    it('preserves source group expansion keys after result aggregation', () => {
        const tool = toolCall('tool-1')
        const sourceGroup: ToolGroupBlock = {
            kind: 'tool-group',
            id: 'tool-group:live-1',
            createdAt: 1,
            invokedAt: null,
            firstToolId: tool.id,
            lastToolId: tool.id,
            tools: [tool],
            defaultOpen: false,
            historyState: 'complete',
            needsOlderHistory: false,
            summary: summarizeToolGroup([tool]),
            expansionStateKeys: ['tool-group:live-1']
        }

        const visible = groupAssistantResultDetails([
            sourceGroup,
            agentText('text-1', '过程'),
            agentText('text-2', '最终结果')
        ])

        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected result detail group')
        }
        expect(visible[0].expansionStateKeys).toEqual(['tool-group:live-1'])
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

    it('keeps a standalone Skill card separate from its final assistant result', () => {
        const skill = toolCall('skill-1', 'Skill')
        const result = agentText('result-1', '已生成。')

        const visible = groupAssistantResultDetails([skill, result])

        expect(visible).toEqual([skill, result])
    })

    it('keeps generated images and preceding Skill cards out of result details', () => {
        const skill = toolCall('skill-1', 'Skill')
        const image = generatedImage('image-1')
        const result = agentText('result-1', '已生成。')

        const visible = groupAssistantResultDetails([skill, image, result])

        expect(visible).toEqual([skill, image, result])
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
