import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

export function QueueIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M5 7h14" />
            <path d="M5 12h10" />
            <path d="M5 17h7" />
            <path d="m17 15 2 2 3-4" />
        </svg>
    )
}

export function ChevronUpIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m6 15 6-6 6 6" />
        </svg>
    )
}

/**
 * Shared compact entry point for HAPI and native Codex queues.  The drawer
 * behind it can have different capabilities, but the affordance stays in the
 * same place, with the same hit target and visual hierarchy.
 */
type SessionDetailQueueTriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'aria-expanded'> & {
    label: string
    preview: string
    count: number
    open: boolean
    testId: string
    icon?: ReactNode
}

export const SessionDetailQueueTrigger = forwardRef<HTMLButtonElement, SessionDetailQueueTriggerProps>((props, ref) => {
    const { label, preview, count, open, testId, icon, children: _children, className, ...buttonProps } = props
    return (
        <button
            ref={ref}
            type="button"
            data-testid={testId}
            aria-label={label}
            aria-expanded={open}
            {...buttonProps}
            className={`pointer-events-auto touch-manipulation group flex min-h-16 w-full items-center gap-3 rounded-[28px] border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-3 text-left shadow-[0_10px_28px_rgba(15,23,42,0.08)] transition-[border-color,box-shadow,background-color] duration-150 hover:border-[color-mix(in_srgb,var(--app-link)_28%,var(--app-border))] hover:shadow-[0_14px_32px_rgba(15,23,42,0.12)] active:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] motion-reduce:transition-none${className ? ` ${className}` : ''}`}
        >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--app-hint)]">
                {icon ?? <QueueIcon className="h-5 w-5" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 text-[var(--app-fg)]">
                {preview}
            </span>
            {count > 1 ? (
                <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-[var(--app-hint)]" aria-hidden="true">
                    +{count - 1}
                </span>
            ) : null}
            <ChevronUpIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
    )
})
SessionDetailQueueTrigger.displayName = 'SessionDetailQueueTrigger'
