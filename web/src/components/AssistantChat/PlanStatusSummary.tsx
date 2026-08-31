import { useEffect, useRef, useState } from 'react'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { extractUpdatePlanChecklist, type ChecklistItem } from '@/components/ToolCard/checklist'
import { ArrowDownIcon, CheckIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

export type PlanStatusSummaryData = {
    sourceBlockId: string
    steps: ChecklistItem[]
    total: number
    completed: number
    currentIndex: number
    currentStep: ChecklistItem
}

type ToolBlockScope = {
    minCreatedAt?: number | null
}

function isBlockInScope(block: ChatBlock, scope?: ToolBlockScope): boolean {
    return scope?.minCreatedAt == null || block.createdAt >= scope.minCreatedAt
}

function collectToolBlocks(blocks: ChatBlock[], target: ToolCallBlock[] = [], scope?: ToolBlockScope): ToolCallBlock[] {
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        if (isBlockInScope(block, scope)) {
            target.push(block)
        }
        collectToolBlocks(block.children, target, scope)
    }
    return target
}

function summarizePlanBlock(block: ToolCallBlock): PlanStatusSummaryData | null {
    const steps = extractUpdatePlanChecklist(block.tool.input, block.tool.result)
    if (steps.length === 0) return null

    const inProgressIndex = steps.findIndex((step) => step.status === 'in_progress')
    const pendingIndex = steps.findIndex((step) => step.status === 'pending')
    const fallbackIndex = Math.max(0, steps.length - 1)
    const currentIndex = inProgressIndex >= 0
        ? inProgressIndex
        : pendingIndex >= 0
            ? pendingIndex
            : fallbackIndex

    return {
        sourceBlockId: block.id,
        steps,
        total: steps.length,
        completed: steps.filter((step) => step.status === 'completed').length,
        currentIndex,
        currentStep: steps[currentIndex]
    }
}

export function extractLatestPlanStatus(blocks: ChatBlock[], scope?: ToolBlockScope): PlanStatusSummaryData | null {
    const planBlocks = collectToolBlocks(blocks, [], scope)
        .filter((block) => block.tool.name === 'update_plan')

    for (let index = planBlocks.length - 1; index >= 0; index -= 1) {
        const summary = summarizePlanBlock(planBlocks[index])
        if (summary) return summary
    }

    return null
}

export function hasActiveToolBlock(blocks: ChatBlock[], scope?: ToolBlockScope): boolean {
    return collectToolBlocks(blocks, [], scope).some((block) => (
        block.tool.state === 'running'
        || block.tool.state === 'pending'
        || block.tool.permission?.status === 'pending'
    ))
}

export function getRunScopedPlanStatus(
    plan: PlanStatusSummaryData | null,
    options: {
        runActive: boolean
        clearedSourceBlockId: string | null
    }
): PlanStatusSummaryData | null {
    if (!options.runActive || !plan) return null
    if (plan.sourceBlockId === options.clearedSourceBlockId) return null
    return plan
}

export function removeChatBlockById(blocks: ChatBlock[], blockId: string): ChatBlock[] {
    let changed = false
    const next: ChatBlock[] = []

    for (const block of blocks) {
        if (block.id === blockId) {
            changed = true
            continue
        }

        if (block.kind === 'tool-call') {
            const children = removeChatBlockById(block.children, blockId)
            if (children !== block.children) {
                changed = true
                next.push({ ...block, children })
                continue
            }
        }

        next.push(block)
    }

    return changed ? next : blocks
}

function StepStatusIcon(props: { status: ChecklistItem['status'] }) {
    if (props.status === 'completed') {
        return (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-[0_2px_7px_rgba(16,185,129,0.28)]">
                <CheckIcon className="h-3 w-3" />
            </span>
        )
    }

    if (props.status === 'in_progress') {
        return (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-[var(--app-link)] bg-[var(--app-bg)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-link)] motion-safe:animate-pulse" />
            </span>
        )
    }

    return <span className="h-5 w-5 shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]" />
}

function PlanListIcon(props: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="M9 6h10" />
            <path d="M9 12h10" />
            <path d="M9 18h10" />
            <path d="m4 6 1 1 2-2" />
            <path d="m4 12 1 1 2-2" />
            <path d="M5 18h.01" />
        </svg>
    )
}

