import type { ReactNode } from 'react'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

export const SESSION_DETAIL_HEADER_HEIGHT_PX = 56
export const SESSION_DETAIL_HEADER_SAFE_AREA_CLASS = 'pt-[max(var(--app-safe-area-top),0.75rem)]'
export const SESSION_DETAIL_HEADER_ROW_CLASS = 'mx-auto flex h-14 w-full max-w-content items-center gap-2 px-3'

function BackIcon() {
    return (
        <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M15 18l-6-6 6-6" />
        </svg>
    )
}

/** Shared, fixed-height title bar for secondary session views. */
export function SessionDetailHeader(props: {
    title: ReactNode
    subtitle?: ReactNode
    onBack: () => void
    actions?: ReactNode
    className?: string
}) {
    const { t } = useTranslation()
    return (
        <header
            className={cn(
                'shrink-0 border-b border-[var(--app-border)] bg-[var(--app-bg)]',
                SESSION_DETAIL_HEADER_SAFE_AREA_CLASS,
                props.className
            )}
            data-testid="session-detail-header"
        >
            <div className={SESSION_DETAIL_HEADER_ROW_CLASS} data-testid="session-detail-header-row">
                <button
                    type="button"
                    onClick={props.onBack}
                    className="touch-manipulation flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={t('session.back')}
                    title={t('session.back')}
                >
                    <BackIcon />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold leading-5 text-[var(--app-fg)]">{props.title}</div>
                    {props.subtitle ? (
                        <div className="truncate text-xs leading-5 text-[var(--app-hint)]">{props.subtitle}</div>
                    ) : null}
                </div>
                {props.actions ? (
                    <div className="flex shrink-0 items-center gap-1">
                        {props.actions}
                    </div>
                ) : null}
            </div>
        </header>
    )
}
