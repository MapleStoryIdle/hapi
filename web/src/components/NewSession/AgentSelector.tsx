import type { ReactNode } from 'react'
import { getFlavorLabel } from '@hapi/protocol'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { NEW_SESSION_AGENT_OPTIONS, type AgentType } from './types'
import { useTranslation } from '@/lib/use-translation'

const AGENT_TAB_LABELS: Partial<Record<AgentType, string>> = {
    claude: 'Claude Code',
}

function getAgentTabLabel(agentType: AgentType): string {
    return AGENT_TAB_LABELS[agentType] ?? getFlavorLabel(agentType)
}

export function AgentSelector(props: {
    agent: AgentType
    isDisabled: boolean
    onAgentChange: (value: AgentType) => void
    children?: ReactNode
}) {
    const { t } = useTranslation()

    return (
        <div
            className="flex flex-col gap-3 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"
            data-testid="new-session-agent"
        >
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div
                role="radiogroup"
                aria-label={t('newSession.agent')}
                className="grid w-full grid-cols-2 gap-1 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1"
            >
                {NEW_SESSION_AGENT_OPTIONS.map((agentType) => {
                    const label = getAgentTabLabel(agentType)
                    const checked = props.agent === agentType
                    const unsupported = agentType === 'claude'
                    const disabled = props.isDisabled || unsupported

                    return (
                        <label
                            key={agentType}
                            aria-label={label}
                            title={label}
                            className={[
                                'inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-2xl px-3 text-sm font-medium transition-colors',
                                checked
                                    ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm ring-1 ring-[var(--app-border)]'
                                    : 'bg-transparent text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                                disabled ? 'cursor-not-allowed opacity-50' : ''
                            ].filter(Boolean).join(' ')}
                        >
                            <input
                                type="radio"
                                name="agent"
                                value={agentType}
                                checked={checked}
                                onChange={() => props.onAgentChange(agentType)}
                                disabled={disabled}
                                className="sr-only"
                            />
                            <AgentFlavorIcon flavor={agentType} className="h-5 w-5" />
                            <span className="flex min-w-0 flex-col leading-tight">
                                <span className="whitespace-nowrap">{label}</span>
                                {unsupported ? <span className="text-[10px] font-normal text-[var(--app-hint)]">{t('newSession.agent.temporarilyUnsupported')}</span> : null}
                            </span>
                        </label>
                    )
                })}
            </div>
            {props.children ? (
                <div
                    className="grid grid-cols-2 gap-3 border-t border-[var(--app-border)] pt-3 sm:grid-cols-[minmax(0,1fr)_minmax(8.5rem,11rem)_minmax(8.5rem,11rem)]"
                    data-testid="new-session-agent-settings"
                >
                    {props.children}
                </div>
            ) : null}
        </div>
    )
}
