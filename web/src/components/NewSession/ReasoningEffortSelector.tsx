import type { AgentType, NewSessionReasoningEffort } from './types'
import { CODEX_REASONING_EFFORT_OPTIONS, OPENCODE_REASONING_EFFORT_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ReasoningEffortSelector(props: {
    agent: AgentType
    value: NewSessionReasoningEffort
    codexOptions?: { value: NewSessionReasoningEffort; label: string }[]
    isDisabled: boolean
    inline?: boolean
    onChange: (value: NewSessionReasoningEffort) => void
}) {
    const { t } = useTranslation()

    if (props.agent !== 'codex' && props.agent !== 'opencode') {
        return null
    }

    const options = props.agent === 'opencode'
        ? OPENCODE_REASONING_EFFORT_OPTIONS
        : props.codexOptions ?? CODEX_REASONING_EFFORT_OPTIONS

    return (
        <div className={props.inline
            ? 'flex min-w-0 flex-col gap-1.5'
            : 'flex flex-col gap-1.5 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-[0_1px_4px_rgba(0,0,0,0.03)]'}
        >
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.reasoningEffort')}{' '}
                {!props.inline ? (
                    <span className="font-normal">({t('newSession.model.optional')})</span>
                ) : null}
            </label>
            <select
                value={props.value}
                onChange={(e) => props.onChange(e.target.value as NewSessionReasoningEffort)}
                disabled={props.isDisabled}
                className="h-11 w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 font-sans text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
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
