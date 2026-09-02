import type { ToolCallBlock } from '@/chat/types'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import { memo, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { isObject, safeStringify } from '@hapi/protocol'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { AskUserQuestionFooter } from '@/components/ToolCard/AskUserQuestionFooter'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getToolFullViewComponent, getToolViewComponent } from '@/components/ToolCard/views/_all'
import { getToolResultViewComponent } from '@/components/ToolCard/views/_results'
import { formatTaskChildLabel, TaskStateIcon } from '@/components/ToolCard/helpers'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { usePointerFocusRing } from '@/hooks/usePointerFocusRing'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { TraceSection } from '@/components/ToolCard/trace'
import { isSubagentToolName } from '@/chat/subagentTool'
import { formatTerminalExecutionDuration, getTerminalExecutionToolState, isTerminalExecutionTool, TerminalExecutionDetail } from '@/components/ToolCard/terminalExecution'
import { TerminalExecutionDrawer } from '@/components/ToolCard/TerminalExecutionDrawer'
import { getTerminalReadRequest } from '@/components/ToolCard/fileAccess'
import { getFileMutationDialogSummary } from '@/components/ToolCard/fileMutationDetail'

const ELAPSED_INTERVAL_MS = 1000

export const FILE_MUTATION_DIALOG_CLASS_NAME = 'flex h-[60dvh] max-h-[60dvh] flex-col overflow-hidden sm:h-[min(75dvh,50rem)] sm:max-h-[calc(100dvh-2rem)]'

export function shouldUseCompactTerminalToolCard(toolName: string, terminalToolDisplayMode: TerminalToolDisplayMode): boolean {
    return isTerminalExecutionTool(toolName) && terminalToolDisplayMode === 'compact'
}

export function shouldShowInlineToolCardBody(
    toolName: string,
    presentationMinimal: boolean
): boolean {
    if (isSubagentToolName(toolName)) return false
    // Terminal command/output is log-like content. Keep it out of the
    // message flow for every display mode; its only full-detail surface is
    // the terminal modal.
    if (isTerminalExecutionTool(toolName)) return false
    return !presentationMinimal
}

function ElapsedView(props: { from: number; active: boolean }) {
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!props.active) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), ELAPSED_INTERVAL_MS)
        return () => clearInterval(id)
    }, [props.active, props.from])

    if (!props.active) return null

    const elapsed = Math.max(0, now - props.from) / 1000
    if (!Number.isFinite(elapsed)) return null

    return (
        <span className="font-mono text-xs text-[var(--app-hint)]">
            {elapsed.toFixed(1)}s
        </span>
    )
}

function isActivityToolCard(block: ToolCallBlock): boolean {
    return block.tool.name.startsWith('mcp__')
        || block.tool.name === 'Skill'
        || block.tool.name === 'CodexBash' && getTerminalReadRequest(block.tool.input) !== null
}

function getActivityToolStatusLabel(
    state: ToolCallBlock['tool']['state'],
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    if (state === 'pending') return t('terminal.execution.pending')
    if (state === 'running') return t('terminal.execution.running')
    if (state === 'error') return t('terminal.execution.failed')
    return t('terminal.execution.completed')
}

function getActivityToolDurationMs(block: ToolCallBlock, now: number): number {
    const startedAt = block.tool.startedAt ?? block.tool.createdAt
    const active = block.tool.state === 'pending' || block.tool.state === 'running'
    const recordedDurationMs = typeof block.tool.durationMs === 'number' && Number.isFinite(block.tool.durationMs)
        ? Math.max(0, block.tool.durationMs)
        : typeof block.durationMs === 'number' && Number.isFinite(block.durationMs)
            ? Math.max(0, block.durationMs)
            : null
    if (!active && recordedDurationMs !== null) {
        return recordedDurationMs
    }
    const completedAt = active
        ? now
        : block.tool.completedAt ?? startedAt
    return Math.max(0, completedAt - startedAt)
}

