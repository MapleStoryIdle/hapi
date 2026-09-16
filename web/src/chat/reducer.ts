import type { AgentState } from '@/types/api'
import type { AgentEvent, ChatBlock, NormalizedMessage, UsageData } from '@/chat/types'
import type { ThreadGoal } from '@/types/api'
import { traceMessages, type TracedMessage } from '@/chat/tracer'
import { dedupeAgentEvents, foldApiErrorEvents, foldTaskStatusEvents } from '@/chat/reducerEvents'
import { collectTitleChanges, collectToolIdsFromMessages, ensureToolBlock, getPermissions } from '@/chat/reducerTools'
import { reduceTimeline } from '@/chat/reducerTimeline'
import { isRedundantGoalStatusMessageText } from '@hapi/protocol/messages'

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
    if (typeof usage.context_tokens === 'number') {
        return usage.context_tokens
    }
    return (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens
}

function isUsageVisibleInParentContext(usage: UsageData): boolean {
    return usage.scope_role !== 'child'
}

export type LatestUsage = {
    inputTokens: number
    outputTokens: number
    cacheCreation: number
    cacheRead: number
    contextSize: number
    contextWindow: number | null
    timestamp: number
}

export type ReduceChatBlocksOptions = {
    goalStateMessages?: NormalizedMessage[]
}

function getLatestThreadGoal(normalized: NormalizedMessage[]): ThreadGoal | null {
    let sawNewerNonGoalUserMessage = false
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.role === 'user') {
            if (!/^\s*\/goal(?:\s|$)/i.test(msg.content.text)) {
                sawNewerNonGoalUserMessage = true
            }
            continue
        }
        if (msg.role !== 'event') continue
        const event = msg.content as AgentEvent
        if (event.type === 'thread-goal-cleared') return null
        if (event.type === 'thread-goal-updated') {
            const goal = (event as { goal?: ThreadGoal }).goal ?? null
            if (goal?.status === 'complete' && sawNewerNonGoalUserMessage) {
                return null
            }
            return goal
        }
    }
    return null
}

function isRedundantGoalStatusMessage(event: AgentEvent): boolean {
    if (event.type !== 'message') return false
    return isRedundantGoalStatusMessageText(event.message)
}

function isSilentTimelineBlock(block: ChatBlock): boolean {
    return block.kind === 'agent-event'
        && (
            block.event.type === 'thread-goal-updated'
            || block.event.type === 'thread-goal-cleared'
            || block.event.type === 'codex-usage-updated'
            || isRedundantGoalStatusMessage(block.event)
        )
}

function filterSilentTimelineBlocks(blocks: ChatBlock[]): ChatBlock[] {
    const filtered: ChatBlock[] = []

    for (const block of blocks) {
        if (isSilentTimelineBlock(block)) continue
        if (block.kind === 'tool-call' && block.children.length > 0) {
            filtered.push({
                ...block,
                children: filterSilentTimelineBlocks(block.children)
            })
            continue
        }
        filtered.push(block)
    }

    return filtered
}

function reconcileCodexAgentBlocksWithState(
    blocks: ChatBlock[],
    agentState: AgentState | null | undefined
): void {
    const snapshots = Object.values(agentState?.codex?.subagents ?? {})

    const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
    const snapshotsByCardId = new Map(
        snapshots
            .filter((snapshot) => Boolean(snapshot.cardId))
            .map((snapshot) => [snapshot.cardId!, snapshot])
    )

    const finishActiveDescendants = (items: ChatBlock[], state: 'completed' | 'error', completedAt: number): void => {
        for (const item of items) {
            if (item.kind !== 'tool-call') continue
            if (item.tool.state === 'running' || item.tool.state === 'pending') {
                item.tool = {
                    ...item.tool,
                    state,
                    completedAt,
                    durationMs: Math.max(0, completedAt - (item.tool.startedAt ?? item.tool.createdAt))
                }
            }
            finishActiveDescendants(item.children, state, completedAt)
        }
    }

    const visit = (items: ChatBlock[]): void => {
        for (const block of items) {
            if (block.kind !== 'tool-call') continue

            if (block.tool.name === 'CodexAgent') {
                const input = typeof block.tool.input === 'object' && block.tool.input !== null
                    ? block.tool.input as Record<string, unknown>
                    : {}
                const agentId = typeof input.agentId === 'string'
                    ? input.agentId
                    : typeof input.agent_id === 'string'
                        ? input.agent_id
                        : null
                const snapshot = (agentId ? snapshotsById.get(agentId) : undefined)
                    ?? snapshotsByCardId.get(block.id)
                const terminal = snapshot
                    && (
                        snapshot.status === 'completed'
                        || snapshot.status === 'failed'
                        || snapshot.status === 'error'
                        || snapshot.status === 'canceled'
                        || snapshot.status === 'cancelled'
                        || snapshot.status === 'notFound'
                        || snapshot.status === 'not_found'
                    )

                if (snapshot && terminal && (block.tool.state === 'running' || block.tool.state === 'pending')) {
                    const completedAt = snapshot.completedAt ?? snapshot.updatedAt
                    const terminalState = snapshot.status === 'completed' ? 'completed' : 'error'
                    block.tool = {
                        ...block.tool,
                        input: {
                            ...input,
                            agentId: snapshot.id,
                            agentStatus: snapshot.status,
                            statusText: snapshot.statusText ?? snapshot.status,
                            ...(snapshot.activity ? { activity: snapshot.activity } : {}),
                            ...(snapshot.activityKind ? { activityKind: snapshot.activityKind } : {})
                        },
                        state: terminalState,
                        completedAt
                    }
                }

                const terminalState = block.tool.state === 'completed'
                    ? 'completed'
                    : block.tool.state === 'error'
                        ? 'error'
                        : null
                if (terminalState) {
                    const completedAt = block.tool.completedAt
                        ?? snapshot?.completedAt
                        ?? snapshot?.updatedAt
                        ?? block.tool.startedAt
                        ?? block.tool.createdAt
                    finishActiveDescendants(block.children, terminalState, completedAt)
                }
            }

            visit(block.children)
        }
    }

    visit(blocks)
}

