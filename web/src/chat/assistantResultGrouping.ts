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

function collectExpansionStateKeys(blocks: readonly VisibleChatBlock[]): string[] {
    const keys: string[] = []
    for (const block of blocks) {
        if (!isToolGroupBlock(block)) continue
        for (const key of block.expansionStateKeys ?? [block.id]) {
            if (!keys.includes(key)) {
                keys.push(key)
            }
        }
    }
    return keys
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
        expansionStateKeys: collectExpansionStateKeys(sourceBlocks),
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
    const transformed: VisibleChatBlock[] = []
    let group: VisibleChatBlock[] = []
    let groupStartIndex = -1
    const latestUserIndex = blocks.findLastIndex((block) => block.kind === 'user-text')
    if (options.runActive && latestUserIndex === -1) {
        return blocks
    }

    const flushGroup = () => {
        if (group.length === 0) return
        const isCurrentTurnGroup = groupStartIndex > latestUserIndex
        transformed.push(...(
            options.runActive && isCurrentTurnGroup
                ? group
                : transformAssistantGroup(group)
        ))
        group = []
        groupStartIndex = -1
    }

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]!
        if (!isAssistantVisibleBlock(block)) {
            flushGroup()
            transformed.push(block)
            continue
        }
        if (group.length === 0) {
            groupStartIndex = index
        }
        group.push(block)
    }

    flushGroup()
    return transformed
}