function ActivityToolTiming(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    const active = props.block.tool.state === 'pending' || props.block.tool.state === 'running'
    const startedAt = props.block.tool.startedAt ?? props.block.tool.createdAt
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!active) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), ELAPSED_INTERVAL_MS)
        return () => clearInterval(id)
    }, [active, startedAt])

    const duration = formatTerminalExecutionDuration(getActivityToolDurationMs(props.block, now)) ?? '0.0s'
    const state = props.block.tool.state
    const stateColor = toolStatusColorClass(state)

    return (
        <span
            aria-label={`${getActivityToolStatusLabel(state, t)} ${duration}`}
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11px]"
            data-activity-tool-timing
            role="status"
        >
            <span className="text-[var(--app-hint)]">{duration}</span>
            <span aria-hidden="true" className={stateColor}><ToolStatusIcon state={state} /></span>
        </span>
    )
}

function getTaskSummaryChildren(block: ToolCallBlock): { visible: ToolCallBlock[]; remaining: number } | null {
    if (!isSubagentToolName(block.tool.name)) return null

    const children = block.children
        .filter((child): child is ToolCallBlock => child.kind === 'tool-call')
        .filter((child) => child.tool.state === 'pending' || child.tool.state === 'running' || child.tool.state === 'completed' || child.tool.state === 'error')

    if (children.length === 0) return null

    const visible = children.slice(-3)
    return { visible, remaining: children.length - visible.length }
}

