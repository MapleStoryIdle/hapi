import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { getToolGroupActionKind, type ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { FILE_MUTATION_DIALOG_CLASS_NAME, ToolDetailDialogContent, ToolDetailDialogHeader, ToolStatusIcon, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getTerminalExecutionToolState, isTerminalExecutionTool } from '@/components/ToolCard/terminalExecution'
import { TerminalExecutionDrawer } from '@/components/ToolCard/TerminalExecutionDrawer'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getTerminalCommandDisplayTitle, getTerminalCommandIntent, getTerminalCommandIntentDetail, getTerminalCommandIntentLabel, getTerminalCommandSummary, joinTerminalSummaryParts } from '@/components/ToolCard/terminalCommandIntent'
import { getFileMutationDialogSummary } from '@/components/ToolCard/fileMutationDetail'
import { formatGroupedHeaderSubtitle, formatGroupedHeaderTitle } from '@/components/ToolCard/groupedPresentation'
import { getCodexAgentActivity, getCodexAgentEffectiveConfiguration, getCodexAgentSummary, parseCodexSpawnAgentResult } from '@/components/ToolCard/codexAgents'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChatDetailDialog } from '@/components/ui/ChatDetailDialog'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getEventPresentation } from '@/chat/presentation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { detectExplicitSkillName } from '@/chat/skillUsage'
import { useSharedNow } from '@/hooks/useSharedNow'
import {
    getDefaultToolGroupExpansionState,
    getPrimaryToolGroupExpansionStateKey,
    getToolGroupExpansionStateKeys,
    isToolGroupExpansionOpen,
    resolveToolGroupExpansionState
} from '@/components/ToolCard/toolGroupExpansion'

type ToolGroupCompactHeaderState = {
    groupId: string
    open: boolean
    setOpen: Dispatch<SetStateAction<boolean>>
}

const ToolGroupCompactHeaderContext = createContext<ToolGroupCompactHeaderState | null>(null)

export const ToolGroupCompactHeaderProvider = ToolGroupCompactHeaderContext.Provider

function DetailsIcon(props: { open: boolean }) {
    return (
        <svg className={cn('h-4 w-4 transition-transform duration-200', props.open ? 'rotate-90' : null)} viewBox="0 0 16 16" fill="none" data-state={props.open ? 'open' : 'closed'}>
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function getToolStartMs(tool: ToolCallBlock): number {
    return tool.tool.startedAt ?? tool.tool.createdAt
}

function getRecordedToolDurationMs(tool: ToolCallBlock): number | null {
    return typeof tool.tool.durationMs === 'number' && Number.isFinite(tool.tool.durationMs)
        ? Math.max(0, tool.tool.durationMs)
        : typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs)
            ? Math.max(0, tool.durationMs)
            : null
}

function getToolEndMs(tool: ToolCallBlock, now: number): number {
    if (tool.tool.state === 'running' || tool.tool.state === 'pending') {
        return now
    }
    const recordedDurationMs = getRecordedToolDurationMs(tool)
    if (recordedDurationMs !== null) {
        return getToolStartMs(tool) + recordedDurationMs
    }
    return tool.tool.completedAt ?? tool.tool.startedAt ?? tool.tool.createdAt
}

export function isToolGroupActive(block: ToolGroupBlock): boolean {
    return block.turnActive === true
        || block.tools.some((tool) => tool.tool.state === 'running' || tool.tool.state === 'pending')
}

export function getToolGroupDurationMs(block: ToolGroupBlock, now: number): number {
    if (block.tools.length === 0) {
        return 0
    }

    const toolStartedAt = Math.min(...block.tools.map(getToolStartMs))
    if (block.turnActive) {
        const startedAt = Math.min(block.invokedAt ?? block.createdAt, toolStartedAt)
        return Math.max(0, now - startedAt)
    }
    const startedAt = toolStartedAt
    const endedAt = Math.max(...block.tools.map((tool) => getToolEndMs(tool, now)))
    return Math.max(0, endedAt - startedAt)
}

export function formatCompactDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
    if (totalSeconds === 0) {
        return ''
    }
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    if (hours > 0) {
        return `${hours}h ${minutes}m`
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`
    }
    return `${seconds}s`
}

function getToolGroupSkillName(block: ToolGroupBlock): string | null {
    for (const tool of block.tools) {
        if (tool.tool.name !== 'Skill') continue
        const skill = getInputStringAny(tool.tool.input, ['skill', 'name'])?.trim() ?? null
        if (skill) return skill
    }

    for (const detail of block.detailBlocks ?? []) {
        if (detail.kind === 'generated-image') return 'imagegen'
        if (detail.kind === 'tool-call' && detail.tool.name === 'Skill') {
            const skill = getInputStringAny(detail.tool.input, ['skill', 'name'])?.trim() ?? null
            if (skill) return skill
        }
        if (detail.kind === 'agent-text' || detail.kind === 'agent-reasoning') {
            const skill = detectExplicitSkillName(detail.text)
            if (skill) return skill
        }
    }

    return null
}

function getCompactFileTarget(tool: ToolCallBlock): string | null {
    const direct = getInputStringAny(tool.tool.input, [
        'file_path',
        'path',
        'file',
        'filePath',
        'notebook_path',
        'name'
    ])
    if (direct) return direct

    if (!tool.tool.input || typeof tool.tool.input !== 'object') return null
    const parsedCommands = (tool.tool.input as { parsed_cmd?: unknown }).parsed_cmd
    if (!Array.isArray(parsedCommands)) return null

    for (const command of parsedCommands) {
        if (!command || typeof command !== 'object') continue
        const parsed = command as { type?: unknown; name?: unknown }
        if (parsed.type !== 'write' || typeof parsed.name !== 'string') continue
        const name = parsed.name.trim()
        if (name) return name
    }

    return null
}

function getCompactRawCommand(tool: ToolCallBlock): string | null {
    const direct = getInputStringAny(tool.tool.input, ['command', 'cmd'])
    if (direct) return direct

    if (!tool.tool.input || typeof tool.tool.input !== 'object') return null
    const command = (tool.tool.input as { command?: unknown }).command
    if (!Array.isArray(command)) return null

    const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
    return parts.length > 0 ? parts.join(' ') : null
}

function formatCompactRawText(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > 96 ? `${normalized.slice(0, 95)}…` : normalized
}

/** Turn a Codex reasoning/commentary snapshot into one calm activity label. */
export function formatLiveProcessText(value: string): string | null {
    const sections = value
        .split(/\n\s*\n/)
        .map((section) => section.trim())
        .filter(Boolean)
    const section = sections[sections.length - 1]
    if (!section) return null

    const emphasized = [...section.matchAll(/\*\*([^*]+)\*\*/g)]
    const source = emphasized[emphasized.length - 1]?.[1] ?? section.split(/\r?\n/).find(Boolean) ?? section
    const normalized = source
        .replace(/^\s*(?:#{1,6}|[-*+>])\s*/, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*|__|`/g, '')
        .replace(/\s+/g, ' ')
        .trim()

    if (!normalized) return null
    return formatCompactRawText(normalized)
}

