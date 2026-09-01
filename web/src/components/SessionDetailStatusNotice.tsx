import { CircleAlert, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type SessionDetailStatusTone = 'loading' | 'processing' | 'warning' | 'error'

export type SessionDetailStatusAction = {
    label: string
    onClick: () => void
    disabled?: boolean
    busy?: boolean
}

/**
 * One restrained status surface for both detail routes.
 *
 * Connection health is intentionally not represented here: the floating
 * connection control owns that state. This component is for work/data state
 * that needs a short explanation or an explicit retry action.
 */
export function SessionDetailStatusNotice(props: {
    tone: SessionDetailStatusTone
    title: ReactNode
    detail?: ReactNode
    action?: SessionDetailStatusAction
    /** An optional secondary control, for cancelling an in-flight action. */
    secondaryAction?: SessionDetailStatusAction
    compact?: boolean
    className?: string
    testId?: string
    role?: 'status' | 'alert'
    /** Optional stateful visual, such as a morphing transport phase icon. */
    leadingVisual?: ReactNode
}) {
    const isCompact = props.compact === true
    const isError = props.tone === 'error'
    const isBusy = props.tone === 'loading' || props.tone === 'processing'
    const toneClass = props.tone === 'error'
        ? 'border-red-500/25'
        : props.tone === 'warning'
            ? 'border-amber-500/25'
            : props.tone === 'loading'
                ? 'border-sky-500/20'
                : 'border-[var(--app-divider)]'
    const iconClass = props.tone === 'error'
        ? 'text-red-500'
        : props.tone === 'warning'
            ? 'text-amber-500'
            : props.tone === 'loading'
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-sky-600 dark:text-sky-400'
    const actionClass = isError
        ? 'text-red-600 hover:bg-red-500/10 focus-visible:ring-red-500'
        : props.tone === 'warning'
            ? 'text-amber-700 hover:bg-amber-500/10 focus-visible:ring-amber-500 dark:text-amber-400'
            : 'text-sky-700 hover:bg-sky-500/10 focus-visible:ring-sky-500 dark:text-sky-400'

    const leadingVisual = props.leadingVisual ?? (props.tone === 'processing' ? (
        <span
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500', isCompact ? 'motion-safe:animate-pulse' : 'mt-1.5')}
            aria-hidden="true"
        />
    ) : props.tone === 'loading' ? (
        <LoaderCircle className={cn('shrink-0 animate-spin', isCompact ? 'h-3.5 w-3.5' : 'mt-0.5 h-4 w-4', iconClass)} aria-hidden="true" />
    ) : (
        <CircleAlert className={cn('shrink-0', isCompact ? 'h-3.5 w-3.5' : 'mt-0.5 h-4 w-4', iconClass)} aria-hidden="true" />
    ))

    return (
        <div
            className={cn(
                'pointer-events-auto mx-auto text-left',
                isCompact
                    ? 'flex w-fit max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[11px] font-medium'
                    : 'flex max-h-[min(60dvh,28rem)] w-full max-w-content flex-col overflow-hidden rounded-xl px-3 py-2.5 text-sm shadow-[0_10px_28px_rgba(15,23,42,0.10)] dark:shadow-[0_10px_28px_rgba(0,0,0,0.22)]',
                'border bg-[var(--app-bg)]',
                toneClass,
                props.className
            )}
            data-testid={props.testId}
            data-status-tone={props.tone}
            role={props.role ?? (isError ? 'alert' : 'status')}
            aria-live={isError ? 'assertive' : 'polite'}
            aria-busy={isBusy || undefined}
        >
            <div
                className={cn(
                    isCompact ? 'contents' : 'flex min-h-0 flex-1 items-start gap-2.5'
                )}
            >
                {leadingVisual}

                <div
                    data-status-content
                    className={cn(
                        'min-w-0',
                        isCompact
                            ? 'truncate'
                            : 'min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5'
                    )}
                >
                    <div className={cn('font-medium', isCompact ? 'truncate' : 'font-semibold text-[var(--app-fg)]')}>
                        {props.title}
                    </div>
                    {!isCompact && props.detail ? (
                        <div className="mt-0.5 break-words text-xs leading-4 text-[var(--app-hint)]">
                            {props.detail}
                        </div>
                    ) : null}
                </div>
            </div>

            {props.action || props.secondaryAction ? (
                <div
                    data-status-actions
                    className={cn(
                        'flex shrink-0 items-center gap-1',
                        !isCompact && 'mt-2 flex-wrap justify-end border-t border-[var(--app-divider)] pt-2'
                    )}
                >
                    {props.action ? (
                        <button
                            type="button"
                            onClick={props.action.onClick}
                            disabled={props.action.disabled || props.action.busy}
                            aria-busy={props.action.busy || undefined}
                            className={cn(
                                'rounded-lg px-2 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-45',
                                actionClass
                            )}
                        >
                            {props.action.busy ? <LoaderCircle className="mr-1 inline-block h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                            {props.action.label}
                        </button>
                    ) : null}
                    {props.secondaryAction ? (
                        <button
                            type="button"
                            onClick={props.secondaryAction.onClick}
                            disabled={props.secondaryAction.disabled || props.secondaryAction.busy}
                            aria-busy={props.secondaryAction.busy || undefined}
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-[var(--app-hint)] transition-colors hover:bg-[var(--app-muted)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {props.secondaryAction.busy ? <LoaderCircle className="mr-1 inline-block h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                            {props.secondaryAction.label}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}
