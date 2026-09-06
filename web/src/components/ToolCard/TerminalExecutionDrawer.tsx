import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useId, useState } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { ChatDetailTabs } from '@/components/ui/ChatDetailTabs'
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

const DRAWER_TABS: TerminalExecutionDrawerTab[] = ['transcript', 'details']

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
    const [selectedTab, setSelectedTab] = useState<TerminalExecutionDrawerTab>('transcript')
    const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const blockId = props.block.id.replace(/[^a-zA-Z0-9_-]/g, '-')
    const idPrefix = `terminal-execution-${blockId}-${instanceId}`
    const tabs = [
        { value: 'transcript' as const, label: t('terminal.execution.transcript') },
        { value: 'details' as const, label: t('terminal.execution.details') },
    ]

    useEffect(() => {
        setSelectedTab('transcript')
    }, [props.block.id, props.open])

    function handleOpenChange(open: boolean) {
        if (!open) setSelectedTab('transcript')
        props.onOpenChange(open)
    }

    return (
        <ChatDetailDialog open={props.open} onOpenChange={handleOpenChange}
            title={title}
            testId="terminal-execution-drawer"
            overlayTestId="terminal-execution-overlay"
            closeTestId="terminal-execution-close"
            desktopClassName="flex max-h-[min(75dvh,50rem)] w-[min(75vw,60rem)] max-w-none flex-col overflow-hidden"
            bodyClassName="sm:flex-1"
            header={
                <div className="flex min-w-0 items-center gap-2 pr-2 sm:pr-12">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]">
                        <TerminalIcon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                        <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--app-fg)]">
                            {title}
                        </Dialog.Title>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-1.5 py-1 text-[11px] font-semibold leading-none', stateColorClass(state))}>
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
            accessory={
                <div className="shrink-0 px-4 pb-2 sm:px-0">
                    <ChatDetailTabs tabs={tabs} value={selectedTab} onChange={setSelectedTab} idPrefix={idPrefix} label={title} />
                </div>
            }
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