function getLatestLiveProcessBlock(block: ToolGroupBlock): ToolCallBlock | Exclude<NonNullable<ToolGroupBlock['detailBlocks']>[number], ToolCallBlock> | null {
    if (!block.turnActive) return null
    const details = block.detailBlocks ?? block.tools
    return details.findLast((detail) => (
        detail.kind === 'tool-call'
        || detail.kind === 'agent-text'
        || detail.kind === 'agent-reasoning'
    )) ?? null
}

export function formatToolGroupCompactTitle(
    block: ToolGroupBlock,
    now: number,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    const label = getToolGroupCompactLabel(block, t)
    const duration = formatCompactDuration(getToolGroupDurationMs(block, now))
    if (!isToolGroupActive(block) && label === t('toolGroup.compact.processed', { duration: '' }).trim()) {
        return [label, duration].filter(Boolean).join(' ')
    }
    return joinTerminalSummaryParts([
        label,
        duration
    ])
}

function getToolGroupCompactLabel(
    block: ToolGroupBlock,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    const active = isToolGroupActive(block)
    const runningTerminal = active
        ? block.tools.findLast((tool) => (
            isTerminalExecutionTool(tool.tool.name)
            && (tool.tool.state === 'running' || tool.tool.state === 'pending')
        )) ?? null
        : null
    if (runningTerminal) {
        const terminalIntent = getTerminalCommandIntent(runningTerminal.tool.input)
        const terminalLabel = terminalIntent?.kind === 'read-request' && terminalIntent.targets.length > 1
            ? t('toolGroup.compact.row.readBatch', { n: terminalIntent.targets.length })
            : terminalIntent
                ? getTerminalCommandDisplayTitle(runningTerminal.tool.input, t)
                : getTerminalCommandSummary(runningTerminal.tool.input)
        const stateLabel = t(runningTerminal.tool.state === 'pending'
            ? 'terminal.execution.pending'
            : 'terminal.execution.running')
        return terminalLabel ? `${stateLabel} · ${terminalLabel}` : stateLabel
    }
    const latestLiveBlock = getLatestLiveProcessBlock(block)
    if (latestLiveBlock?.kind === 'agent-text' || latestLiveBlock?.kind === 'agent-reasoning') {
        const activity = formatLiveProcessText(latestLiveBlock.text)
        if (activity) return activity
    }

    const liveTool = latestLiveBlock?.kind === 'tool-call' ? latestLiveBlock : null
    const skillName = block.turnActive
        ? liveTool?.tool.name === 'Skill'
            ? getInputStringAny(liveTool.tool.input, ['skill', 'name'])?.trim() ?? null
            : null
        : getToolGroupSkillName(block)
    if (skillName) {
        return active
            ? t('toolGroup.compact.skill.processing', { skill: skillName, duration: '' }).trim()
            : t('toolGroup.compact.skill.processed', { skill: skillName, duration: '' }).trim()
    }

    const latestActiveTool = active
        ? block.tools.findLast((tool) => tool.tool.state === 'running' || tool.tool.state === 'pending') ?? null
        : null
    const latestTerminal = active
        ? block.tools.findLast((tool) => isTerminalExecutionTool(tool.tool.name)) ?? null
        : null
    const displayTool = liveTool ?? (!block.forceGenericCompactTitle && block.tools.length === 1
        ? block.tools[0]
        : latestActiveTool ?? latestTerminal)
    if (displayTool) {
        const invocationTitle = getInputStringAny(displayTool.tool.input, ['title'])?.trim()
        if (invocationTitle) {
            return formatCompactRawText(invocationTitle)
        }

        if (isTerminalExecutionTool(displayTool.tool.name)) {
            const terminalIntent = getTerminalCommandIntent(displayTool.tool.input)
            const terminalLabel = terminalIntent?.kind === 'read-request' && terminalIntent.targets.length > 1
                ? t('toolGroup.compact.row.readBatch', { n: terminalIntent.targets.length })
                : terminalIntent
                    ? getTerminalCommandDisplayTitle(displayTool.tool.input, t)
                    : getTerminalCommandSummary(displayTool.tool.input)
            const state = getTerminalExecutionToolState(displayTool)
            const stateLabel = active
                ? t(state === 'error' ? 'terminal.execution.failed' : 'terminal.execution.completed')
                : null
            const label = terminalLabel || t('terminal.execution.title')
            return stateLabel ? `${stateLabel} · ${label}` : label
        }

        const status = active ? 'processing' : 'processed'
        const kind = getToolGroupActionKind(displayTool)
        if (kind === 'mutation') {
            const fileTarget = getCompactFileTarget(displayTool)
            if (fileTarget) {
                return t(`toolGroup.compact.single.${status}.mutationTarget`, {
                    target: formatCompactRawText(fileTarget),
                    duration: ''
                }).trim()
            }

            const command = getCompactRawCommand(displayTool)
            if (command) {
                return t(`toolGroup.compact.single.${status}.commandFallback`, {
                    command: formatCompactRawText(command),
                    duration: ''
                }).trim()
            }
        }
        if (kind !== 'other') {
            return t(`toolGroup.compact.single.${status}.${kind}`, { duration: '' }).trim()
        }

        const presentation = getToolPresentation({
            toolName: displayTool.tool.name,
            input: displayTool.tool.input,
            result: displayTool.tool.result,
            childrenCount: displayTool.children.length,
            description: displayTool.tool.description,
            metadata: null
        }, t)
        if (presentation.title) {
            return formatCompactRawText(presentation.title)
        }
    }

    return active
        ? t('toolGroup.compact.processing', { duration: '' }).trim()
        : t('toolGroup.compact.processed', { duration: '' }).trim()
}

