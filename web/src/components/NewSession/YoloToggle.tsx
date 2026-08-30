import { useTranslation } from '@/lib/use-translation'

const YOLO_OPTIONS = [
    { value: false, labelKey: 'newSession.yolo.default' },
    { value: true, labelKey: 'newSession.yolo.mode' }
] as const

export function YoloToggle(props: {
    yoloMode: boolean
    isDisabled: boolean
    inline?: boolean
    onToggle: (value: boolean) => void
}) {
    const { t } = useTranslation()

    const segmentedToggle = (
        <div
            role="radiogroup"
            aria-label={t('newSession.yolo')}
            className="inline-flex h-11 w-full min-w-0 items-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-0.5"
        >
            {YOLO_OPTIONS.map((option) => {
                const checked = props.yoloMode === option.value
                return (
                    <label
                        key={option.labelKey}
                        className={[
                            'inline-flex h-10 flex-1 cursor-pointer items-center justify-center rounded-[14px] px-3 text-sm font-medium transition-colors',
                            checked
                                ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                            props.isDisabled ? 'cursor-not-allowed opacity-50' : ''
                        ].filter(Boolean).join(' ')}
                    >
                        <input
                            type="radio"
                            name="new-session-yolo"
                            checked={checked}
                            onChange={() => props.onToggle(option.value)}
                            disabled={props.isDisabled}
                            className="sr-only"
                        />
                        {t(option.labelKey)}
                    </label>
                )
            })}
        </div>
    )

    if (props.inline) {
        return (
            <div className="flex min-w-0 flex-col gap-1.5">
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    {t('newSession.yolo')}
                </label>
                {segmentedToggle}
                {props.yoloMode ? (
                    <span className="text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                        {t('newSession.yolo.desc')}
                    </span>
                ) : null}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-1.5 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
            <label className="text-xs font-medium text-[var(--app-hint)]">
                {t('newSession.yolo')}
            </label>
            <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                    <span className="text-sm text-[var(--app-fg)]">
                        {t('newSession.yolo.title')}
                    </span>
                    <span className="text-xs text-[var(--app-hint)]">
                        {t('newSession.yolo.desc')}
                    </span>
                </div>
                <div className="w-44">
                    {segmentedToggle}
                </div>
            </div>
        </div>
    )
}
