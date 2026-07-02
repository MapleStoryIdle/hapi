import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { isToolGroupBlock, summarizeToolGroup, type ToolGroupBlock, type VisibleChatBlock } from '@/chat/toolGroups'

function isAssistantVisibleBlock(block: VisibleChatBlock): boolean {
    if (block.kind === 'user-text') return false
    if (block.kind === 'agent-event') return false
    if (block.kind === 'cli-output' && block.source === 'user') return false
    return true
}

function firstInvokedAt(blocks: VisibleChatBlock[]): number | null {
    for (const block of blocks) {
        if ('invokedAt' in block && block.invokedAt != null) {
            return block.invokedAt
        }
    }
    return null
}

function flattenSourceBlock(
    block: VisibleChatBlock,
    tools: ToolCallBlock[],
    detailBlocks: ChatBlock[]
): void {
    if (isToolGroupBlock(block)) {
        tools.push(...block.tools)
        if (block.detailBlocks && block.detailBlocks.length > 0) {
            detailBlocks.push(...block.detailBlocks)
        } else {
            detailBlocks.push(...block.tools)
        }
        return
    }

    if (block.kind === 'tool-call') {
        tools.push(block)
    }

    detailBlocks.push(block)
}

function createResultDetailsGroup(
    sourceBlocks: VisibleChatBlock[],
    tools: ToolCallBlock[],
    detailBlocks: ChatBlock[]
): ToolGroupBlock {
    const firstBlock = sourceBlocks[0]
    const firstToolId = tools[0]?.id ?? firstBlock.id
    const lastToolId = tools[tools.length - 1]?.id ?? firstToolId

    return {
        kind: 'tool-group',
        id: `tool-group:result-details:${firstBlock.id}`,
        createdAt: firstBlock.createdAt,
        invokedAt: firstInvokedAt(sourceBlocks),
        firstToolId,
        lastToolId,
        tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: summarizeToolGroup(tools),
        detailBlocks,
        showAgentIcon: true,
        forceGenericCompactTitle: true
    }
}

function transformAssistantGroup(group: VisibleChatBlock[]): VisibleChatBlock[] {
    if (group.length < 2) {
        return group
    }

    const finalBlock = group[group.length - 1]
    if (finalBlock.kind !== 'agent-text' || finalBlock.text.trim().length === 0) {
        return group
    }

    const tools: ToolCallBlock[] = []
    const detailBlocks: ChatBlock[] = []
    const detailSourceBlocks = group.slice(0, -1)
    for (const block of detailSourceBlocks) {
        flattenSourceBlock(block, tools, detailBlocks)
    }

    if (tools.length === 0) {
        return group
    }

    return [
        createResultDetailsGroup(group, tools, detailBlocks),
        finalBlock
    ]
}

export function groupAssistantResultDetails(
    blocks: VisibleChatBlock[],
    options: { runActive?: boolean } = {}
): VisibleChatBlock[] {
    if (options.runActive) {
        return blocks
    }

    const transformed: VisibleChatBlock[] = []
    let group: VisibleChatBlock[] = []

    const flushGroup = () => {
        if (group.length === 0) return
        transformed.push(...transformAssistantGroup(group))
        group = []
    }

    for (const block of blocks) {
        if (!isAssistantVisibleBlock(block)) {
            flushGroup()
            transformed.push(block)
            continue
        }
        group.push(block)
    }

    flushGroup()
    return transformed
}