function CompactDetailBlock(props: { block: Exclude<NonNullable<ToolGroupBlock['detailBlocks']>[number], ToolCallBlock> }) {
    const block = props.block

    if (block.kind === 'agent-text') {
        return (
            <div className="min-w-0 pl-[15px] whitespace-pre-wrap text-[13px] leading-5 text-[var(--app-fg)]">
                {block.text}
            </div>
        )
    }

    if (block.kind === 'agent-reasoning') {
        const lines = block.text
            .split(/\n\s*\n/)
            .map(formatLiveProcessText)
            .filter((line): line is string => line !== null)
            .filter((line, index, source) => source.indexOf(line) === index)
        return (
            <div className="min-w-0 space-y-0.5 pl-[15px] text-[13px] leading-5 text-[var(--app-hint)]">
                {lines.map((line) => <div key={line}>{line}</div>)}
            </div>
        )
    }

    if (block.kind === 'cli-output') {
        return (
            <div className="pl-[15px]">
                <CliOutputBlock text={block.text} />
            </div>
        )
    }

    if (block.kind === 'agent-event') {
        const presentation = getEventPresentation(block.event)
        return (
            <div className="pl-[15px] text-sm text-[var(--app-hint)]">
                {presentation.text}
            </div>
        )
    }

    if (block.kind === 'codex-review') {
        return null
    }

    if (block.kind === 'generated-image') {
        return null
    }

    return null
}

function CompactDetailItem(props: {
    block: NonNullable<ToolGroupBlock['detailBlocks']>[number]
    metadata: SessionMetadataSummary | null
    onSelectTool: (toolId: string) => void
}) {
    const block = props.block

    if (block.kind === 'tool-call') {
        const isTerminalExecution = isTerminalExecutionTool(block.tool.name)
        const displayedToolState = isTerminalExecution ? getTerminalExecutionToolState(block) : block.tool.state

        return (
            <button
                type="button"
                className="-ml-[7px] flex min-h-8 min-w-0 items-center gap-2 rounded-md px-0 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                onClick={() => props.onSelectTool(block.id)}
            >
                <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center', toolStatusColorClass(displayedToolState))}>
                    <ToolStatusIcon state={displayedToolState} />
                </span>
                <CompactRowLabel block={block} metadata={props.metadata} />
            </button>
        )
    }

    return <CompactDetailBlock block={block} />
}

const CODEX_SUBAGENT_FRIENDLY_NAMES = [
    'Atlas',
    'Nova',
    'Orbit',
    'Sage',
    'Scout',
    'Beacon',
    'Harbor',
    'Piper'
] as const

export const CODEX_SUBAGENT_CARD_COLORS = [
    '#4E7CF5',
    '#7367E8',
    '#9862C7',
    '#C35E92',
    '#337FA8',
    '#258C91',
    '#647AA3',
    '#8A6F9E'
] as const

function getStablePaletteIndex(value: string, paletteLength: number): number {
    let hash = 2_166_136_261
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 16_777_619)
    }
    return (hash >>> 0) % paletteLength
}

function getTrimmedInputString(input: unknown, keys: string[]): string | null {
    return getInputStringAny(input, keys)?.trim() || null
}

function getCodexSubagentInternalIds(tool: ToolCallBlock): ReadonlySet<string> {
    const ids = new Set<string>()
    const inputId = getTrimmedInputString(tool.tool.input, ['agentId', 'agent_id'])
    if (inputId) ids.add(inputId.toLowerCase())

    const spawnResult = parseCodexSpawnAgentResult(tool.tool.result)
    if (spawnResult?.agentId) ids.add(spawnResult.agentId.trim().toLowerCase())
    return ids
}

function getSafeCodexSubagentIdentityCandidate(value: string | null, internalIds: ReadonlySet<string>): string | null {
    const candidate = value?.trim() || null
    if (!candidate || internalIds.has(candidate.toLowerCase())) return null
    return candidate
}

