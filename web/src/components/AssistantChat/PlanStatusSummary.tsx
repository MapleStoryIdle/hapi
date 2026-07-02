import { useEffect, useMemo, useRef, useState } from 'react'
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

function collectToolBlocks(blocks: ChatBlock[], target: ToolCallBlock[] = []): ToolCallBlock[] {
    for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        target.push(block)
        collectToolBlocks(block.children, target)
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

export function extractLatestPlanStatus(blocks: ChatBlock[]): PlanStatusSummaryData | null {
    const planBlocks = collectToolBlocks(blocks)
        .filter((block) => block.tool.name === 'update_plan')

    for (let index = planBlocks.length - 1; index >= 0; index -= 1) {
        const summary = summarizePlanBlock(planBlocks[index])
        if (summary) return summary
    }

    return null
}

export function hasActiveToolBlock(blocks: ChatBlock[]): boolean {
    return collectToolBlocks(blocks).some((block) => (
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
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckIcon className="h-3 w-3" />
            </span>
        )
    }

    if (props.status === 'in_progress') {
        return (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--app-link)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" />
            </span>
        )
    }

    return <span className="h-4 w-4 shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]" />
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

    const visibleSteps = useMemo(() => props.plan?.steps ?? [], [props.plan?.steps])

    if (!props.plan) return null

    return (
        <div ref={rootRef} className="relative mx-auto flex w-full max-w-content justify-center px-3">
            {expanded ? (
                <div
                    className="absolute bottom-14 left-1/2 z-20 origin-bottom -translate-x-1/2 overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-code-bg)] shadow-[0_18px_45px_rgba(15,23,42,0.16)] animate-diff-pop"
                    style={{
                        width: 'max-content',
                        minWidth: '14rem',
                        maxWidth: 'min(50vw, 28rem)',
                        maxHeight: 'min(50vh, 22rem)'
                    }}
                    role="dialog"
                    aria-label={t('planStatus.dialogTitle')}
                >
                    <div className="px-4 pb-3 pt-4">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="text-[0.95rem] font-semibold text-[var(--app-fg)]">
                                {t('planStatus.title')}
                            </span>
                            <span className="text-sm font-medium text-[var(--app-hint)]">
                                {t('planStatus.steps', { total: props.plan.total })}
                            </span>
                        </div>
                    </div>
                    <div
                        className="overflow-y-auto px-4 pb-4"
                        style={{ maxHeight: 'min(38vh, 16rem)' }}
                    >
                        <div className="flex flex-col gap-3 border-t border-[var(--app-border)] pt-3">
                            {visibleSteps.map((step, index) => {
                                const text = step.text.trim().length > 0 ? step.text.trim() : t('planStatus.emptyStep')
                                return (
                                    <div key={`${step.id ?? index}:${text}`} className="flex min-w-0 items-start gap-3">
                                        <StepStatusIcon status={step.status} />
                                        <div className="min-w-0 text-sm leading-5">
                                            <div className={cn(
                                                'whitespace-normal break-words',
                                                step.status === 'completed'
                                                    ? 'text-[var(--app-hint)] line-through'
                                                    : step.status === 'in_progress'
                                                        ? 'font-semibold text-[var(--app-fg)]'
                                                        : 'text-[var(--app-hint)]'
                                            )}>
                                                {text}
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                </div>
            ) : null}

            <button
                type="button"
                className="inline-flex h-[34px] max-w-[min(82vw,26rem)] items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-4 text-sm font-medium shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-all duration-150 ease-out hover:-translate-y-0.5 hover:shadow-[0_12px_30px_rgba(15,23,42,0.16)] animate-diff-pill"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
            >
                <StepStatusIcon status={props.plan.currentStep.status} />
                <span className="shrink-0 font-semibold text-[var(--app-fg)]">{t('planStatus.title')}</span>
                <span className="shrink-0 text-[var(--app-hint)]">
                    {t('planStatus.counter', { current: props.plan.currentIndex + 1, total: props.plan.total })}
                </span>
                <span className="shrink-0 text-[var(--app-hint)]">{t('planStatus.stepUnit')}</span>
                <ArrowDownIcon className={cn(
                    'h-3.5 w-3.5 shrink-0 text-[var(--app-hint)] transition-transform',
                    expanded ? 'rotate-180' : ''
                )} />
            </button>
        </div>
    )
}
