import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { getToolGroupActionKind, type ToolGroupBlock } from '@/chat/toolGroups'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { ToolDetailDialogContent, ToolStatusIcon, toolStatusColorClass } from '@/components/ToolCard/ToolCard'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { extractTextFromResult } from '@/components/ToolCard/views/_results'
import { formatGroupedHeaderSubtitle, formatGroupedHeaderTitle } from '@/components/ToolCard/groupedPresentation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getEventPresentation } from '@/chat/presentation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { getInputStringAny } from '@/lib/toolInputUtils'
import {
    getDefaultToolGroupExpansionState,
    getPrimaryToolGroupExpansionStateKey,
    getToolGroupExpansionStateKeys,
    isToolGroupExpansionOpen,
    resolveToolGroupExpansionState
} from '@/components/ToolCard/toolGroupExpansion'

const COMPACT_ELAPSED_INTERVAL_MS = 1000

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

function getToolEndMs(tool: ToolCallBlock, now: number): number {
    if (tool.tool.state === 'running' || tool.tool.state === 'pending') {
        return now
    }
    return tool.tool.completedAt ?? tool.tool.startedAt ?? tool.tool.createdAt
}

export function isToolGroupActive(block: ToolGroupBlock): boolean {
    return block.tools.some((tool) => tool.tool.state === 'running' || tool.tool.state === 'pending')
}

export function getToolGroupDurationMs(block: ToolGroupBlock, now: number): number {
    if (block.tools.length === 0) {
        return 0
    }

    const startedAt = Math.min(...block.tools.map(getToolStartMs))
    const endedAt = Math.max(...block.tools.map((tool) => getToolEndMs(tool, now)))
    return Math.max(0, endedAt - startedAt)
}

export function formatCompactDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
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

const SKILL_NAME_RE = /(?:skill|技能)\s*[:：]?\s*[$`]?([A-Za-z][\w-]{1,50})/i
const USE_SKILL_RE = /(?:使用|用|using|use)\s+[$`]?([A-Za-z][\w-]{1,50})(?=\s*[:：,，。.]|\s|$)/i
const IGNORED_SKILL_WORDS = new Set(['skill', 'tool', 'tools', 'function', 'mode', 'builtin'])

function normalizeDetectedSkillName(value: string | null): string | null {
    const normalized = value?.trim().replace(/^[$`]+|[`]+$/g, '') ?? ''
    if (!normalized) return null
    if (IGNORED_SKILL_WORDS.has(normalized.toLowerCase())) return null
    return normalized
}

function detectSkillNameFromText(text: string): string | null {
    const explicit = normalizeDetectedSkillName(text.match(SKILL_NAME_RE)?.[1] ?? null)
    if (explicit) return explicit

    return normalizeDetectedSkillName(text.match(USE_SKILL_RE)?.[1] ?? null)
}

