import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { getCodexDiffPaths, getCodexPatchChanges, isSameCodexChangedPath } from '@/components/ToolCard/codexPatch'
import { getMcpReadTarget } from '@/components/ToolCard/fileAccess'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { normalizeExplicitSkillUsage } from '@/chat/skillUsage'
import { toQuestionAnswerBlock, type QuestionAnswerBlock } from '@/chat/questionAnswers'

export type ToolGroupActionKind = 'read' | 'search' | 'command' | 'mutation' | 'web' | 'other'

export type ToolGroupSummary = {
    totalTools: number
    countsByKind: Record<ToolGroupActionKind, number>
    fileTargets: string[]
    commandTargets: string[]
    searchTargets: string[]
    urlTargets: string[]
    otherTargets: string[]
    errorCount: number
    runningCount: number
    pendingCount: number
}

export type ToolGroupBlock = {
    kind: 'tool-group'
    id: string
    createdAt: number
    invokedAt?: number | null
    firstToolId: string
    lastToolId: string
    tools: ToolCallBlock[]
    defaultOpen: boolean
    historyState: 'complete' | 'needs-older-history'
    needsOlderHistory: boolean
    summary: ToolGroupSummary
    /** Stable keys used to retain expansion state when completed groups merge. */
    expansionStateKeys?: string[]
    detailBlocks?: ChatBlock[]
    showAgentIcon?: boolean
    forceGenericCompactTitle?: boolean
    /** Render the tool activity as a collapsed, transparent activity row. */
    forceCompact?: boolean
    /** The surrounding assistant turn is still running after its latest tool completed. */
    turnActive?: boolean
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock | QuestionAnswerBlock

type ToolGroupingOptions = {
    hasMoreMessages: boolean
    previousGroups?: ToolGroupBlock[]
    terminalToolDisplayMode?: TerminalToolDisplayMode
}

function pushUnique(target: string[], value: string | null): void {
    if (!value) return
    if (target.includes(value)) return
    target.push(value)
}

function normalizeCommandInput(input: unknown): string | null {
    const direct = getInputStringAny(input, ['command', 'cmd'])
    if (direct) return direct

    if (!input || typeof input !== 'object') return null
    const command = (input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

function parsedCodexCommandKind(input: unknown): ToolGroupActionKind | null {
    if (!input || typeof input !== 'object') return null
    const parsed = (input as { parsed_cmd?: unknown }).parsed_cmd
    if (!Array.isArray(parsed)) return null

    let sawWrite = false
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const type = (item as { type?: unknown }).type
        if (type === 'write') sawWrite = true
    }

    if (sawWrite) return 'mutation'
    return null
}

const SHELL_MUTATION_RE = /(?:^|[;&|]\s*)(?:apply_patch|rm|mv|cp|mkdir|touch|chmod|chown|install|tee|npm\s+install|npm\s+i|bun\s+add|pnpm\s+add|yarn\s+add)\b|(?:^|[^<])(?:>>|>\s*[^&])|\b(?:sed|perl)\b[^;&|]*\s-(?:[A-Za-z]*i[A-Za-z]*|[A-Za-z]*p[A-Za-z]*i[A-Za-z]*)\b/i
const SHELL_SEARCH_RE = /(?:^|[;&|()]\s*|["'])(?:rg|grep|git\s+grep|fd|find|ag|ack|select-string|findstr)\b/i
const SHELL_READ_RE = /(?:^|[;&|()]\s*|["'])(?:ls|dir|cat|type|get-content|tree|get-childitem|head|tail|less|more|pwd|wc|du|stat|file|which|where|jq|sed|awk|git\s+(?:diff|status|log|show|branch|rev-parse|ls-files|blame))\b/i

function getShellCommandActionKind(input: unknown, allowReadClassification = true): ToolGroupActionKind {
    const parsedKind = parsedCodexCommandKind(input)
    if (parsedKind) return parsedKind

    const command = normalizeCommandInput(input)
    if (!command) return 'command'

    if (SHELL_MUTATION_RE.test(command)) return 'mutation'
    if (SHELL_SEARCH_RE.test(command)) return 'search'
    if (allowReadClassification && SHELL_READ_RE.test(command)) return 'read'
    return 'command'
}

function isReadLikeToolName(name: string): boolean {
    if (name === 'Read' || name === 'NotebookRead') return true

    const normalizedName = name.toLowerCase()
    return normalizedName === 'readfile' || normalizedName === 'read_file'
}

export function getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    const name = block.tool.name

    if (isReadLikeToolName(name) || (name.startsWith('mcp__') && getMcpReadTarget(block.tool.input))) return 'read'
    if (name === 'Grep' || name === 'Glob' || name === 'LS') return 'search'
    if (name === 'CodexBash') return getShellCommandActionKind(block.tool.input, false)
    if (name === 'Bash' || name === 'shell_command') return getShellCommandActionKind(block.tool.input)
    if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit' || name === 'CodexPatch' || name === 'CodexDiff') {
        return 'mutation'
    }
    if (name === 'WebFetch' || name === 'WebSearch') return 'web'
    return 'other'
}

function getPrimaryFileTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['file_path', 'path', 'file', 'filePath', 'notebook_path', 'name'])
}

function getPrimarySearchTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['pattern', 'query'])
}

