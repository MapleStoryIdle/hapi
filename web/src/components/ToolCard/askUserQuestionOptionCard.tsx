import { cn } from '@/lib/utils'

export type AskUserQuestionChoiceMode = 'single' | 'multi'

export const askUserQuestionOptionTitleClassName = 'chat-option-title tracking-tight min-w-0 text-sm font-medium leading-tight break-words text-[var(--app-fg)]'
export const askUserQuestionOptionDescriptionClassName = 'chat-option-description mt-1 font-mono text-xs break-all text-[var(--app-tool-card-subtitle)]'
export const askUserQuestionQuoteClassName = 'tool-result-quote rounded-r-2xl border-l-[3px] border-[var(--app-md-quote-border)] bg-[var(--app-md-quote-bg)] px-4 py-3 text-sm leading-6 text-[var(--app-md-quote-fg)] [&_.aui-md]:text-inherit [&_.aui-md]:text-sm [&_.aui-md]:leading-6 [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6 [&_.aui-md-strong]:text-inherit'

export function getAskUserQuestionOptionFrameClassName(checked: boolean, className?: string, interactive = false): string {
    return cn(
        className,
        'rounded-[22px] border-[1.5px] p-[2px]',
        interactive
            ? checked
                ? 'border-[var(--app-button)]'
                : 'border-[var(--app-border)] hover:border-[var(--app-button)]'
            : checked
                ? 'border-[var(--app-md-quote-border)]'
                : 'border-transparent'
    )
}

export function AskUserQuestionSelectionControl(props: {
    checked: boolean
    mode: AskUserQuestionChoiceMode
    interactive?: boolean
}) {
    if (props.mode === 'multi') {
        return (
            <span
                className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                    props.checked
                        ? props.interactive
                            ? 'border-[var(--app-button)] bg-[var(--app-button)]'
                            : 'border-[var(--app-tool-card-accent)] bg-[var(--app-tool-card-accent)]'
                        : 'border-[var(--app-border)] bg-[var(--app-bg)]'
                )}
                aria-hidden="true"
            >
                {props.checked ? (
                    <svg className={cn('h-3 w-3', props.interactive ? 'text-[var(--app-button-text)]' : 'text-[var(--app-bg)]')} viewBox="0 0 16 16" fill="none">
                        <path
                            d="M3.5 8.2l2.8 2.8 6.2-6"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                ) : null}
            </span>
        )
    }

    return (
        <span
            className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                props.checked
                    ? props.interactive ? 'border-[var(--app-button)]' : 'border-[var(--app-tool-card-accent)]'
                    : 'border-[var(--app-border)] bg-[var(--app-bg)]'
            )}
            aria-hidden="true"
        >
            {props.checked ? (
                <span className={cn('h-2 w-2 rounded-full', props.interactive ? 'bg-[var(--app-button)]' : 'bg-[var(--app-tool-card-accent)]')} />
            ) : null}
        </span>
    )
}

export function AskUserQuestionOptionBody(props: {
    checked: boolean
    mode: AskUserQuestionChoiceMode
    title: string
    description?: string | null
    customLabel?: string | null
    interactive?: boolean
    showControl?: boolean
}) {
    const showControl = props.showControl ?? true

    return (
        <span
            className={cn(
                'flex items-center gap-3 rounded-[20px] px-3 py-2 transition-colors',
                props.interactive
                    ? props.checked
                        ? 'bg-[color-mix(in_srgb,var(--app-button)_10%,var(--app-dialog-bg))]'
                        : 'bg-[var(--app-dialog-bg)]'
                    : 'bg-[var(--app-tool-card-bg)]',
                !props.interactive && !props.checked ? 'opacity-70' : null
            )}
        >
            {showControl ? (
                <AskUserQuestionSelectionControl checked={props.checked} mode={props.mode} interactive={props.interactive} />
            ) : null}
            <span className="min-w-0 flex-1">
                <span className={cn(
                    'block',
                    askUserQuestionOptionTitleClassName,
                    props.checked || props.interactive
                        ? 'text-[var(--app-fg)]'
                        : 'text-[var(--app-tool-card-subtitle)]'
                )}>
                    {props.title}
                </span>
                {props.description ? (
                    <span className={cn('block', askUserQuestionOptionDescriptionClassName)}>
                        {props.description}
                    </span>
                ) : null}
                {props.customLabel ? (
                    <span className={cn('block', askUserQuestionOptionDescriptionClassName)}>
                        {props.customLabel}
                    </span>
                ) : null}
            </span>
        </span>
    )
}