function getToolGroupSkillName(block: ToolGroupBlock): string | null {
    for (const tool of block.tools) {
        if (tool.tool.name !== 'Skill') continue
        const skill = normalizeDetectedSkillName(getInputStringAny(tool.tool.input, ['skill', 'name']))
        if (skill) return skill
    }

    for (const detail of block.detailBlocks ?? []) {
        if (detail.kind === 'generated-image') return 'imagegen'
        if (detail.kind === 'tool-call' && detail.tool.name === 'Skill') {
            const skill = normalizeDetectedSkillName(getInputStringAny(detail.tool.input, ['skill', 'name']))
            if (skill) return skill
        }
        if (detail.kind === 'agent-text' || detail.kind === 'agent-reasoning') {
            const skill = detectSkillNameFromText(detail.text)
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

export function formatToolGroupCompactTitle(
    block: ToolGroupBlock,
    now: number,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    const active = isToolGroupActive(block)
    const durationMs = getToolGroupDurationMs(block, now)
    const renderedDuration = formatCompactDuration(durationMs)
    const skillName = getToolGroupSkillName(block)
    if (skillName) {
        return active
            ? t('toolGroup.compact.skill.processing', { skill: skillName, duration: renderedDuration }).trim()
            : t('toolGroup.compact.skill.processed', { skill: skillName, duration: renderedDuration }).trim()
    }

    const singleTool = !block.forceGenericCompactTitle && block.tools.length === 1 ? block.tools[0] : null
    if (singleTool) {
        const status = active ? 'processing' : 'processed'
        const kind = getToolGroupActionKind(singleTool)
        if (kind === 'mutation') {
            const fileTarget = getCompactFileTarget(singleTool)
            if (fileTarget) {
                return t(`toolGroup.compact.single.${status}.mutationTarget`, {
                    target: formatCompactRawText(fileTarget),
                    duration: renderedDuration
                }).trim()
            }

            const command = getCompactRawCommand(singleTool)
            if (command) {
                return t(`toolGroup.compact.single.${status}.commandFallback`, {
                    command: formatCompactRawText(command),
                    duration: renderedDuration
                }).trim()
            }
        }
        if (kind !== 'other') {
            return t(`toolGroup.compact.single.${status}.${kind}`, { duration: renderedDuration }).trim()
        }
    }

    return active
        ? t('toolGroup.compact.processing', { duration: renderedDuration }).trim()
        : t('toolGroup.compact.processed', { duration: renderedDuration }).trim()
}

function CompactDetailBlock(props: { block: Exclude<NonNullable<ToolGroupBlock['detailBlocks']>[number], ToolCallBlock> }) {
    const block = props.block

    if (block.kind === 'agent-text') {
        return (
            <div className="min-w-0 whitespace-pre-wrap text-base leading-7 text-[var(--app-fg)]">
                {block.text}
            </div>
        )
    }

    if (block.kind === 'agent-reasoning') {
        return (
            <div className="min-w-0 whitespace-pre-wrap text-base leading-7 text-[var(--app-hint)]">
                {block.text}
            </div>
        )
    }

    if (block.kind === 'cli-output') {
        return <CliOutputBlock text={block.text} />
    }

    if (block.kind === 'agent-event') {
        const presentation = getEventPresentation(block.event)
        return (
            <div className="text-sm text-[var(--app-hint)]">
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
        return (
            <CompactToolActionRow
                block={block}
                metadata={props.metadata}
                onSelectTool={props.onSelectTool}
            />
        )
    }

    return <CompactDetailBlock block={block} />
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
    if (props.block.tool.state === 'error') {
        return <SummaryBadge className="bg-red-500/10 text-red-600" text={t('toolGroup.rowStatus.error')} />
    }
    if (props.block.tool.state === 'running') {
        return <SummaryBadge className="bg-sky-500/10 text-sky-600" text={t('toolGroup.rowStatus.running')} />
    }
    if (props.block.tool.state === 'pending') {
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
    const usesActionLabel = props.block.tool.state !== 'error'
    const label = usesActionLabel
        ? kind === 'command'
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
        : presentation.title
    const rawError = props.block.tool.state === 'error'
        ? extractTextFromResult(props.block.tool.result)
        : null
    const errorSummary = rawError
        ? rawError.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
        : null
    const detail = errorSummary ?? presentation.subtitle ?? (kind === 'other' ? null : presentation.title)

    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-sm leading-6">
                <span className="shrink-0 font-medium text-[var(--app-hint)]">{label}</span>
                {detail ? (
                    <>
                        <span aria-hidden="true" className="shrink-0 text-[var(--app-tool-card-subtitle)]">•</span>
                        <span
                            data-tool-action-summary
                            className={cn(
                                'min-w-0 flex-1 truncate font-mono text-[0.9em]',
                                errorSummary ? 'text-red-600' : 'text-[var(--app-tool-card-subtitle)]'
                            )}
                        >
                            {formatCompactRawText(detail)}
                        </span>
                    </>
                ) : null}
            </div>
        </div>
    )
}

function CompactToolActionIcon(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }, t), [props.block, props.metadata, t])
    const useStateIcon = props.block.tool.state === 'error' || props.block.tool.state === 'pending'

    return (
        <span
            aria-hidden="true"
            className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center',
                useStateIcon ? toolStatusColorClass(props.block.tool.state) : 'text-[var(--app-tool-card-accent)]'
            )}
        >
            {useStateIcon ? <ToolStatusIcon state={props.block.tool.state} /> : presentation.icon}
        </span>
    )
}

