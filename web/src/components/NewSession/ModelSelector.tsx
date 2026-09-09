import type { AgentType } from './types'
import { MODEL_OPTIONS } from './types'
import { useTranslation } from '@/lib/use-translation'

export function ModelSelector(props: {
    agent: AgentType
    model: string
    label?: string
    options?: Array<{ value: string; label: string }>
    isDisabled: boolean
    isLoading?: boolean
    error?: string | null
    inline?: boolean
    onModelChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const options = props.options ?? MODEL_OPTIONS[props.agent]
    if (options.length === 0) {
        return null
    }

    return (
        <div className={props.inline
            ? 'col-span-2 flex min-w-0 flex-col gap-1.5 sm:col-span-1'
            : 'flex flex-col gap-1.5 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-[0_1px_4px_rgba(0,0,0,0.03)]'}
        >
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {props.label ?? t('newSession.model')}{' '}
                {!props.inline && !props.label ? (
                    <span className="font-normal">({t('newSession.model.optional')})</span>
                ) : null}
            </label>
            <select
                aria-label={props.label ?? t('newSession.model')}
                value={props.model}
                onChange={(e) => props.onModelChange(e.target.value)}
                disabled={props.isDisabled || props.isLoading}
                className="h-11 w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 font-sans text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
            {props.error ? (
                <div className="text-xs text-red-600">
                    {props.error}
                </div>
            ) : null}
        </div>
    )
}