export function reduceChatBlocks(
    normalized: NormalizedMessage[],
    agentState: AgentState | null | undefined,
    options: ReduceChatBlocksOptions = {}
): { blocks: ChatBlock[]; hasReadyEvent: boolean; latestUsage: LatestUsage | null; latestGoal: ThreadGoal | null } {
    const permissionsById = getPermissions(agentState)
    const toolIdsInMessages = collectToolIdsFromMessages(normalized)
    const titleChangesByToolUseId = collectTitleChanges(normalized)

    const traced = traceMessages(normalized)
    const groups = new Map<string, TracedMessage[]>()
    const root: TracedMessage[] = []

    for (const msg of traced) {
        if (msg.sidechainId) {
            const existing = groups.get(msg.sidechainId) ?? []
            existing.push(msg)
            groups.set(msg.sidechainId, existing)
        } else {
            root.push(msg)
        }
    }

    const consumedGroupIds = new Set<string>()
    const emittedTitleChangeToolUseIds = new Set<string>()
    const reducerContext = { permissionsById, groups, consumedGroupIds, titleChangesByToolUseId, emittedTitleChangeToolUseIds }
    const rootResult = reduceTimeline(root, reducerContext)
    reconcileCodexAgentBlocksWithState(rootResult.blocks, agentState)
    let hasReadyEvent = rootResult.hasReadyEvent

    // Synthesize a tool card only for a *pending* permission that has no tool
    // call/result in the transcript — so the user can still answer it when its
    // tool_use message hasn't loaded. A resolved request (approved/denied/
    // canceled) is history: agentState keeps it in completedRequests, but
    // synthesizing it here appends a card to the end of the timeline (there is
    // no chronological re-sort), pinning a stale "answered" card above the
    // composer forever. Resolved requests render only via their own message,
    // when it is in the window.
    // Also skip if the permission is older than the oldest message in the
    // current view, to avoid mixing old tool cards with newer messages when
    // paginating.
    const oldestMessageTime = normalized.length > 0
        ? Math.min(...normalized.map(m => m.createdAt))
        : null

    for (const [id, entry] of permissionsById) {
        if (entry.permission.status !== 'pending') continue
        if (toolIdsInMessages.has(id)) continue
        if (rootResult.toolBlocksById.has(id)) continue

        const createdAt = entry.permission.createdAt ?? Date.now()

        // Skip permissions that are older than the oldest message in the current view.
        // These will be shown when the user loads older messages.
        if (oldestMessageTime !== null && createdAt < oldestMessageTime) {
            continue
        }

        ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
            createdAt,
            localId: null,
            name: entry.toolName,
            input: entry.input,
            description: null,
            permission: entry.permission
        })
    }

    // Calculate latest usage from messages (find the most recent message with usage data)
    let latestUsage: LatestUsage | null = null
    for (let i = normalized.length - 1; i >= 0; i--) {
        const msg = normalized[i]
        if (msg.usage && isUsageVisibleInParentContext(msg.usage)) {
            latestUsage = {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheCreation: msg.usage.cache_creation_input_tokens ?? 0,
                cacheRead: msg.usage.cache_read_input_tokens ?? 0,
                contextSize: calculateContextSize(msg.usage),
                contextWindow: msg.usage.context_window ?? null,
                timestamp: msg.createdAt
            }
            break
        }
    }

    return {
        blocks: filterSilentTimelineBlocks(dedupeAgentEvents(foldTaskStatusEvents(foldApiErrorEvents(rootResult.blocks)))),
        hasReadyEvent,
        latestUsage,
        latestGoal: getLatestThreadGoal(options.goalStateMessages ?? normalized)
    }
}
