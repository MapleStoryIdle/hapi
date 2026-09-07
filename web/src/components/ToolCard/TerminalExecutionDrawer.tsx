import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { Check, X, Clock3, LoaderCircle, Folder, SquareTerminal } from 'lucide-react'
import type { ToolCallBlock } from '@/chat/types'
import { ChatDetailDialog } from '@/components/ui/ChatDetailDialog'
import { DetailCopyButton } from '@/components/ui/DetailCopyButton'
import { getTerminalCommandDisplayTitle } from '@/components/ToolCard/terminalCommandIntent'
import { formatTerminalExecutionDuration, getTerminalExecutionDetails, getTerminalExecutionState, TerminalExecutionDetail } from '@/components/ToolCard/terminalExecution'
import { useTranslation } from '@/lib/use-translation'

function WorkingDirectory(props: { cwd: string }) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const { cwd } = props
    const label = cwd.length > 44 && !expanded ? `${cwd.slice(0, 15)}…${cwd.slice(-26)}` : cwd
    return <div className="terminal-drawer-directory" data-terminal-directory>
        <button type="button" className="terminal-drawer-path" title={cwd}
            aria-label={`${t('terminal.execution.workingDirectory')}: ${cwd}`}
            aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <span className={expanded ? '[overflow-wrap:anywhere]' : 'truncate'}>{label}</span>
        </button>
        <DetailCopyButton iconOnly value={cwd} label={t('terminal.execution.copyDirectory')} />
    </div>
}

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
    const StatusIcon = state === 'completed' ? Check : state === 'failed' ? X : state === 'running' ? LoaderCircle : Clock3
    const color = state === 'completed' ? 'text-[var(--app-badge-success-text)]'
        : state === 'failed' ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'

    return <ChatDetailDialog open={props.open} onOpenChange={props.onOpenChange}
        title={title}
        testId="terminal-execution-drawer"
        overlayTestId="terminal-execution-overlay"
        closeTestId="terminal-execution-close"
        desktopClassName="flex max-h-[min(75dvh,50rem)] w-[min(75vw,60rem)] max-w-none flex-col overflow-hidden"
        bodyClassName="sm:flex-1"
        header={
            <div className="terminal-drawer-heading sm:pr-12">
                <div className="terminal-drawer-row">
                    <SquareTerminal className="h-5 w-5 text-[var(--app-link)]" aria-hidden="true" data-terminal-header-icon />
                    <Dialog.Title title={title} className="truncate text-base font-semibold leading-6 text-[var(--app-fg)]">{title}</Dialog.Title>
                </div>
                {details.cwd ? <div className="terminal-drawer-row">
                    <Folder className="h-5 w-5 text-[var(--app-hint)]" aria-hidden="true" data-terminal-header-icon />
                    <WorkingDirectory key={`${props.block.id}:${details.cwd}:${props.open}`} cwd={details.cwd} />
                </div> : null}
                <div className="terminal-drawer-row terminal-drawer-status" data-terminal-status={state}>
                    <span role="img" aria-label={t(`terminal.execution.${state}`)} className={color}>
                        <StatusIcon aria-hidden="true" data-terminal-header-icon className={`h-5 w-5 ${state === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
                    </span>
                    {duration ? <span data-terminal-duration className="font-mono tabular-nums text-[var(--app-hint)]">{duration}</span> : null}
                </div>
            </div>
        }
    >
        <TerminalExecutionDetail key={props.block.id} block={props.block} surface="drawer" />
    </ChatDetailDialog>
}
