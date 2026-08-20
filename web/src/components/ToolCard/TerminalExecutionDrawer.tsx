import * as Dialog from '@radix-ui/react-dialog'
import { useRef, useState, type PointerEvent } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { CloseIcon } from '@/components/icons'
import { TerminalIcon } from '@/components/ToolCard/icons'
import {
    formatTerminalExecutionDuration,
    getTerminalExecutionDetails,
    getTerminalExecutionState,
    TerminalExecutionDetail,
    type TerminalExecutionState,
} from '@/components/ToolCard/terminalExecution'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function stateColorClass(state: TerminalExecutionState): string {
    if (state === 'failed') return 'border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]'
    if (state === 'completed') return 'border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]'
    if (state === 'pending') return 'border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]'
    return 'border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
}

function stateDotClass(state: TerminalExecutionState): string {
    if (state === 'failed') return 'bg-red-500'
    if (state === 'completed') return 'bg-emerald-500'
    if (state === 'pending') return 'bg-amber-500'
    return 'animate-pulse bg-sky-500'
}

const DRAWER_DISMISS_DISTANCE_PX = 96

type DrawerDragState = {
    pointerId: number
    startY: number
}

/**
 * A command is a log-like artifact rather than a short-form detail. Give it a
 * dedicated reading surface: a bottom sheet on touch screens and a wide side
 * drawer where desktop output has enough horizontal room.
 */
export function TerminalExecutionDrawer(props: {
    block: ToolCallBlock
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation()
    const details = getTerminalExecutionDetails(props.block)
    const state = getTerminalExecutionState(props.block, details)
    const duration = formatTerminalExecutionDuration(details.durationMs)
    const dragStateRef = useRef<DrawerDragState | null>(null)
    const [dragOffset, setDragOffset] = useState(0)
    const [isDragging, setIsDragging] = useState(false)

    const resetDrawerDrag = () => {
        dragStateRef.current = null
        setIsDragging(false)
        setDragOffset(0)
    }

    const handleDrawerDragStart = (event: PointerEvent<HTMLDivElement>) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return

        dragStateRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setIsDragging(true)
        setDragOffset(0)
    }

    const handleDrawerDragMove = (event: PointerEvent<HTMLDivElement>) => {
        const dragState = dragStateRef.current
        if (!dragState || dragState.pointerId !== event.pointerId) return

        setDragOffset(Math.max(0, event.clientY - dragState.startY))
    }

    const handleDrawerDragEnd = (event: PointerEvent<HTMLDivElement>) => {
        const dragState = dragStateRef.current
        if (!dragState || dragState.pointerId !== event.pointerId) return

        const distance = Math.max(0, event.clientY - dragState.startY)
        resetDrawerDrag()
        if (distance >= DRAWER_DISMISS_DISTANCE_PX) {
            props.onOpenChange(false)
        }
    }

    return (
        <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/30" />
                <Dialog.Content
                    aria-describedby={undefined}
                    data-testid="terminal-execution-drawer"
                    className={cn(
                        'fixed inset-x-0 bottom-0 z-[61] flex h-[min(88dvh,50rem)] flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-dialog-bg)] pb-[max(var(--app-safe-area-bottom),0.75rem)] shadow-[0_-18px_48px_rgba(15,23,42,0.22)] isolate animate-slide-up outline-none motion-reduce:animate-none sm:inset-y-0 sm:left-auto sm:right-0 sm:h-auto sm:w-[min(46rem,58vw)] sm:rounded-none sm:border-y-0 sm:border-r-0 sm:border-l sm:pb-0 sm:shadow-[-18px_0_48px_rgba(15,23,42,0.18)]',
                        isDragging ? 'transition-none' : 'transition-transform duration-200 ease-out'
                    )}
                    style={dragOffset > 0 ? { transform: `translate3d(0, ${dragOffset}px, 0)` } : undefined}
                >
                    <div
                        className={cn(
                            'flex h-8 shrink-0 touch-none select-none items-center justify-center sm:hidden',
                            isDragging ? 'cursor-grabbing' : 'cursor-grab'
                        )}
                        data-testid="terminal-execution-drawer-drag-handle"
                        onPointerCancel={resetDrawerDrag}
                        onPointerDown={handleDrawerDragStart}
                        onPointerMove={handleDrawerDragMove}
                        onPointerUp={handleDrawerDragEnd}
                    >
                        <div className={cn(
                            'h-1 rounded-full bg-[var(--app-border)] transition-[width] duration-150',
                            isDragging ? 'w-14' : 'w-10'
                        )} aria-hidden="true" />
                    </div>

                    <header className="relative z-10 flex shrink-0 items-start gap-3 border-b border-[var(--app-border)] bg-[var(--app-dialog-bg)] px-5 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-[max(var(--app-safe-area-top),1.25rem)]">
                        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]">
                            <TerminalIcon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <Dialog.Title className="text-base font-bold text-[var(--app-fg)]">
                                    {t('terminal.execution.title')}
                                </Dialog.Title>
                                <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold leading-none', stateColorClass(state))}>
                                    <span className={cn('h-1.5 w-1.5 rounded-full', stateDotClass(state))} aria-hidden="true" />
                                    {t(`terminal.execution.${state}`)}
                                </span>
                                {duration ? (
                                    <span className="shrink-0 font-mono text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                        {duration}
                                    </span>
                                ) : null}
                            </div>
                            {details.command ? (
                                <p className="mt-1 truncate font-mono text-xs leading-5 text-[var(--app-hint)]" title={details.command}>
                                    {details.command}
                                </p>
                            ) : null}
                        </div>
                        <Dialog.Close
                            type="button"
                            aria-label={t('button.close')}
                            className="touch-manipulation -mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <CloseIcon className="h-4 w-4" />
                        </Dialog.Close>
                    </header>

                    <TerminalExecutionDetail block={props.block} surface="drawer" />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