function getPrimaryUrlTarget(block: ToolCallBlock): string | null {
    return getInputStringAny(block.tool.input, ['url'])
}

function getPrimaryOtherTarget(block: ToolCallBlock): string | null {
    const fileTarget = getPrimaryFileTarget(block)
    if (fileTarget) return fileTarget

    const searchTarget = getPrimarySearchTarget(block)
    if (searchTarget) return searchTarget

    const commandTarget = normalizeCommandInput(block.tool.input)
    if (commandTarget) return commandTarget

    const urlTarget = getPrimaryUrlTarget(block)
    if (urlTarget) return urlTarget

    return block.tool.name
}

export function summarizeToolGroup(tools: ToolCallBlock[]): ToolGroupSummary {
    const countsByKind: Record<ToolGroupActionKind, number> = {
        read: 0,
        search: 0,
        command: 0,
        mutation: 0,
        web: 0,
        other: 0
    }
    const fileTargets: string[] = []
    const commandTargets: string[] = []
    const searchTargets: string[] = []
    const urlTargets: string[] = []
    const otherTargets: string[] = []
    let errorCount = 0
    let runningCount = 0
    let pendingCount = 0

    for (const tool of tools) {
        const kind = getToolGroupActionKind(tool)
        countsByKind[kind] += 1

        if (tool.tool.state === 'error') {
            errorCount += 1
        } else if (tool.tool.state === 'running') {
            runningCount += 1
        } else if (tool.tool.state === 'pending') {
            pendingCount += 1
        }

        if (kind === 'read' || kind === 'mutation') {
            pushUnique(fileTargets, getPrimaryFileTarget(tool) ?? normalizeCommandInput(tool.tool.input))
            continue
        }
        if (kind === 'search') {
            pushUnique(searchTargets, getPrimarySearchTarget(tool) ?? normalizeCommandInput(tool.tool.input))
            continue
        }
        if (kind === 'command') {
            pushUnique(commandTargets, normalizeCommandInput(tool.tool.input))
            continue
        }
        if (kind === 'web') {
            pushUnique(urlTargets, getPrimaryUrlTarget(tool) ?? getPrimarySearchTarget(tool))
            continue
        }
        pushUnique(otherTargets, getPrimaryOtherTarget(tool))
    }

    return {
        totalTools: tools.length,
        countsByKind,
        fileTargets,
        commandTargets,
        searchTargets,
        urlTargets,
        otherTargets,
        errorCount,
        runningCount,
        pendingCount,
    }
}

function isInteractiveToolBlock(block: ToolCallBlock): boolean {
    // A pending permission or question is an actionable control, not passive
    // activity. It must remain visible for the user to answer it.
    return block.tool.permission?.status === 'pending'
}

export function isEligibleForToolGrouping(block: ToolCallBlock): boolean {
    if (['request_user_input', 'request_user_input_async'].includes(block.tool.name.split('.').pop() ?? '')) return false
    if (isInteractiveToolBlock(block)) return false
    return true
}

function createToolGroupId(
    tools: ToolCallBlock[],
    needsOlderHistory: boolean,
    previousGroups: ToolGroupBlock[]
): string {
    const firstToolId = tools[0]?.id ?? 'unknown'
    const lastToolId = tools[tools.length - 1]?.id ?? firstToolId

    const previous = previousGroups.find((group) => group.firstToolId === firstToolId || group.lastToolId === lastToolId)
    if (previous) {
        return previous.id
    }

    return needsOlderHistory
        ? `tool-group:${lastToolId}`
        : `tool-group:${firstToolId}`
}