function renderTaskSummary(
    block: ToolCallBlock,
    metadata: SessionMetadataSummary | null,
    t: (key: string, params?: Record<string, string | number>) => string,
): ReactNode | null {
    const summary = getTaskSummaryChildren(block)
    if (!summary) return null

    const visible = summary.visible
    const remaining = summary.remaining

    return (
        <div className="flex flex-col gap-1 px-1">
            <div className="flex flex-col gap-1">
                {visible.map((child) => (
                    <div key={child.id} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 font-mono text-xs text-[var(--app-hint)]">
                            <span className="mr-2 inline-block w-4 text-center align-middle">
                                <TaskStateIcon state={child.tool.state} />
                            </span>
                            <span className="align-middle break-all">
                                {formatTaskChildLabel(child, metadata, t)}
                            </span>
                        </div>
                    </div>
                ))}
                {remaining > 0 ? (
                    <div className="text-xs text-[var(--app-hint)] italic">
                        (+{remaining} more)
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function renderToolInput(block: ToolCallBlock, surface: 'inline' | 'dialog' = 'inline'): ReactNode {
    const collapseLongContent = surface === 'inline'
    const codeBlockSurfaceProps = surface === 'dialog'
        ? { size: 'comfortable' as const, scrollY: true }
        : {}
    const toolName = block.tool.name
    const input = block.tool.input

    if (isSubagentToolName(toolName) && isObject(input) && typeof input.prompt === 'string') {
        return <MarkdownRenderer content={input.prompt} />
    }

    const commandArray = isObject(input) && Array.isArray(input.command) ? input.command : null
    if ((toolName === 'CodexBash' || toolName === 'Bash') && (typeof commandArray?.[0] === 'string' || typeof input === 'object')) {
        const cmd = Array.isArray(commandArray)
            ? commandArray.filter((part) => typeof part === 'string').join(' ')
            : getInputStringAny(input, ['command', 'cmd'])
        if (cmd) {
            return <CodeBlock code={cmd} language="bash" title="Command" collapseLongContent={collapseLongContent} {...codeBlockSurfaceProps} />
        }
    }

    return <CodeBlock code={safeStringify(input)} language="json" title="Input" collapseLongContent={collapseLongContent} {...codeBlockSurfaceProps} />
}

export function ToolStatusIcon(props: { state: ToolCallBlock['tool']['state'] }) {
    if (props.state === 'completed') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.2 8.3l1.8 1.8 3.8-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        )
    }
    if (props.state === 'error') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    }
    if (props.state === 'pending') {
        return (
            <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                <rect x="4.5" y="7" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6 7V5.8a2 2 0 0 1 4 0V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
        )
    }
    return (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.75" />
        </svg>
    )
}

export function toolStatusColorClass(state: ToolCallBlock['tool']['state']): string {
    if (state === 'completed') return 'text-emerald-600'
    if (state === 'error') return 'text-red-600'
    if (state === 'pending') return 'text-amber-600'
    return 'text-[var(--app-hint)]'
}

function DetailsIcon() {
    return (
        <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

const INLINE_PREVIEW_INTERACTIVE_SELECTOR = 'a, button, input, textarea, select, summary, [role="button"], [contenteditable="true"]'

function isNestedInteractiveElement(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>): boolean {
    if (event.target === event.currentTarget) return false
    if (!(event.target instanceof Element)) return false

    const interactive = event.target.closest(INLINE_PREVIEW_INTERACTIVE_SELECTOR)
    return interactive !== null && interactive !== event.currentTarget
}

type ToolCardProps = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    disabled: boolean
    onDone: () => void
    block: ToolCallBlock
}

export function ToolDetailDialogContent(props: {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
}) {
    const { t } = useTranslation()
    const toolName = props.block.tool.name
    if (isTerminalExecutionTool(toolName)) {
        return <TerminalExecutionDetail block={props.block} />
    }
    const FullToolView = getToolFullViewComponent(toolName)
    const ResultToolView = getToolResultViewComponent(toolName)
    const fileMutationSummary = getFileMutationDialogSummary(props.block, props.metadata)
    if (fileMutationSummary && FullToolView) {
        return (
            <div className="mt-3 min-h-0 flex-1 overflow-auto overscroll-contain pr-1">
                <FullToolView block={props.block} metadata={props.metadata} surface="dialog" />
            </div>
        )
    }
    const permission = props.block.tool.permission
    const isAskUserQuestion = isAskUserQuestionToolName(toolName)
    const isRequestUserInput = isRequestUserInputToolName(toolName)
    const isQuestionTool = isAskUserQuestion || isRequestUserInput
    const isQuestionToolWithAnswers = isQuestionTool
        && permission?.answers
        && Object.keys(permission.answers).length > 0

    return (
        <div className={cn(
            'mt-3 flex max-h-[75vh] flex-col gap-4 overflow-auto',
            toolName === 'CodexPatch' ? 'max-sm:mt-0 max-sm:max-h-none max-sm:flex-1 max-sm:px-5 max-sm:pb-5' : null
        )}>
            <div>
                <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">
                    {isQuestionToolWithAnswers ? t('tool.questionsAnswers') : t('tool.input')}
                </div>
                {FullToolView ? (
                    <FullToolView block={props.block} metadata={props.metadata} surface="dialog" />
                ) : (
                    renderToolInput(props.block, 'dialog')
                )}
            </div>
            <TraceSection block={props.block} metadata={props.metadata} />
            {!isQuestionToolWithAnswers ? (
                <div>
                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</div>
                    <ResultToolView block={props.block} metadata={props.metadata} surface="dialog" />
                </div>
            ) : null}
        </div>
    )
}

export function ToolDetailDialogHeader(props: {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
    fallbackTitle: string
}) {
    const summary = getFileMutationDialogSummary(props.block, props.metadata)

    return (
        <DialogHeader className={summary ? 'shrink-0 border-b border-[var(--app-border)] pb-3 text-left' : undefined}>
            {summary ? (
                <div className="flex min-w-0 items-center gap-3" data-file-mutation-dialog-header>
                    <DialogTitle className="min-w-0 flex-1 truncate font-mono" title={summary.fileNames.join(', ')}>
                        {summary.title}
                    </DialogTitle>
                    <span className="inline-flex shrink-0 items-center gap-2 font-mono text-xs">
                        <span className="text-emerald-600">+{summary.additions}</span>
                        <span className="text-red-600">−{summary.deletions}</span>
                    </span>
                </div>
            ) : (
                <DialogTitle>{props.fallbackTitle}</DialogTitle>
            )}
        </DialogHeader>
    )
}

function ToolCardInner(props: ToolCardProps) {
    const { t } = useTranslation()
    const [detailsOpen, setDetailsOpen] = useState(false)
    const presentation = useMemo(() => getToolPresentation({
        toolName: props.block.tool.name,
        input: props.block.tool.input,
        result: props.block.tool.result,
        childrenCount: props.block.children.length,
        description: props.block.tool.description,
        metadata: props.metadata
    }, t), [
        props.block.tool.name,
        props.block.tool.input,
        props.block.tool.result,
        props.block.children.length,
        props.block.tool.description,
        props.metadata,
        t
    ])

    const toolName = props.block.tool.name
    const toolTitle = presentation.title
    const subtitle = presentation.subtitle ?? props.block.tool.description
    const taskSummary = renderTaskSummary(props.block, props.metadata, t)
    const runningFrom = props.block.tool.startedAt ?? props.block.tool.createdAt
    const isCodexAgentCard = toolName === 'CodexAgent'
    const isActivityTool = isActivityToolCard(props.block)
    const isTerminalExecution = isTerminalExecutionTool(toolName)
    const useFileMutationDialog = getFileMutationDialogSummary(props.block, props.metadata) !== null
    const useCompactTerminalCard = shouldUseCompactTerminalToolCard(toolName, props.terminalToolDisplayMode)
    const showInline = shouldShowInlineToolCardBody(toolName, presentation.minimal)
    const CompactToolView = showInline ? getToolViewComponent(toolName) : null
    const ResultToolView = getToolResultViewComponent(toolName)
    const permission = props.block.tool.permission
    const isAskUserQuestion = isAskUserQuestionToolName(toolName)
    const isRequestUserInput = isRequestUserInputToolName(toolName)
    const isQuestionTool = isAskUserQuestion || isRequestUserInput
    const showsPermissionFooter = Boolean(permission && (
        permission.status === 'pending'
        || ((permission.status === 'denied' || permission.status === 'canceled') && Boolean(permission.reason))
    ))
    const hasBody = showInline || taskSummary !== null || showsPermissionFooter
    const displayedToolState = isTerminalExecution ? getTerminalExecutionToolState(props.block) : props.block.tool.state
    const stateColor = toolStatusColorClass(displayedToolState)
    const { suppressFocusRing, onTriggerPointerDown, onTriggerKeyDown, onTriggerBlur } = usePointerFocusRing()
    const openDetails = () => setDetailsOpen(true)
    const openDetailsFromInlinePreview = (event: MouseEvent<HTMLElement>) => {
        if (isNestedInteractiveElement(event)) return
        openDetails()
    }
    const openDetailsFromInlinePreviewKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (isNestedInteractiveElement(event)) return
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openDetails()
        }
    }

    const header = (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex flex-1 flex-col gap-1">
                <div className="min-w-0 flex items-center gap-2">
                    <div className="shrink-0 flex h-3.5 w-3.5 items-center justify-center text-[var(--app-tool-card-accent)] leading-none">
                        {presentation.icon}
                    </div>
                    <CardTitle className={cn(
                        'min-w-0 text-sm font-medium leading-tight text-[var(--app-fg)]',
                        isCodexAgentCard ? 'truncate whitespace-nowrap' : 'break-words'
                    )}>
                        {toolTitle}
                    </CardTitle>
                </div>

                {subtitle ? (
                    <CardDescription className={cn(
                        'font-mono text-xs text-[var(--app-tool-card-subtitle)]',
                        isCodexAgentCard || useCompactTerminalCard ? 'truncate whitespace-nowrap' : 'break-all'
                    )}>
                        {truncate(subtitle, 160)}
                    </CardDescription>
                ) : null}
            </div>

            <div className={cn(
                'flex shrink-0 items-center gap-2 self-center text-[var(--app-hint)]',
                subtitle ? '-translate-y-0.5' : null
            )}>
                {isActivityTool ? (
                    <ActivityToolTiming block={props.block} />
                ) : (
                    <>
                        <ElapsedView from={runningFrom} active={props.block.tool.state === 'running'} />
                        <span className={stateColor}>
                            <ToolStatusIcon state={displayedToolState} />
                        </span>
                    </>
                )}
                <span className="text-[var(--app-hint)]">
                    <DetailsIcon />
                </span>
            </div>
        </div>
    )

    return (
        <Card className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] shadow-none">
            <CardHeader className={cn('space-y-0 p-3', subtitle ? 'pb-2' : null)}>
                {isTerminalExecution ? (
                    <button
                        type="button"
                        className={cn(
                            'w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                            suppressFocusRing && 'focus-visible:ring-0'
                        )}
                        onClick={openDetails}
                        onPointerDown={onTriggerPointerDown}
                        onKeyDown={onTriggerKeyDown}
                        onBlur={onTriggerBlur}
                        aria-expanded={detailsOpen}
                        aria-haspopup="dialog"
                    >
                        {header}
                    </button>
                ) : (
                    <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
                        <DialogTrigger asChild>
                            <button
                                type="button"
                                className={cn(
                                    'w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                                    suppressFocusRing && 'focus-visible:ring-0'
                                )}
                                onPointerDown={onTriggerPointerDown}
                                onKeyDown={onTriggerKeyDown}
                                onBlur={onTriggerBlur}
                            >
                                {header}
                            </button>
                        </DialogTrigger>
                        <DialogContent
                            className={cn('max-w-2xl', useFileMutationDialog ? FILE_MUTATION_DIALOG_CLASS_NAME : null)}
                            aria-describedby={undefined}
                            data-file-mutation-dialog={useFileMutationDialog ? 'true' : undefined}
                        >
                            <ToolDetailDialogHeader block={props.block} metadata={props.metadata} fallbackTitle={toolTitle} />
                            <ToolDetailDialogContent block={props.block} metadata={props.metadata} />
                        </DialogContent>
                    </Dialog>
                )}
            </CardHeader>

            {hasBody ? (
                <CardContent className="px-3 pb-3 pt-1">
                    {taskSummary ? (
                        <div className="mt-2">
                            {taskSummary}
                        </div>
                    ) : null}

                    {showInline ? (
                        CompactToolView ? (
                            <div
                                className="mt-3 cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                role="button"
                                tabIndex={0}
                                onClick={openDetailsFromInlinePreview}
                                onKeyDown={openDetailsFromInlinePreviewKeyDown}
                            >
                                <CompactToolView block={props.block} metadata={props.metadata} surface="inline" />
                            </div>
                        ) : (
                            <div className="mt-3 flex flex-col gap-3">
                                <div
                                    className="cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    role="button"
                                    tabIndex={0}
                                    onClick={openDetailsFromInlinePreview}
                                    onKeyDown={openDetailsFromInlinePreviewKeyDown}
                                >
                                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.input')}</div>
                                    {renderToolInput(props.block, 'inline')}
                                </div>
                                <div
                                    className="cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    role="button"
                                    tabIndex={0}
                                    onClick={openDetailsFromInlinePreview}
                                    onKeyDown={openDetailsFromInlinePreviewKeyDown}
                                >
                                    <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</div>
                                    <ResultToolView block={props.block} metadata={props.metadata} surface="inline" />
                                </div>
                            </div>
                        )
                    ) : null}

                    {isAskUserQuestion && permission?.status === 'pending' ? (
                        <AskUserQuestionFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    ) : isRequestUserInput && permission?.status === 'pending' ? (
                        <RequestUserInputFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    ) : (
                        <PermissionFooter
                            api={props.api}
                            sessionId={props.sessionId}
                            metadata={props.metadata}
                            tool={props.block.tool}
                            disabled={props.disabled}
                            onDone={props.onDone}
                        />
                    )}
                </CardContent>
            ) : null}

            {isTerminalExecution ? (
                <TerminalExecutionDrawer
                    block={props.block}
                    open={detailsOpen}
                    onOpenChange={setDetailsOpen}
                />
            ) : null}
        </Card>
    )
}

export const ToolCard = memo(ToolCardInner)