export function getCodexSubagentCardIdentity(tool: ToolCallBlock): string {
    const input = tool.tool.input
    const internalIds = getCodexSubagentInternalIds(tool)
    const agentPath = getTrimmedInputString(input, ['agent_path', 'agentPath'])
    const pathName = getSafeCodexSubagentIdentityCandidate(
        agentPath?.replace(/^\/root\//, '') ?? null,
        internalIds
    )
    if (pathName) return pathName

    const displayName = getSafeCodexSubagentIdentityCandidate(getTrimmedInputString(input, [
        'displayName',
        'display_name',
        'name',
        'nickname',
        'agentName',
        'agent_name'
    ]), internalIds)
    if (displayName) return displayName

    const spawnNickname = getSafeCodexSubagentIdentityCandidate(
        parseCodexSpawnAgentResult(tool.tool.result)?.nickname ?? null,
        internalIds
    )
    if (spawnNickname) return spawnNickname

    const role = getSafeCodexSubagentIdentityCandidate(getTrimmedInputString(input, [
        'agent_type',
        'subagent_type',
        'specialization',
        'specialty',
        'role',
        'type'
    ]), internalIds)
    if (role) return role

    const summary = getSafeCodexSubagentIdentityCandidate(getCodexAgentSummary(input), internalIds)
    if (summary) return summary

    return CODEX_SUBAGENT_FRIENDLY_NAMES[
        getStablePaletteIndex(tool.id || 'codex-agent', CODEX_SUBAGENT_FRIENDLY_NAMES.length)
    ]
}

export function getCodexSubagentCardColor(toolId: string): string {
    return CODEX_SUBAGENT_CARD_COLORS[
        getStablePaletteIndex(toolId || 'codex-agent', CODEX_SUBAGENT_CARD_COLORS.length)
    ]
}

/**
 * Keep cards distinct when their stable palette hashes collide. Sorting ids
 * makes the collision resolution independent of the source array order.
 */
export function assignCodexSubagentCardColors(toolIds: readonly string[]): ReadonlyMap<string, string> {
    const uniqueToolIds = [...new Set(toolIds)].sort()
    const assignments = new Map<string, string>()
    const usedColors = new Set<string>()

    for (const toolId of uniqueToolIds) {
        const preferredIndex = getStablePaletteIndex(toolId || 'codex-agent', CODEX_SUBAGENT_CARD_COLORS.length)
        let color = CODEX_SUBAGENT_CARD_COLORS[preferredIndex]
        if (usedColors.size < CODEX_SUBAGENT_CARD_COLORS.length) {
            for (let offset = 0; offset < CODEX_SUBAGENT_CARD_COLORS.length; offset += 1) {
                const candidate = CODEX_SUBAGENT_CARD_COLORS[
                    (preferredIndex + offset) % CODEX_SUBAGENT_CARD_COLORS.length
                ]
                if (!usedColors.has(candidate)) {
                    color = candidate
                    break
                }
            }
        }
        assignments.set(toolId, color)
        usedColors.add(color)
    }

    return assignments
}

export function getCodexSubagentCardState(state: unknown): ToolCallBlock['tool']['state'] {
    const normalized = typeof state === 'string' ? state.trim().toLowerCase() : ''
    if (normalized === 'completed') return 'completed'
    if (
        normalized === 'error'
        || normalized === 'failed'
        || normalized === 'cancelled'
        || normalized === 'canceled'
        || normalized === 'not-found'
        || normalized === 'not_found'
        || normalized === 'not found'
    ) {
        return 'error'
    }
    if (normalized === 'pending') return 'pending'
    return 'running'
}

function getCodexSubagentCardStatusLabel(
    state: ToolCallBlock['tool']['state'],
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    if (state === 'pending') return t('terminal.execution.pending')
    if (state === 'running') return t('terminal.execution.running')
    if (state === 'error') return t('terminal.execution.failed')
    return t('terminal.execution.completed')
}

function getCodexSubagentCardMetadata(
    tool: ToolCallBlock
): string | null {
    const configuration = getCodexAgentEffectiveConfiguration(tool.tool.input, tool.model)
    if (configuration.model) {
        return [configuration.model, configuration.reasoningEffort]
            .filter((value): value is string => value !== null)
            .join(' · ')
    }

    const activity = getCodexAgentActivity(tool.tool.input)
    return activity ? formatLiveProcessText(activity) : null
}

function CodexSubagentCards(props: {
    tools: ToolCallBlock[]
    onSelectTool: (toolId: string) => void
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    if (props.tools.length === 0) return null

    const colors = assignCodexSubagentCardColors(props.tools.map((tool) => tool.id))

    return (
        <div className="mt-2 flex flex-wrap gap-2" data-codex-subagent-cards>
            {props.tools.map((tool) => {
                const identity = getCodexSubagentCardIdentity(tool)
                const metadata = getCodexSubagentCardMetadata(tool)
                const state = getCodexSubagentCardState(tool.tool.state)
                const statusLabel = getCodexSubagentCardStatusLabel(state, props.t)
                const color = colors.get(tool.id) ?? getCodexSubagentCardColor(tool.id)

                return (
                    <button
                        key={tool.id}
                        type="button"
                        className="flex min-h-11 w-[calc((100%-0.5rem)/2)] max-w-[calc((100%-0.5rem)/2)] min-w-0 shrink-0 cursor-pointer flex-col items-start gap-1 rounded-xl border border-l-[3px] border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        style={{ borderLeftColor: color }}
                        onClick={() => props.onSelectTool(tool.id)}
                        aria-haspopup="dialog"
                        data-codex-subagent-card
                        data-codex-subagent-color={color}
                        data-codex-subagent-status={state}
                        data-tool-id={tool.id}
                    >
                        <span className="flex w-full min-w-0 items-center">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--app-fg)]" title={identity}>
                                {identity}
                            </span>
                        </span>
                        <span className="flex w-full min-w-0 items-center gap-1.5">
                            <span className={cn('shrink-0', toolStatusColorClass(state))} aria-hidden="true">
                                <ToolStatusIcon state={state} />
                            </span>
                            {metadata ? (
                                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--app-hint)]" title={metadata}>
                                    {metadata}
                                </span>
                            ) : null}
                            <span className="sr-only" role="status" aria-label={statusLabel} aria-live="polite" aria-atomic="true">
                                {statusLabel}
                            </span>
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

function SummaryBadge(props: { className: string; text: string }) {
    return (
        <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', props.className)}>
            {props.text}
        </span>
    )
}

function RowStatusBadge(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    const state = isTerminalExecutionTool(props.block.tool.name)
        ? getTerminalExecutionToolState(props.block)
        : props.block.tool.state
    if (state === 'error') {
        return <SummaryBadge className="bg-red-500/10 text-red-600" text={t('toolGroup.rowStatus.error')} />
    }
    if (state === 'running') {
        return <SummaryBadge className="bg-sky-500/10 text-sky-600" text={t('toolGroup.rowStatus.running')} />
    }
    if (state === 'pending') {
        return <SummaryBadge className="bg-amber-500/10 text-amber-700" text={t('toolGroup.rowStatus.pending')} />
    }
    return null
}

function formatActionSummary(block: ToolGroupBlock, t: (key: string, params?: Record<string, string | number>) => string): string | null {
    const parts: string[] = []
    const { countsByKind } = block.summary

    if (countsByKind.mutation > 0) {
        parts.push(t('toolGroup.summary.mutation', { n: countsByKind.mutation }))
    }
    if (countsByKind.read > 0) {
        parts.push(t('toolGroup.summary.read', { n: countsByKind.read }))
    }
    if (countsByKind.command > 0) {
        parts.push(t('toolGroup.summary.command', { n: countsByKind.command }))
    }
    if (countsByKind.search > 0) {
        parts.push(t('toolGroup.summary.search', { n: countsByKind.search }))
    }
    if (countsByKind.web > 0) {
        parts.push(t('toolGroup.summary.web', { n: countsByKind.web }))
    }
    if (countsByKind.other > 0 && parts.length > 0) {
        parts.push(t('toolGroup.summary.other', { n: countsByKind.other }))
    }

    return parts.length > 0 ? parts.join(' · ') : null
}

function CompactRowLabel(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }, t), [props.block, props.metadata, t])
    const kind = getToolGroupActionKind(props.block)
    const terminalIntent = isTerminalExecutionTool(props.block.tool.name)
        ? getTerminalCommandIntent(props.block.tool.input)
        : null
    const terminalCommandSummary = isTerminalExecutionTool(props.block.tool.name)
        ? getTerminalCommandSummary(props.block.tool.input)
        : null
    const isBatchRead = terminalIntent?.kind === 'read-request' && terminalIntent.targets.length > 1
    const isUnknownTerminal = isTerminalExecutionTool(props.block.tool.name)
        && terminalIntent === null
        && terminalCommandSummary === null
    const label = isUnknownTerminal
        ? t('terminal.execution.title')
        : isBatchRead
        ? t('toolGroup.compact.row.readBatch', { n: terminalIntent.targets.length })
        : terminalIntent
            ? getTerminalCommandIntentLabel(props.block.tool.input, terminalIntent, t)
            : terminalCommandSummary
                ? terminalCommandSummary
                : kind === 'command'
                    ? t('toolGroup.compact.row.command')
                    : kind === 'search'
                        ? t('toolGroup.compact.row.search')
                        : kind === 'read'
                            ? t('toolGroup.compact.row.read')
                            : kind === 'mutation'
                                ? t('toolGroup.compact.row.mutation')
                                : kind === 'web'
                                    ? t('toolGroup.compact.row.web')
                                    : presentation.title
    const detail = isUnknownTerminal
        ? null
        : terminalIntent || terminalCommandSummary
        ? terminalIntent && !isBatchRead
            ? getTerminalCommandIntentDetail(terminalIntent, t)
            : null
        : presentation.subtitle ?? (kind === 'other' ? null : presentation.title)

    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap text-[13px] leading-5">
                <span className="shrink-0 font-medium text-[var(--app-hint)]">{label}</span>
                {detail ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--app-tool-card-subtitle)]">
                        {detail}
                    </span>
                ) : null}
            </div>
        </div>
    )
}