export function isToolGroupBlock(block: VisibleChatBlock | ChatBlock): block is ToolGroupBlock {
    return block.kind === 'tool-group'
}

/**
 * Codex emits both a fileChange (CodexPatch) and a cumulative turn/diff
 * (CodexDiff) for the same edit.  Patch is the authoritative card because it
 * carries the exact file-change payload.  Keep a Diff whenever it contains a
 * file that did not arrive as a Patch, so older or partial app-server events
 * still have a visible fallback.
 *
 * Historical events do not always carry a turn id.  The user-message boundary
 * is the stable turn boundary in the rendered transcript.
 */
export function filterCodexDiffsCoveredByPatches(blocks: ChatBlock[]): ChatBlock[] {
    const patchPaths: string[] = []

    return blocks.filter((block) => {
        if (block.kind === 'user-text') {
            patchPaths.length = 0
            return true
        }
        if (block.kind !== 'tool-call') return true
        if (toQuestionAnswerBlock(block)) {
            patchPaths.length = 0
            return true
        }

        if (block.tool.name === 'CodexPatch') {
            patchPaths.push(...getCodexPatchChanges(block.tool.input).map((change) => change.path))
            return true
        }
        if (block.tool.name !== 'CodexDiff') return true

        const diffPaths = getCodexDiffPaths(block.tool.input)
        if (patchPaths.length === 0 || diffPaths.length === 0) return true

        return !diffPaths.every((diffPath) => (
            patchPaths.some((patchPath) => isSameCodexChangedPath(patchPath, diffPath))
        ))
    })
}

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const previousGroups = options.previousGroups ?? []
    const displayBlocks = filterCodexDiffsCoveredByPatches(normalizeExplicitSkillUsage(blocks))

    for (let index = 0; index < displayBlocks.length; index += 1) {
        const block = displayBlocks[index]
        if (block.kind === 'tool-call') {
            const questionAnswer = toQuestionAnswerBlock(block)
            if (questionAnswer) {
                visibleBlocks.push(questionAnswer)
                continue
            }
        }
        if (block.kind !== 'agent-reasoning' && (block.kind !== 'tool-call' || !isEligibleForToolGrouping(block))) {
            visibleBlocks.push(block)
            continue
        }

        // Reasoning is passive process detail even in completed history or a
        // partial page without a final answer. Keep it in the adjacent tool
        // run, without crossing commentary, user choices or pending controls.
        const detailBlocks: ChatBlock[] = [block]
        const tools: ToolCallBlock[] = block.kind === 'tool-call' ? [block] : []
        let cursor = index + 1
        while (cursor < displayBlocks.length) {
            const candidate = displayBlocks[cursor]
            if (candidate.kind !== 'agent-reasoning' && (
                candidate.kind !== 'tool-call'
                || !isEligibleForToolGrouping(candidate)
                || toQuestionAnswerBlock(candidate)
            )) {
                break
            }
            detailBlocks.push(candidate)
            if (candidate.kind === 'tool-call') tools.push(candidate)
            cursor += 1
        }

        if (tools.length === 0) {
            visibleBlocks.push(...detailBlocks)
            index = cursor - 1
            continue
        }

        const startsAtOldestVisibleBoundary = visibleBlocks.length === 0
        const needsOlderHistory = options.hasMoreMessages && startsAtOldestVisibleBoundary
        const id = createToolGroupId(tools, needsOlderHistory, previousGroups)
        visibleBlocks.push({
            kind: 'tool-group',
            id,
            createdAt: tools[0].createdAt,
            invokedAt: tools[0].invokedAt,
            firstToolId: tools[0].id,
            lastToolId: tools[tools.length - 1].id,
            tools,
            defaultOpen: false,
            historyState: needsOlderHistory ? 'needs-older-history' : 'complete',
            needsOlderHistory,
            summary: summarizeToolGroup(tools),
            ...(detailBlocks.length > tools.length ? { detailBlocks } : {}),
            expansionStateKeys: [id],
            showAgentIcon: true,
            forceCompact: true
        })
        index = cursor - 1
    }

    return visibleBlocks
}
