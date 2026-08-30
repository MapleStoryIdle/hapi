import { Spinner } from '@/components/Spinner'
import {
    SESSION_DETAIL_HEADER_HEIGHT_PX,
    SESSION_DETAIL_HEADER_ROW_CLASS,
    SESSION_DETAIL_HEADER_SAFE_AREA_CLASS
} from '@/components/SessionDetailHeader'
import { SessionDetailContent, SessionDetailSurface } from '@/components/SessionDetailSurface'
import { SessionDetailBottomDock, SessionDetailBottomDockComposer } from '@/components/SessionDetailBottomDock'
import { useReliableTopEdgeAction } from '@/hooks/useReliableTopEdgeAction'
import { mobileLayoutHeaderShellStyle } from '@/lib/mobileLayoutContract'
import { useTranslation } from '@/lib/use-translation'

const MESSAGE_ROWS = [
    { align: 'end', width: 'w-2/3', height: 'h-10' },
    { align: 'start', width: 'w-5/6', height: 'h-14' },
    { align: 'start', width: 'w-3/5', height: 'h-9' }
] as const

function LoadingBackIcon() {
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

function SessionEntryLoadingHeader(props: {
    onBack: () => void
    backLabel: string
    loadingLabel: string
}) {
    const backActivation = useReliableTopEdgeAction(props.onBack)

    return (
        <div
            className={`pointer-events-auto absolute inset-x-0 top-0 z-40 isolate touch-manipulation ${SESSION_DETAIL_HEADER_SAFE_AREA_CLASS}`}
            style={mobileLayoutHeaderShellStyle}
            data-testid="session-entry-loading-header"
        >
            <div className={SESSION_DETAIL_HEADER_ROW_CLASS}>
                <div className="pointer-events-auto flex h-11 min-w-0 items-center gap-0 rounded-full border border-[color-mix(in_srgb,var(--app-fg)_14%,var(--app-bg))] bg-[var(--app-bg)] px-1 shadow-[0_8px_24px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]">
                    <button
                        type="button"
                        {...backActivation}
                        data-testid="session-entry-loading-back"
                        aria-label={props.backLabel}
                        title={props.backLabel}
                        className="pointer-events-auto touch-manipulation flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <LoadingBackIcon />
                    </button>
                    <div
                        className="flex h-11 min-w-0 items-center gap-2 truncate pr-3 text-[15px] font-medium leading-5 text-[var(--app-hint)]"
                        role="status"
                        aria-live="polite"
                        aria-label={props.loadingLabel}
                    >
                        <Spinner size="sm" label={null} />
                        <span className="truncate">{props.loadingLabel}</span>
                    </div>
                </div>
            </div>
        </div>
    )
}

/**
 * A shared first-paint conversation shape. It lives inside a
 * SessionDetailContent so HAPI and native Codex sessions arrive in the same
 * familiar frame while their transcript requests are still in flight.
 */
export function SessionConversationLoading(props: {
    label: string
    testId?: string
    composerTestId?: string
}) {
    return (
        <>
            <div className="app-scroll-y min-h-0 flex-1 overflow-x-hidden">
                <div
                    className="session-thread-content mx-auto min-h-full w-full max-w-content bg-[var(--app-chat-canvas)] p-3"
                    style={{
                        paddingTop: `calc(max(var(--app-safe-area-top), 0.75rem) + ${SESSION_DETAIL_HEADER_HEIGHT_PX}px)`,
                        paddingBottom: 'calc(var(--app-safe-area-bottom) + 6rem)'
                    }}
                >
                    <div
                        className="mx-auto w-full max-w-content space-y-3 motion-safe:animate-bounce-in"
                        data-testid={props.testId}
                        role="status"
                        aria-live="polite"
                        aria-label={props.label}
                        aria-busy="true"
                    >
                        {MESSAGE_ROWS.map((row, index) => (
                            <div
                                key={`${row.align}-${index}`}
                                className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'}
                                data-testid="session-entry-message-skeleton"
                                aria-hidden="true"
                            >
                                <div
                                    className={`${row.height} ${row.width} rounded-2xl bg-[var(--app-subtle-bg)] motion-safe:animate-pulse`}
                                />
                            </div>
                        ))}
                        <div className="inline-flex items-center gap-2 rounded-full bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                            <Spinner size="sm" label={null} />
                            <span>{props.label}</span>
                        </div>
                    </div>
                </div>
            </div>
            <SessionDetailBottomDock bottom={0}>
                <SessionDetailBottomDockComposer testId={props.composerTestId}>
                    <div className="px-3 pb-[calc(var(--app-safe-area-bottom)+0.75rem)] pt-2" aria-hidden="true">
                        <div className="mx-auto flex w-full max-w-content items-center gap-2">
                            <div className="h-11 flex-1 rounded-[22px] bg-[var(--app-secondary-bg)] motion-safe:animate-pulse" />
                            <div className="h-11 w-11 shrink-0 rounded-full bg-[var(--app-secondary-bg)] motion-safe:animate-pulse" />
                        </div>
                    </div>
                </SessionDetailBottomDockComposer>
            </SessionDetailBottomDock>
        </>
    )
}

/**
 * Cold HAPI session navigation used to show a blank page with a centered
 * spinner until the session record arrived. Keep the wait in the familiar
 * conversation frame instead, so the header remains usable and the first
 * real messages replace a shape that already looks like the destination.
 */
export function SessionEntryLoading(props: { onBack: () => void }) {
    const { t } = useTranslation()

    return (
        <SessionDetailSurface source="hapi" testId="session-entry-loading">
            <SessionEntryLoadingHeader
                onBack={props.onBack}
                backLabel={t('session.back')}
                loadingLabel={t('loading.session')}
            />
            <SessionDetailContent ariaLabel={t('loading.session')}>
                <SessionConversationLoading
                    label={t('misc.loadingMessages')}
                    testId="session-entry-messages-loading"
                    composerTestId="session-entry-composer-skeleton"
                />
            </SessionDetailContent>
        </SessionDetailSurface>
    )
}