function RowLabel(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }, t), [props.block, props.metadata, t])

    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                    {presentation.icon}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate whitespace-nowrap text-sm font-medium text-[var(--app-fg)]">
                        {presentation.title}
                    </div>
                    {presentation.subtitle ? (
                        <div className="truncate whitespace-nowrap font-mono text-xs text-[var(--app-tool-card-subtitle)]">
                            {presentation.subtitle}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function ToolGroupDetailSurface(props: {
    selectedTool: ToolCallBlock | null
    title: string
    metadata: SessionMetadataSummary | null
    onClose: () => void
}) {
    const lastTool = useRef(props.selectedTool)
    useEffect(() => { if (props.selectedTool) lastTool.current = props.selectedTool }, [props.selectedTool])
    const selectedTool = props.selectedTool ?? lastTool.current
    if (!selectedTool) return null

    if (isTerminalExecutionTool(selectedTool.tool.name)) {
        return (
            <TerminalExecutionDrawer
                block={selectedTool}
                open={props.selectedTool !== null}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) props.onClose()
                }}
            />
        )
    }

    const useFileMutationDialog = getFileMutationDialogSummary(selectedTool, props.metadata) !== null

    return (
        <ChatDetailDialog open={props.selectedTool !== null} onOpenChange={(nextOpen) => {
            if (!nextOpen) props.onClose()
        }}
            title={props.title}
            desktopClassName={cn('max-w-2xl', useFileMutationDialog ? FILE_MUTATION_DIALOG_CLASS_NAME : null)}
            header={<ToolDetailDialogHeader block={selectedTool} metadata={props.metadata} fallbackTitle={props.title} />}
        >
            <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
        </ChatDetailDialog>
    )
}

