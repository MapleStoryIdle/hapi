import type { AgentType, NewSessionReasoningEffort } from './types'
import { CODEX_REASONING_EFFORT_OPTIONS, OPENCODE_REASONING_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ReasoningEffortSelector(props: {
    agent: AgentType
    value: NewSessionReasoningEffort
    isDisabled: boolean
    onChange: (value: NewSessionReasoningEffort) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex' && props.agent !== 'opencode') {
        return null
    }

    const options = props.agent === 'opencode'
        ? OPENCODE_REASONING_EFFORT_OPTIONS
        : CODEX_REASONING_EFFORT_OPTIONS

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.reasoningEffort')}{' '}
                <span className="font-normal">({t('newSession.model.optional')})</span>
            </label>
            <select
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as NewSessionReasoningEffort)}
                disabled={props.isDisabled}
                className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 font-sans text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </div>
    )
}
