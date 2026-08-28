import type { ChatBlock } from '@/chat/types'
import {
    buildVisibleChatBlocks,
    isToolGroupBlock,
    type ToolGroupBlock,
    type VisibleChatBlock
} from '@/chat/toolGroups'
import { groupAssistantResultDetails } from '@/chat/assistantResultGrouping'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'

/**
 * Display options shared by the HAPI and native Codex detail timelines.
 * Fetching and mutation stay source-specific; once records are ChatBlocks,
 * both routes use this same grouping and compact-result policy.
 */
export type SessionDetailTimelineOptions = {
    hasMoreMessages: boolean
    previousGroups?: readonly ToolGroupBlock[]
    terminalToolDisplayMode?: TerminalToolDisplayMode
    runActive?: boolean
}

export type SessionDetailTimeline = {
    /** Tool groups before the current-turn result compaction policy is applied. */
    grouped: VisibleChatBlock[]
    /** Blocks ready for the shared detail-thread renderer. */
    visible: VisibleChatBlock[]
}

/**
 * The session store preserves block identity for unchanged history. Retain the
 * last derived timeline so a stream update only rebuilds the active turn after
 * its last user-message boundary. A user message is a safe separator for both
 * tool grouping and assistant-result compaction.
 */
export type SessionDetailTimelineCache = {
    blocks: readonly ChatBlock[]
    hasMoreMessages: boolean
    terminalToolDisplayMode: TerminalToolDisplayMode | undefined
    runActive: boolean | undefined
    timeline: SessionDetailTimeline
}

export type IncrementalSessionDetailTimelineResult = {
    timeline: SessionDetailTimeline
    cache: SessionDetailTimelineCache
    reusedPrefix: boolean
}

function getCommonBlockPrefixLength(
    previous: readonly ChatBlock[],
    next: readonly ChatBlock[]
): number {
    const length = Math.min(previous.length, next.length)
    let index = 0
    while (index < length && previous[index] === next[index]) {
        index += 1
    }
    return index
}

function getLastUserBoundaryIndex(blocks: readonly ChatBlock[], endExclusive: number): number {
    for (let index = endExclusive - 1; index >= 0; index -= 1) {
        if (blocks[index]?.kind === 'user-text') {
            return index
        }
    }
    return -1
}

function getVisiblePrefixThroughUserBoundary(
    blocks: readonly VisibleChatBlock[],
    userBlockId: string
): VisibleChatBlock[] | null {
    const index = blocks.findIndex((block) => block.id === userBlockId)
    return index === -1 ? null : blocks.slice(0, index + 1)
}

function getTailPreviousGroups(
    timeline: SessionDetailTimeline,
    tailBlocks: readonly ChatBlock[]
): ToolGroupBlock[] {
    const tailToolIds = new Set(
        tailBlocks
            .filter((block): block is Extract<ChatBlock, { kind: 'tool-call' }> => block.kind === 'tool-call')
            .map((block) => block.id)
    )

    return timeline.grouped.filter(isToolGroupBlock).filter((group) => (
        group.tools.some((tool) => tailToolIds.has(tool.id))
    ))
}

function createTimelineCache(
    blocks: readonly ChatBlock[],
    options: SessionDetailTimelineOptions,
    timeline: SessionDetailTimeline
): SessionDetailTimelineCache {
    return {
        blocks,
        hasMoreMessages: options.hasMoreMessages,
        terminalToolDisplayMode: options.terminalToolDisplayMode,
        runActive: options.runActive,
        timeline
    }
}

function canReuseTimelinePrefix(
    options: SessionDetailTimelineOptions,
    cache: SessionDetailTimelineCache
): boolean {
    return cache.hasMoreMessages === options.hasMoreMessages
        && cache.terminalToolDisplayMode === options.terminalToolDisplayMode
        && cache.runActive === options.runActive
}

export function buildSessionDetailTimeline(
    blocks: readonly ChatBlock[],
    options: SessionDetailTimelineOptions
): SessionDetailTimeline {
    const grouped = buildVisibleChatBlocks([...blocks], {
        hasMoreMessages: options.hasMoreMessages,
        previousGroups: options.previousGroups ? [...options.previousGroups] : undefined,
        terminalToolDisplayMode: options.terminalToolDisplayMode
    })

    return {
        grouped,
        visible: groupAssistantResultDetails(grouped, {
            runActive: options.runActive
        })
    }
}

/**
 * Incremental companion to buildSessionDetailTimeline.
 *
 * It is intentionally conservative: a pagination/mode/run-state change, no
 * stable user boundary, or a changed prefix all take the complete path. That
 * keeps grouping semantics identical while saving the common "new stream text
 * at the bottom" case from re-walking finished history.
 */
export function buildIncrementalSessionDetailTimeline(
    blocks: readonly ChatBlock[],
    options: SessionDetailTimelineOptions,
    previousCache: SessionDetailTimelineCache | null | undefined
): IncrementalSessionDetailTimelineResult {
    if (!previousCache || !canReuseTimelinePrefix(options, previousCache)) {
        const timeline = buildSessionDetailTimeline(blocks, options)
        return {
            timeline,
            cache: createTimelineCache(blocks, options, timeline),
            reusedPrefix: false
        }
    }

    const commonPrefixLength = getCommonBlockPrefixLength(previousCache.blocks, blocks)
    if (commonPrefixLength === blocks.length && commonPrefixLength === previousCache.blocks.length) {
        return {
            timeline: previousCache.timeline,
            cache: createTimelineCache(blocks, options, previousCache.timeline),
            reusedPrefix: true
        }
    }

    const boundaryIndex = getLastUserBoundaryIndex(blocks, commonPrefixLength)
    if (boundaryIndex === -1) {
        const timeline = buildSessionDetailTimeline(blocks, options)
        return {
            timeline,
            cache: createTimelineCache(blocks, options, timeline),
            reusedPrefix: false
        }
    }

    const boundaryId = blocks[boundaryIndex]!.id
    const groupedPrefix = getVisiblePrefixThroughUserBoundary(previousCache.timeline.grouped, boundaryId)
    const visiblePrefix = getVisiblePrefixThroughUserBoundary(previousCache.timeline.visible, boundaryId)
    if (!groupedPrefix || !visiblePrefix) {
        const timeline = buildSessionDetailTimeline(blocks, options)
        return {
            timeline,
            cache: createTimelineCache(blocks, options, timeline),
            reusedPrefix: false
        }
    }

    const tailBlocks = blocks.slice(boundaryIndex + 1)
    const tail = buildSessionDetailTimeline(tailBlocks, {
        // The tail begins immediately after a user boundary, so it is never
        // the oldest visible history group even when the whole thread has more
        // pages available above it.
        hasMoreMessages: false,
        previousGroups: getTailPreviousGroups(previousCache.timeline, tailBlocks),
        terminalToolDisplayMode: options.terminalToolDisplayMode,
        runActive: options.runActive
    })
    const timeline: SessionDetailTimeline = {
        grouped: [...groupedPrefix, ...tail.grouped],
        visible: [...visiblePrefix, ...tail.visible]
    }

    return {
        timeline,
        cache: createTimelineCache(blocks, options, timeline),
        reusedPrefix: true
    }
}