export function PlanStatusSummary(props: {
    plan: PlanStatusSummaryData | null
    onExpandedChange?: (expanded: boolean) => void
}) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        props.onExpandedChange?.(expanded)
    }, [expanded, props.onExpandedChange])

    useEffect(() => {
        if (!expanded) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Node && rootRef.current?.contains(target)) {
                return
            }
            setExpanded(false)
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setExpanded(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [expanded])

    useEffect(() => {
        setExpanded(false)
    }, [props.plan?.sourceBlockId])

    if (!props.plan) return null

    const progressPercent = Math.round((props.plan.completed / props.plan.total) * 100)
    const progressLabel = t('planStatus.progress', {
        completed: props.plan.completed,
        total: props.plan.total
    })

    return (
        <div ref={rootRef} className="pointer-events-none relative mx-auto flex w-full max-w-content justify-center px-3 [font-family:var(--app-chat-font-family)]">
            <div className={cn(
                'pointer-events-auto w-full max-w-[min(88vw,34rem)] overflow-hidden border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_10px_26px_rgba(15,23,42,0.12)] transition-[border-radius,box-shadow] duration-200 ease-out',
                expanded
                    ? 'rounded-[18px] shadow-[0_18px_42px_rgba(15,23,42,0.16)] animate-diff-pop'
                    : 'rounded-full animate-diff-pill'
            )}>
                <button
                    type="button"
                    className={cn(
                        'flex w-full min-w-0 items-center gap-2.5 px-4 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]',
                        expanded ? 'min-h-12 py-3' : 'h-[38px]'
                    )}
                    aria-expanded={expanded}
                    aria-label={`${t('planStatus.title')} · ${progressLabel}`}
                    onClick={() => setExpanded((value) => !value)}
                >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                        <PlanListIcon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-fg)]">
                        {t('planStatus.title')}
                    </span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--app-hint)]" aria-hidden="true">
                        {props.plan.completed}/{props.plan.total}
                    </span>
                    <span
                        className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]"
                        role="progressbar"
                        aria-label={progressLabel}
                        aria-valuemin={0}
                        aria-valuemax={props.plan.total}
                        aria-valuenow={props.plan.completed}
                    >
                        <span
                            className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out motion-reduce:transition-none"
                            style={{ width: `${progressPercent}%` }}
                        />
                    </span>
                    <ArrowDownIcon className={cn(
                        'h-3.5 w-3.5 shrink-0 text-[var(--app-hint)] transition-transform duration-200',
                        expanded ? 'rotate-180' : ''
                    )} />
                </button>

                {expanded ? (
                    <section className="border-t border-[var(--app-border)] px-4 pb-4 pt-3" role="region" aria-label={t('planStatus.dialogTitle')}>
                        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-[var(--app-hint)]">
                            <span>{progressLabel}</span>
                            <span>{t('planStatus.steps', { total: props.plan.total })}</span>
                        </div>
                        <div className="overflow-y-auto pr-1" style={{ maxHeight: 'min(38vh, 18rem)' }}>
                            <ol className="ml-2 border-l border-[var(--app-border)] pl-4">
                                {props.plan.steps.map((step, index) => {
                                    const text = step.text.trim().length > 0 ? step.text.trim() : t('planStatus.emptyStep')
                                    return (
                                        <li key={`${step.id ?? index}:${text}`} className="relative min-w-0 py-1.5 first:pt-0 last:pb-0">
                                            <span className={cn(
                                                'absolute -left-[1.6rem] bg-[var(--app-bg)]',
                                                index === 0 ? 'top-0' : 'top-1.5'
                                            )}>
                                                <StepStatusIcon status={step.status} />
                                            </span>
                                            <span className={cn(
                                                'block whitespace-normal break-words text-sm leading-5',
                                                step.status === 'completed'
                                                    ? 'text-[var(--app-hint)]'
                                                    : step.status === 'in_progress'
                                                        ? 'font-semibold text-[var(--app-fg)]'
                                                        : 'text-[var(--app-hint)]'
                                            )}>
                                                {text}
                                            </span>
                                        </li>
                                    )
                                })}
                            </ol>
                        </div>
                    </section>
                ) : null}
            </div>
        </div>
    )
}