function CompactToolActionRow(props: {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
    onSelectTool: (toolId: string) => void
}) {
    return (
        <button
            type="button"
            data-tool-action-row
            data-state={props.block.tool.state}
            className="hapi-tool-action-row group relative flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            onClick={() => props.onSelectTool(props.block.id)}
        >
            <CompactToolActionIcon block={props.block} metadata={props.metadata} />
            <CompactRowLabel block={props.block} metadata={props.metadata} />
            <RowStatusBadge block={props.block} />
        </button>
    )
}

function getCompactGroupState(block: ToolGroupBlock): ToolCallBlock['tool']['state'] {
    if (block.tools.some((tool) => tool.tool.state === 'running')) return 'running'
    if (block.tools.some((tool) => tool.tool.state === 'pending')) return 'pending'
    if (block.tools.some((tool) => tool.tool.state === 'error')) return 'error'
    return 'completed'
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

export function ToolGroupCard(props: {
    block: ToolGroupBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const ctx = useHappyChatContext()
    const [unmanagedOpen, setUnmanagedOpen] = useState(() => props.block.defaultOpen || isToolGroupActive(props.block))
    const [selectedToolId, setSelectedToolId] = useState<string | null>(null)
    const [isHydratingHistory, setIsHydratingHistory] = useState(false)
    const [historyExhausted, setHistoryExhausted] = useState(false)
    const [retryNonce, setRetryNonce] = useState(0)
    const [now, setNow] = useState(() => Date.now())
    const hydrationRunRef = useRef(0)
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()
    const compactHeaderState = useContext(ToolGroupCompactHeaderContext)
    const compactMode = ctx.terminalToolDisplayMode === 'compact'
    const hasActiveTools = isToolGroupActive(props.block)
    const useExternalCompactHeader = compactMode && compactHeaderState?.groupId === props.block.id
    const expansionStateKeys = getToolGroupExpansionStateKeys(props.block)
    const primaryExpansionStateKey = getPrimaryToolGroupExpansionStateKey(props.block)
    const usesManagedExpansionState = ctx.setToolGroupExpansionState !== undefined
    const defaultExpansionState = getDefaultToolGroupExpansionState(
        props.block.defaultOpen || ctx.toolGroupRunActive === true || hasActiveTools
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
        if (!usesManagedExpansionState) {
            return
        }
        if (expansionStateKeys.some((key) => ctx.toolGroupExpansionStates?.[key] !== undefined)) {
            return
        }
        ctx.setToolGroupExpansionState?.(primaryExpansionStateKey, defaultExpansionState)
    }, [ctx, defaultExpansionState, expansionStateKeys, primaryExpansionStateKey, usesManagedExpansionState])

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
        if (!compactMode || !hasActiveTools) {
            return
        }
        setNow(Date.now())
        const interval = setInterval(() => setNow(Date.now()), COMPACT_ELAPSED_INTERVAL_MS)
        return () => clearInterval(interval)
    }, [compactMode, hasActiveTools])

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

    const primaryTitle = formatGroupedHeaderTitle(props.block, t)
    const subtitle = formatGroupedHeaderSubtitle(props.block, t) ?? formatActionSummary(props.block, t)
    const fileCount = props.block.summary.fileTargets.length
    const compactTitle = formatToolGroupCompactTitle(props.block, now, t)
    const compactGroupState = getCompactGroupState(props.block)
    const toggleOpen = () => {
        setDisplayedOpen((value) => !value)
    }

    if (compactMode) {
        return (
            <div className={cn('overflow-hidden bg-transparent', useExternalCompactHeader ? 'py-0' : 'py-2')}>
                {!useExternalCompactHeader ? (
                    <button
                        type="button"
                        onClick={toggleOpen}
                        data-tool-action-row
                        data-state={compactGroupState}
                        className={cn(
                            'hapi-tool-action-row group relative flex min-h-10 w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left text-sm font-medium leading-6 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                            suppressFocusRing && 'focus-visible:ring-0'
                        )}
                        onPointerDown={onTriggerPointerDown}
                        onKeyDown={onTriggerKeyDown}
                        onBlur={onTriggerBlur}
                        aria-expanded={displayedOpen}
                    >
                        {props.block.showAgentIcon ? (
                            <AgentFlavorIcon flavor={ctx.metadata?.flavor} className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                        ) : (
                            <span aria-hidden="true" className={cn('flex h-4 w-4 shrink-0 items-center justify-center', toolStatusColorClass(compactGroupState))}>
                                <ToolStatusIcon state={compactGroupState} />
                            </span>
                        )}
                        <span className="min-w-0 flex-1 truncate">{compactTitle}</span>
                        <span className="shrink-0 text-[var(--app-hint)] opacity-55 transition-opacity group-hover:opacity-100">
                            <DetailsIcon open={displayedOpen} />
                        </span>
                    </button>
                ) : null}

                {displayedOpen ? (
                    <div className={cn('flex flex-col gap-2', useExternalCompactHeader ? 'mt-1' : 'mt-3')}>
                        {props.block.detailBlocks && props.block.detailBlocks.length > 0 ? (
                            props.block.detailBlocks.map((block, index) => (
                                <CompactDetailItem
                                    key={`detail:${block.kind}:${block.id}:${index}`}
                                    block={block}
                                    metadata={props.metadata}
                                    onSelectTool={setSelectedToolId}
                                />
                            ))
                        ) : (
                            props.block.tools.map((tool) => (
                                <CompactToolActionRow
                                    key={tool.id}
                                    block={tool}
                                    metadata={props.metadata}
                                    onSelectTool={setSelectedToolId}
                                />
                            ))
                        )}

                        {isHydratingHistory ? (
                            <div className="text-xs text-[var(--app-hint)]">
                                {t('toolGroup.loadingOlderHistory')}
                            </div>
                        ) : null}
                        {!isHydratingHistory && historyExhausted && props.block.needsOlderHistory ? (
                            <div className="text-xs text-[var(--app-hint)]">
                                {t('toolGroup.historyUnavailable')}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                <Dialog open={selectedTool !== null} onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                        setSelectedToolId(null)
                    }
                }}>
                    <DialogContent className="max-w-2xl" aria-describedby={undefined}>
                        {selectedTool && selectedPresentation ? (
                            <>
                                <DialogHeader>
                                    <DialogTitle>{selectedPresentation.title}</DialogTitle>
                                </DialogHeader>
                                <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
                            </>
                        ) : null}
                    </DialogContent>
                </Dialog>
            </div>
        )
    }

    return (
        <Card className="overflow-hidden rounded-[20px] bg-[var(--app-tool-group-bg)] shadow-none">
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
                            return (
                                <button
                                    key={tool.id}
                                    type="button"
                                    className="flex items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    onClick={() => setSelectedToolId(tool.id)}
                                >
                                    <span className={cn('shrink-0', toolStatusColorClass(tool.tool.state))}>
                                        <ToolStatusIcon state={tool.tool.state} />
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

            <Dialog open={selectedTool !== null} onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    setSelectedToolId(null)
                }
            }}>
                <DialogContent className="max-w-2xl" aria-describedby={undefined}>
                    {selectedTool && selectedPresentation ? (
                        <>
                            <DialogHeader>
                                <DialogTitle>{selectedPresentation.title}</DialogTitle>
                            </DialogHeader>
                            <ToolDetailDialogContent block={selectedTool} metadata={props.metadata} />
                        </>
                    ) : null}
                </DialogContent>
            </Dialog>
        </Card>
    )
}
