import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The two detail routes have different data and command transports, but they
 * should feel like the same screen. This component is the shared visual
 * frame; source-specific components stay inside it and keep their own
 * capabilities.
 */
export type SessionDetailSource = 'hapi' | 'codex'

export function SessionDetailSurface(props: {
    source: SessionDetailSource
    children: ReactNode
    testId?: string
    className?: string
}) {
    return (
        <div
            className={cn(
                'relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]',
                props.className
            )}
            data-session-detail-source={props.source}
            data-testid={props.testId}
        >
            {props.children}
        </div>
    )
}

/** Shared flex column that owns the detail page's scroll/content region. */
export function SessionDetailContent(props: {
    children: ReactNode
    ariaLabel?: string
    className?: string
}) {
    return (
        <main
            className={cn('flex min-h-0 flex-1 flex-col', props.className)}
            aria-label={props.ariaLabel}
            data-testid="session-detail-content"
        >
            {props.children}
        </main>
    )
}
