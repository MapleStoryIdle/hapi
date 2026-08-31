import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { CloseIcon } from '@/components/icons'
import { TerminalIcon } from '@/components/ToolCard/icons'
import {
    formatTerminalExecutionDuration,
    getTerminalExecutionDetails,
    getTerminalExecutionState,
    TerminalExecutionDetail,
    type TerminalExecutionDrawerTab,
    type TerminalExecutionState,
} from '@/components/ToolCard/terminalExecution'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const DRAWER_TABS: TerminalExecutionDrawerTab[] = ['output', 'input', 'environment']

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
    return 'animate-pulse motion-reduce:animate-none bg-sky-500'
}

/**
 * A command is a log-like artifact rather than a short-form detail. Keep it in
 * a bounded reading surface, bottom-anchored on phones and centered on larger
 * screens, so the conversation remains outside the drawer's document flow.
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
    const [selectedTab, setSelectedTab] = useState<TerminalExecutionDrawerTab>('output')
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
    const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const blockId = props.block.id.replace(/[^a-zA-Z0-9_-]/g, '-')
    const idPrefix = `terminal-execution-${blockId}-${instanceId}`
    const tabLabels: Record<TerminalExecutionDrawerTab, string> = {
        output: t('terminal.execution.output'),
        input: t('terminal.execution.input'),
        environment: t('terminal.execution.environment'),
    }

    useEffect(() => {
        setSelectedTab('output')
    }, [props.block.id, props.open])

    function selectTab(index: number) {
        const tab = DRAWER_TABS[index]
        if (!tab) return

        setSelectedTab(tab)
        tabRefs.current[index]?.focus()
    }

    function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        let nextIndex: number | null = null

        if (event.key === 'ArrowLeft') {
            nextIndex = (index - 1 + DRAWER_TABS.length) % DRAWER_TABS.length
        } else if (event.key === 'ArrowRight') {
            nextIndex = (index + 1) % DRAWER_TABS.length
        } else if (event.key === 'Home') {
            nextIndex = 0
        } else if (event.key === 'End') {
            nextIndex = DRAWER_TABS.length - 1
        }

        if (nextIndex === null) return

        event.preventDefault()
        selectTab(nextIndex)
    }

    function handleOpenChange(open: boolean) {
        if (!open) setSelectedTab('output')
        props.onOpenChange(open)
    }

    return (
        <Dialog.Root open={props.open} onOpenChange={handleOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay
                    data-testid="terminal-execution-overlay"
                    className="fixed inset-0 z-[60] bg-slate-950/30"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) handleOpenChange(false)
                    }}
                />
                <Dialog.Content
                    aria-describedby={undefined}
                    data-testid="terminal-execution-drawer"
                    className="fixed inset-x-0 bottom-0 z-[61] flex h-[60dvh] w-full flex-col overflow-hidden rounded-t-[28px] border border-[var(--app-border)] bg-[var(--app-dialog-bg)] shadow-[0_24px_80px_rgba(15,23,42,0.24)] isolate outline-none sm:bottom-auto sm:left-1/2 sm:right-auto sm:top-1/2 sm:h-[min(75dvh,50rem)] sm:max-h-[calc(100dvh-2rem)] sm:w-[min(75vw,60rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
                >
                    <header className="relative z-10 flex min-w-0 shrink-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-dialog-bg)] px-4 pb-2.5 pt-5 sm:gap-3 sm:px-6 sm:pb-3 sm:pt-5">
                        <span
                            aria-hidden="true"
                            className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-[var(--app-border)] sm:hidden"
                            data-terminal-execution-drag-handle
                        />
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]">
                            <TerminalIcon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <Dialog.Title className="truncate text-sm font-bold text-[var(--app-fg)] sm:text-base">
                                {t('terminal.execution.title')}
                            </Dialog.Title>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5">
                                <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold leading-none', stateColorClass(state))}>
                                    <span className={cn('h-1.5 w-1.5 rounded-full', stateDotClass(state))} aria-hidden="true" />
                                    <span className="truncate">{t(`terminal.execution.${state}`)}</span>
                                </span>
                                {duration ? (
                                    <span className="shrink-0 font-mono text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                        {duration}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                        <Dialog.Close
                            type="button"
                            data-testid="terminal-execution-close"
                            aria-label={t('button.close')}
                            className="touch-manipulation -mr-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-0 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] motion-reduce:transition-none sm:-mr-2 sm:w-auto sm:gap-1.5 sm:px-3"
                        >
                            <span className="hidden sm:inline">{t('button.close')}</span>
                            <CloseIcon className="h-4 w-4" aria-hidden="true" />
                        </Dialog.Close>
                    </header>

                    {details.command ? (
                        <div className="shrink-0 border-b border-[var(--app-border)] px-4 py-2 sm:px-6" data-terminal-execution-command-strip>
                            <p className="truncate rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 py-1.5 font-mono text-[11px] leading-4 text-[var(--app-hint)]" title={details.command}>
                                {details.command}
                            </p>
                        </div>
                    ) : null}

                    <div className="shrink-0 border-b border-[var(--app-border)] px-4 sm:px-6">
                        <div aria-label={t('terminal.execution.title')} className="flex gap-1 overflow-x-auto py-2" role="tablist">
                            {DRAWER_TABS.map((tab, index) => {
                                const tabId = `${idPrefix}-tab-${tab}`
                                const panelId = `${idPrefix}-panel-${tab}`
                                const selected = selectedTab === tab

                                return (
                                    <button
                                        key={tab}
                                        ref={(element) => {
                                            tabRefs.current[index] = element
                                        }}
                                        aria-controls={panelId}
                                        aria-selected={selected}
                                        className={cn(
                                            'min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] motion-reduce:transition-none',
                                            selected
                                                ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                                : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                                        )}
                                        id={tabId}
                                        onClick={() => setSelectedTab(tab)}
                                        onKeyDown={(event) => onTabKeyDown(event, index)}
                                        role="tab"
                                        tabIndex={selected ? 0 : -1}
                                        type="button"
                                    >
                                        {tabLabels[tab]}
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {DRAWER_TABS.map((tab) => (
                        <TerminalExecutionDetail
                            key={`${props.block.id}-${tab}`}
                            block={props.block}
                            drawerTab={tab}
                            hidden={selectedTab !== tab}
                            labelledBy={`${idPrefix}-tab-${tab}`}
                            panelId={`${idPrefix}-panel-${tab}`}
                            surface="drawer"
                        />
                    ))}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
