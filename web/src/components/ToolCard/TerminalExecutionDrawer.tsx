import * as Dialog from '@radix-ui/react-dialog'
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

/**
 * A command is a log-like artifact rather than a short-form detail. Give it a
 * bounded modal reading surface so the surrounding conversation stays visible
 * and a click outside the modal is an easy, predictable close action.
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

    return (
        <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay
                    data-testid="terminal-execution-overlay"
                    className="fixed inset-0 z-[60] bg-slate-950/30"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) props.onOpenChange(false)
                    }}
                />
                <Dialog.Content
                    aria-describedby={undefined}
                    data-testid="terminal-execution-drawer"
                    className="fixed left-1/2 top-1/2 z-[61] flex h-[min(75dvh,50rem)] max-h-[calc(100dvh-var(--app-safe-area-top)-var(--app-safe-area-bottom)-2rem)] w-[min(92vw,60rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-dialog-bg)] pt-[var(--app-safe-area-top)] shadow-[0_24px_80px_rgba(15,23,42,0.24)] isolate outline-none sm:w-[min(75vw,60rem)]"
                >
                    <header className="relative z-10 flex shrink-0 items-start gap-3 border-b border-[var(--app-border)] bg-[var(--app-dialog-bg)] px-5 pb-3 pt-4 sm:px-6 sm:pb-4">
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
                            data-testid="terminal-execution-close"
                            aria-label={t('button.close')}
                            className="touch-manipulation -mr-2 -mt-1 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <span>{t('button.close')}</span>
                            <CloseIcon className="h-4 w-4" />
                        </Dialog.Close>
                    </header>

                    <TerminalExecutionDetail block={props.block} surface="modal" />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
