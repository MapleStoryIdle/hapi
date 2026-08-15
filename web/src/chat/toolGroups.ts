import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { getInputStringAny } from '@/lib/toolInputUtils'

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
}

export type VisibleChatBlock = ChatBlock | ToolGroupBlock

type ToolGroupingOptions = {
    hasMoreMessages: boolean
    previousGroups?: ToolGroupBlock[]
    terminalToolDisplayMode?: TerminalToolDisplayMode
}

const PLAN_TOOL_NAMES = new Set([
    'TodoWrite',
    'update_plan',
    'ExitPlanMode',
    'exit_plan_mode',
    'CodexReasoning'
])

const MILESTONE_TOOL_NAMES = new Set([
    'Task',
    'Agent',
    'CodexAgent',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
    'Skill',
    'spawn_agent',
    'send_input',
    'resume_agent',
    'wait_agent',
    'close_agent'
])

const INTERACTIVE_TOOL_NAMES = new Set([
    'CodexPermission'
])

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

    let sawRead = false
    let sawWrite = false
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const type = (item as { type?: unknown }).type
        if (type === 'write') sawWrite = true
        if (type === 'read') sawRead = true
    }

    if (sawWrite) return 'mutation'
    if (sawRead) return 'read'
    return null
}

const SHELL_MUTATION_RE = /(?:^|[;&|]\s*)(?:apply_patch|rm|mv|cp|mkdir|touch|chmod|chown|install|tee|npm\s+install|npm\s+i|bun\s+add|pnpm\s+add|yarn\s+add)\b|(?:^|[^<])(?:>>|>\s*[^&])|\b(?:sed|perl)\b[^;&|]*\s-(?:[A-Za-z]*i[A-Za-z]*|[A-Za-z]*p[A-Za-z]*i[A-Za-z]*)\b/i
const SHELL_SEARCH_RE = /(?:^|[;&|()]\s*|["'])(?:rg|grep|git\s+grep|fd|find|ag|ack|select-string|findstr)\b/i
const SHELL_READ_RE = /(?:^|[;&|()]\s*|["'])(?:ls|dir|cat|type|get-content|tree|get-childitem|head|tail|less|more|pwd|wc|du|stat|file|which|where|jq|sed|awk|git\s+(?:diff|status|log|show|branch|rev-parse|ls-files|blame))\b/i

function getShellCommandActionKind(input: unknown): ToolGroupActionKind {
    const parsedKind = parsedCodexCommandKind(input)
    if (parsedKind) return parsedKind

    const command = normalizeCommandInput(input)
    if (!command) return 'command'

    if (SHELL_MUTATION_RE.test(command)) return 'mutation'
    if (SHELL_SEARCH_RE.test(command)) return 'search'
    if (SHELL_READ_RE.test(command)) return 'read'
    return 'command'
}

export function getToolGroupActionKind(block: ToolCallBlock): ToolGroupActionKind {
    const name = block.tool.name

    if (name === 'Read' || name === 'NotebookRead') return 'read'
    if (name === 'Grep' || name === 'Glob' || name === 'LS') return 'search'
    if (name === 'Bash' || name === 'CodexBash' || name === 'shell_command') return getShellCommandActionKind(block.tool.input)
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
    return INTERACTIVE_TOOL_NAMES.has(block.tool.name)
        || block.tool.permission?.status === 'pending'
        || isAskUserQuestionToolName(block.tool.name)
        || isRequestUserInputToolName(block.tool.name)
}

export function isEligibleForToolGrouping(block: ToolCallBlock): boolean {
    if (isSubagentToolName(block.tool.name)) return false
    if (PLAN_TOOL_NAMES.has(block.tool.name)) return false
    if (MILESTONE_TOOL_NAMES.has(block.tool.name)) return false
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

export function buildVisibleChatBlocks(
    blocks: ChatBlock[],
    options: ToolGroupingOptions
): VisibleChatBlock[] {
    const visibleBlocks: VisibleChatBlock[] = []
    const previousGroups = options.previousGroups ?? []
    const groupSingleTools = options.terminalToolDisplayMode === 'compact'

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block.kind !== 'tool-call' || !isEligibleForToolGrouping(block)) {
            visibleBlocks.push(block)
            continue
        }

        const tools: ToolCallBlock[] = [block]
        let cursor = index + 1
        while (cursor < blocks.length) {
            const candidate = blocks[cursor]
            if (candidate.kind !== 'tool-call' || !isEligibleForToolGrouping(candidate)) {
                break
            }
            tools.push(candidate)
            cursor += 1
        }

        if (tools.length < 2 && !groupSingleTools) {
            visibleBlocks.push(block)
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
            expansionStateKeys: [id]
        })
        index = cursor - 1
    }

    return visibleBlocks
}
