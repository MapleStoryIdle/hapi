import type { AgentType, ClaudeEffort } from './types'
import { CLAUDE_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ClaudeEffortSelector(props: {
    agent: AgentType
    effort: ClaudeEffort
    isDisabled: boolean
    inline?: boolean
    onEffortChange: (value: ClaudeEffort) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'claude') {
        return null
    }

    return (
        <div className={props.inline
            ? 'flex min-w-0 flex-col gap-1.5'
            : 'flex flex-col gap-1.5 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-[0_1px_4px_rgba(0,0,0,0.03)]'}
        >
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.effort')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.effort}
                onChange={(e) => props.onEffortChange(e.target.value as ClaudeEffort)}
                disabled={props.isDisabled}
                className="h-11 w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 font-sans text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {CLAUDE_EFFORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
