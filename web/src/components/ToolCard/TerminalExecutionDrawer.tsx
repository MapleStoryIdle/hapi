import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { ChatDetailDialog } from '@/components/ui/ChatDetailDialog'
import { TerminalIcon } from '@/components/ToolCard/icons'
import { getTerminalCommandDisplayTitle } from '@/components/ToolCard/terminalCommandIntent'
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
    const title = getTerminalCommandDisplayTitle(props.block.tool.input, t) ?? t('terminal.execution.title')
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
        <ChatDetailDialog open={props.open} onOpenChange={handleOpenChange}
            title={title}
            testId="terminal-execution-drawer"
            overlayTestId="terminal-execution-overlay"
            closeTestId="terminal-execution-close"
            desktopClassName="flex h-[min(75dvh,50rem)] max-h-[calc(100dvh-2rem)] w-[min(75vw,60rem)] max-w-none flex-col overflow-hidden"
            bodyClassName="sm:flex-1"
            header={
                    <div className="flex min-w-0 items-center gap-2 pr-2 sm:pr-12">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]">
                            <TerminalIcon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <Dialog.Title className="truncate text-sm font-bold text-[var(--app-fg)] sm:text-base">
                                {title}
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
                    </div>
            }
            accessory={<>

                    {details.command ? (
                        <div className="shrink-0 border-b border-[var(--app-border)] px-5 py-2 sm:px-0" data-terminal-execution-command-strip>
                            <p className="truncate rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 font-mono text-xs leading-5 text-[var(--app-hint)]" title={details.command}>
                                {details.command}
                            </p>
                        </div>
                    ) : null}

                    <div className="shrink-0 border-b border-[var(--app-border)] px-5 sm:px-0">
                        <div aria-label={title} className="chat-segmented my-2" role="tablist">
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
                                        className="chat-segment"
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

            </>}
        >
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
        </ChatDetailDialog>
    )
}
