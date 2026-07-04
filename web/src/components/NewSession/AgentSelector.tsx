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
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-2 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.agent')}
            </label>
            <div className="overflow-x-auto">
                <div
                    role="radiogroup"
                    aria-label={t('newSession.agent')}
                    className="inline-flex w-max flex-nowrap items-center gap-1 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1"
                >
                    {NEW_SESSION_AGENT_OPTIONS.map((agentType) => {
                        const label = getAgentTabLabel(agentType)
                        const checked = props.agent === agentType

                        return (
                            <label
                                key={agentType}
                                aria-label={label}
                                title={label}
                                className={[
                                    'inline-flex h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-2xl px-3 text-sm font-medium transition-colors',
                                    checked
                                        ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm ring-1 ring-[var(--app-border)]'
                                        : 'bg-transparent text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                                    props.isDisabled ? 'cursor-not-allowed opacity-50' : ''
                                ].filter(Boolean).join(' ')}
                            >
                                <input
                                    type="radio"
                                    name="agent"
                                    value={agentType}
                                    checked={checked}
                                    onChange={() => props.onAgentChange(agentType)}
                                    disabled={props.isDisabled}
                                    className="sr-only"
                                />
                                <AgentFlavorIcon flavor={agentType} className="h-5 w-5" />
                                <span className="whitespace-nowrap">{label}</span>
                            </label>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