export function ToolGroupCard(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [unmanagedOpen, setUnmanagedOpen] = useState(() => (
        props.block.defaultOpen || (!props.block.forceCompact && isToolGroupActive(props.block))
    ))
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const [isHydratingHistory, setIsHydratingHistory] = useState(false)
    const [historyExhausted, setHistoryExhausted] = useState(false)
    const [retryNonce, setRetryNonce] = useState(0)
    const hasRunningTerminal = props.block.forceCompact === true && props.block.tools.some((tool) => (
        isTerminalExecutionTool(tool.tool.name)
        && (tool.tool.state === 'running' || tool.tool.state === 'pending')
    ))
    const [autoExpansionReady, setAutoExpansionReady] = useState(hasRunningTerminal)
    const hydrationRunRef = useRef(0)
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()
    const compactHeaderState = useContext(ToolGroupCompactHeaderContext)
    const compactMode = ctx.terminalToolDisplayMode === 'compact' || props.block.forceCompact === true
    const hasActiveTools = isToolGroupActive(props.block)
    const now = useSharedNow(compactMode && hasActiveTools)
    const requestsAutomaticExpansion = hasActiveTools && (
        hasRunningTerminal || props.block.defaultOpen || props.block.forceCompact !== true
    )
    const useExternalCompactHeader = compactMode && compactHeaderState?.groupId === props.block.id
    const expansionStateKeys = getToolGroupExpansionStateKeys(props.block)
    const primaryExpansionStateKey = getPrimaryToolGroupExpansionStateKey(props.block)
    const usesManagedExpansionState = ctx.setToolGroupExpansionState !== undefined
    const defaultExpansionState = getDefaultToolGroupExpansionState(
        requestsAutomaticExpansion && autoExpansionReady
    )
    const expansionState = resolveToolGroupExpansionState(
        props.block,
        ctx.toolGroupExpansionStates,
        defaultExpansionState
    )
    const managedOpen = isToolGroupExpansionOpen(expansionState)
    const displayedOpen = useExternalCompactHeader
        ? compactHeaderState.open
        : usesManagedExpansionState
            ? managedOpen
            : unmanagedOpen
    const externalSetOpen = compactHeaderState?.setOpen
    const setDisplayedOpen = useCallback((nextOpen: SetStateAction<boolean>) => {
        if (useExternalCompactHeader && externalSetOpen) {
            externalSetOpen(nextOpen)
            return
        }
        const resolvedOpen = typeof nextOpen === 'function'
            ? nextOpen(displayedOpen)
            : nextOpen
        if (usesManagedExpansionState) {
            ctx.setToolGroupExpansionState?.(
                primaryExpansionStateKey,
                resolvedOpen ? 'user-open' : 'user-closed'
            )
            return
        }
        setUnmanagedOpen(resolvedOpen)
    }, [ctx, displayedOpen, externalSetOpen, primaryExpansionStateKey, useExternalCompactHeader, usesManagedExpansionState])

    useEffect(() => {
        setAutoExpansionReady(hasRunningTerminal)
        if (hasRunningTerminal) {
            return
        }
        if (!requestsAutomaticExpansion) {
            return
        }
        const timer = setTimeout(() => {
            setAutoExpansionReady(true)
        }, 3_000)
        return () => clearTimeout(timer)
    }, [hasRunningTerminal, props.block.id, requestsAutomaticExpansion])

    useEffect(() => {
        if (!usesManagedExpansionState) {
            return
        }
        if (expansionStateKeys.some((key) => ctx.toolGroupExpansionStates?.[key] !== undefined)) {
            return
        }
        ctx.setToolGroupExpansionState?.(primaryExpansionStateKey, defaultExpansionState)
    }, [ctx, defaultExpansionState, expansionStateKeys, primaryExpansionStateKey, usesManagedExpansionState])

    // Do not flash open for sub-second work. Once the active group has stayed
    // visible for three full seconds, promote only untouched automatic state.
    useEffect(() => {
        if (!usesManagedExpansionState || !autoExpansionReady || !requestsAutomaticExpansion) {
            return
        }
        const states = expansionStateKeys.map((key) => ctx.toolGroupExpansionStates?.[key])
        if (states.some((state) => state === 'user-open' || state === 'user-closed')) {
            return
        }
        if (states.some((state) => state === 'auto-open')) {
            return
        }
        ctx.setToolGroupExpansionState?.(primaryExpansionStateKey, 'auto-open')
    }, [
        autoExpansionReady,
        ctx,
        expansionStateKeys,
        primaryExpansionStateKey,
        requestsAutomaticExpansion,
        usesManagedExpansionState,
    ])

    // A live process becomes a historical Processed card as the next snapshot
    // arrives. Close only automatic expansion; an explicit user choice stays.
    useEffect(() => {
        if (!usesManagedExpansionState || defaultExpansionState !== 'auto-closed') {
            return
        }
        const autoOpenKeys = expansionStateKeys.filter((key) => (
            ctx.toolGroupExpansionStates?.[key] === 'auto-open'
        ))
        for (const key of autoOpenKeys) {
            ctx.setToolGroupExpansionState?.(key, 'auto-closed')
        }
    }, [ctx, defaultExpansionState, expansionStateKeys, usesManagedExpansionState])

    function clearRetryTimer() {
        if (retryTimerRef.current === null) {
            return
        }
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
    }

    useEffect(() => {
        clearRetryTimer()
        hydrationRunRef.current += 1
        setSelectedToolId(null)
        setIsHydratingHistory(false)
        setHistoryExhausted(false)
    }, [
        props.block.id
    ])

    useEffect(() => {
        return () => {
            clearRetryTimer()
        }
    }, [])

    useEffect(() => {
        if (!displayedOpen) {
            clearRetryTimer()
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(false)
            return
        }
        if (!props.block.needsOlderHistory) {
            clearRetryTimer()
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(false)
            return
        }
        if (isHydratingHistory || historyExhausted) {
            return
        }
        if (ctx.isLoadingMoreMessages) {
            return
        }
        if (!ctx.hasMoreMessages) {
            hydrationRunRef.current += 1
            setIsHydratingHistory(false)
            setHistoryExhausted(true)
            return
        }

        const runId = hydrationRunRef.current + 1
        hydrationRunRef.current = runId
        setHistoryExhausted(false)
        setIsHydratingHistory(true)
        void ctx.loadOlderMessagesPreservingScroll()
            .then((loaded) => {
                if (hydrationRunRef.current !== runId) return
                setIsHydratingHistory(false)
                if (!loaded) {
                    if (!ctx.hasMoreMessages) {
                        setHistoryExhausted(true)
                        return
                    }
                    clearRetryTimer()
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null
                        if (hydrationRunRef.current !== runId) return
                        setRetryNonce((value) => value + 1)
                    }, 150)
                }
            })
            .catch(() => {
                if (hydrationRunRef.current !== runId) return
                clearRetryTimer()
                setIsHydratingHistory(false)
                setHistoryExhausted(true)
            })
    }, [
        displayedOpen,
        props.block.needsOlderHistory,
        ctx.hasMoreMessages,
        ctx.isLoadingMoreMessages,
        ctx.loadOlderMessagesPreservingScroll,
        historyExhausted,
        isHydratingHistory,
        retryNonce,
    ])

    const selectedTool = useMemo(
        () => props.block.tools.find((tool) => tool.id === selectedToolId) ?? null,
        [props.block.tools, selectedToolId]
    )
    const selectedPresentation = useMemo(() => {
        if (!selectedTool) return null
        return getToolPresentation({
            toolName: selectedTool.tool.name,
            input: selectedTool.tool.input,
            result: selectedTool.tool.result,
            childrenCount: selectedTool.children.length,
            description: selectedTool.tool.description,
            metadata: props.metadata
        }, t)
    }, [selectedTool, props.metadata, t])
    const codexSubagentTools = useMemo(() => props.block.tools
        .map((tool, index) => ({ tool, index }))
        .filter(({ tool }) => tool.tool.name === 'CodexAgent')
        .sort((left, right) => (
            (left.tool.tool.startedAt ?? left.tool.tool.createdAt) - (right.tool.tool.startedAt ?? right.tool.tool.createdAt)
            || left.tool.createdAt - right.tool.createdAt
            || left.index - right.index
        ))
        .map(({ tool }) => tool), [props.block.tools])
    const codexSubagentToolIds = useMemo(
        () => new Set(codexSubagentTools.map((tool) => tool.id)),
        [codexSubagentTools]
    )
    const compactDetailBlocks = useMemo(() => {
        const blocks = props.block.detailBlocks && props.block.detailBlocks.length > 0
            ? props.block.detailBlocks
            : props.block.tools
        return blocks.filter((block) => (
            block.kind !== 'tool-call'
            || block.tool.name !== 'CodexAgent'
            || !codexSubagentToolIds.has(block.id)
        ))
    }, [codexSubagentToolIds, props.block.detailBlocks, props.block.tools])

    const primaryTitle = formatGroupedHeaderTitle(props.block, t)
    const subtitle = formatGroupedHeaderSubtitle(props.block, t) ?? formatActionSummary(props.block, t)
    const fileCount = props.block.summary.fileTargets.length
    const compactTitle = formatToolGroupCompactTitle(props.block, now, t)
    const toggleOpen = () => {
        setDisplayedOpen((value) => !value)
    }

    if (compactMode) {
        return (
            <div className={cn('overflow-hidden bg-transparent', useExternalCompactHeader ? 'py-0' : 'py-1')}>
                {!useExternalCompactHeader ? (
                    <button
                        type="button"
                        onClick={toggleOpen}
                        className={cn(
                            'flex min-h-9 w-full items-center gap-1.5 rounded-md px-0.5 py-1 text-left text-[13px] font-medium leading-5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                            suppressFocusRing && 'focus-visible:ring-0'
                        )}
                        onPointerDown={onTriggerPointerDown}
                        onKeyDown={onTriggerKeyDown}
                        onBlur={onTriggerBlur}
                        aria-expanded={displayedOpen}
                    >
                        {props.block.showAgentIcon ? (
                            <AgentFlavorIcon
                                flavor={ctx.metadata?.flavor}
                                className={cn(
                                    'h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]',
                                    hasActiveTools && 'motion-safe:animate-pulse'
                                )}
                            />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate">{compactTitle}</span>
                        <span className="shrink-0 text-[var(--app-hint)]">
                            <DetailsIcon open={displayedOpen} />
                        </span>
                    </button>
                ) : null}

                <CodexSubagentCards
                    tools={codexSubagentTools}
                    onSelectTool={setSelectedToolId}
                    t={t}
                />

                {displayedOpen ? (
                    <div className={cn('relative ml-[7px] flex flex-col gap-0.5', useExternalCompactHeader ? 'mt-0.5' : 'mt-1')}>
                        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--app-divider)]" data-tool-group-timeline />
                        {compactDetailBlocks.map((block, index) => (
                            <CompactDetailItem
                                key={`detail:${block.kind}:${block.id}:${index}`}
                                block={block}
                                metadata={props.metadata}
                                onSelectTool={setSelectedToolId}
                            />
                        ))}

                        {isHydratingHistory ? (
                            <div className="pl-[15px] text-xs text-[var(--app-hint)]">
                                {t('toolGroup.loadingOlderHistory')}
                            </div>
                        ) : null}
                        {!isHydratingHistory && historyExhausted && props.block.needsOlderHistory ? (
                            <div className="pl-[15px] text-xs text-[var(--app-hint)]">
                                {t('toolGroup.historyUnavailable')}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                <ToolGroupDetailSurface
                    selectedTool={selectedTool}
                    title={selectedTool?.tool.name === 'CodexAgent'
                        ? getCodexSubagentCardIdentity(selectedTool)
                        : selectedPresentation?.title ?? selectedTool?.tool.name ?? ''}
                    metadata={props.metadata}
                    onClose={() => setSelectedToolId(null)}
                />
            </div>
        )
    }

    return (
        <Card className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-tool-group-bg)] shadow-none">
            <CardHeader className={cn('space-y-0 p-3', subtitle ? 'pb-2' : null)}>
                <button
                    type="button"
                    onClick={toggleOpen}
                    className={cn(
                        'w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                        suppressFocusRing && 'focus-visible:ring-0'
                    )}
                    onPointerDown={onTriggerPointerDown}
                    onKeyDown={onTriggerKeyDown}
                    onBlur={onTriggerBlur}
                    aria-expanded={displayedOpen}
                >
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex flex-1 flex-col gap-1">
                            <div className="min-w-0 flex items-center gap-2">
                                <div className="shrink-0 flex h-3.5 w-3.5 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                                    <DetailsIcon open={displayedOpen} />
                                </div>
                                <CardTitle className="min-w-0 truncate whitespace-nowrap text-sm font-medium leading-tight text-[var(--app-fg)]">
                                    {primaryTitle}
                                </CardTitle>
                            </div>
                            {subtitle ? (
                                <CardDescription className="truncate whitespace-nowrap font-mono text-xs text-[var(--app-tool-card-subtitle)]">
                                    {subtitle}
                                </CardDescription>
                            ) : null}
                        </div>

                        <div className="flex shrink-0 items-center gap-2 self-center text-[var(--app-hint)]">
                            <SummaryBadge
                                className="bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                                text={t('toolGroup.toolCount', { n: props.block.tools.length })}
                            />
                            {props.block.summary.runningCount > 0 ? (
                                <SummaryBadge
                                    className="bg-sky-500/10 text-sky-600"
                                    text={t('toolGroup.badge.running', { n: props.block.summary.runningCount })}
                                />
                            ) : null}
                            {props.block.summary.pendingCount > 0 ? (
                                <SummaryBadge
                                    className="bg-amber-500/10 text-amber-700"
                                    text={t('toolGroup.badge.pending', { n: props.block.summary.pendingCount })}
                                />
                            ) : null}
                            {props.block.summary.errorCount > 0 ? (
                                <SummaryBadge
                                    className="bg-red-500/10 text-red-600"
                                    text={t('toolGroup.badge.error', { n: props.block.summary.errorCount })}
                                />
                            ) : null}
                            {fileCount > 0 ? (
                                <SummaryBadge
                                    className="bg-[var(--app-subtle-bg)] text-[var(--app-hint)]"
                                    text={t('toolGroup.badge.fileTargets', { n: fileCount })}
                                />
                            ) : null}
                        </div>
                    </div>
                </button>
            </CardHeader>

            {displayedOpen ? (
                <CardContent className="px-3 pb-3 pt-1">
                    <div className="flex flex-col gap-2">
                        {props.block.tools.map((tool) => {
                            const displayedToolState = isTerminalExecutionTool(tool.tool.name)
                                ? getTerminalExecutionToolState(tool)
                                : tool.tool.state
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    className="flex items-center gap-3 rounded-[12px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    onClick={() => setSelectedToolId(tool.id)}
                                >
                                    <span className={cn('shrink-0', toolStatusColorClass(displayedToolState))}>
                                        <ToolStatusIcon state={displayedToolState} />
                                    </span>
                                    <RowLabel block={tool} metadata={props.metadata} />
                                    <div className="flex shrink-0 items-center gap-2">
                                        <RowStatusBadge block={tool} />
                                    </div>
                                </button>
                            )
                        })}
                    </div>

                    {isHydratingHistory ? (
                        <div className="mt-3 text-xs text-[var(--app-hint)]">
                            {t('toolGroup.loadingOlderHistory')}
                        </div>
                    ) : null}
                    {!isHydratingHistory && historyExhausted && props.block.needsOlderHistory ? (
                        <div className="mt-3 text-xs text-[var(--app-hint)]">
                            {t('toolGroup.historyUnavailable')}
                        </div>
                    ) : null}
                </CardContent>
            ) : null}

            <ToolGroupDetailSurface
                selectedTool={selectedTool}
                title={selectedTool?.tool.name === 'CodexAgent'
                    ? getCodexSubagentCardIdentity(selectedTool)
                    : selectedPresentation?.title ?? selectedTool?.tool.name ?? ''}
                metadata={props.metadata}
                onClose={() => setSelectedToolId(null)}
            />
        </Card>
    )
}
