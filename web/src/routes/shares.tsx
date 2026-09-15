import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ReactNode,
    type Ref
} from 'react'
import {
    CircleCheck,
    CircleDot,
    Clock3,
    Ellipsis,
    FileText,
    Inbox,
    LoaderCircle,
    RefreshCw,
    Search
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { article as MotionArticle, div as MotionDiv } from 'motion/react-m'
import { ApiError } from '@/api/client'
import {
    CopyIcon,
    RevokeLinkIcon,
    SessionIcon,
    ShareIcon
} from '@/components/icons'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAppContext } from '@/lib/app-context'
import { getShareCacheNamespace } from '@/lib/shareCacheScope'
import { queryKeys } from '@/lib/query-keys'
import { type ToastInput, useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useLocalDayKey } from '@/hooks/useLocalDayKey'
import {
    formatShareTimelineTime,
    groupShareTimeline
} from '@/lib/shareTimeline'
import { useShares } from '@/hooks/queries/useShares'
import type { ShareSummary } from '@/types/api'

type Translate = (
    key: string,
    params?: Record<string, string | number>
) => string

export type ShareFilter = 'all' | 'waiting' | 'feedback' | 'delivered'

type ShareFilterBucket = Exclude<ShareFilter, 'all'>

function shareDetailsTarget(
    shareId: string
): Pick<ToastInput, 'sessionId' | 'url'> {
    return { sessionId: '', url: `/shares/${shareId}` }
}

function sourceSessionTarget(
    share: ShareSummary
): Pick<ToastInput, 'sessionId' | 'url'> {
    if (share.source?.type === 'hapi')
        return { sessionId: share.source.sessionId, url: '' }
    if (share.source?.type === 'native-codex') {
        return {
            sessionId: '',
            url: `/sessions/codex/${encodeURIComponent(share.source.codexSessionId)}?machineId=${encodeURIComponent(share.source.machineId)}`
        }
    }
    return shareDetailsTarget(share.id)
}

export function feedbackDeliveryFailureToast(
    share: ShareSummary,
    reason: unknown,
    t: Translate
): ToastInput {
    const code = reason instanceof ApiError ? reason.code : undefined
    switch (code) {
        case 'source_session_permission_unsafe':
            return {
                title: t('shares.toast.permissionUnsafe.title'),
                body: t('shares.toast.permissionUnsafe.body'),
                kind: 'error',
                ...sourceSessionTarget(share)
            }
        case 'source_session_running':
            return {
                title: t('shares.toast.sourceRunning.title'),
                body: t('shares.toast.sourceRunning.body'),
                kind: 'warning',
                ...sourceSessionTarget(share)
            }
        case 'source_session_offline':
        case 'source_session_unavailable':
        case 'native_source_machine_offline':
        case 'native_source_session_unavailable':
        case 'native_source_runner_unreachable':
        case 'native_source_status_unknown':
            return {
                title: t('shares.toast.sourceUnavailable.title'),
                body: t('shares.toast.sourceUnavailable.body'),
                kind: 'error',
                ...sourceSessionTarget(share)
            }
        case 'native_source_namespace_unsupported':
            return {
                title: t('shares.actions.deliveryFailed'),
                body: t('shares.toast.deliveryFailed.body'),
                kind: 'error',
                ...sourceSessionTarget(share)
            }
        case 'feedback_review_already_sent':
            return {
                title: t('shares.actions.delivered'),
                body: t('shares.toast.reviewAlreadySent.body'),
                kind: 'success',
                ...sourceSessionTarget(share)
            }
        case 'feedback_review_delivering':
            return {
                title: t('shares.toast.reviewDelivering.title'),
                body: t('shares.toast.reviewDelivering.body'),
                kind: 'warning',
                ...shareDetailsTarget(share.id)
            }
        case 'feedback_not_ready':
            return {
                title: t('shares.toast.feedbackNotReady.title'),
                body: t('shares.toast.feedbackNotReady.body'),
                kind: 'warning',
                ...shareDetailsTarget(share.id)
            }
        case 'feedback_unreadable':
            return {
                title: t('shares.toast.feedbackUnreadable.title'),
                body: t('shares.toast.feedbackUnreadable.body'),
                kind: 'error',
                ...shareDetailsTarget(share.id)
            }
        default:
            return {
                title: t('shares.actions.deliveryFailed'),
                body: t('shares.toast.deliveryFailed.body'),
                kind: 'error',
                ...shareDetailsTarget(share.id)
            }
    }
}

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="m15 18-6-6 6-6" />
        </svg>
    )
}

function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024)
        return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimestamp(timestamp: number, locale: string): string {
    if (!Number.isFinite(timestamp)) return '—'
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(timestamp))
}

function formatRelativeExpiry(
    expiresAt: number,
    locale: string,
    now = Date.now()
): string {
    if (!Number.isFinite(expiresAt)) return '—'

    const delta = expiresAt - now
    const absoluteDelta = Math.abs(delta)
    const [unit, unitMs]: [Intl.RelativeTimeFormatUnit, number] =
        absoluteDelta < 60 * 60 * 1000
            ? ['minute', 60 * 1000]
            : absoluteDelta < 24 * 60 * 60 * 1000
              ? ['hour', 60 * 60 * 1000]
              : ['day', 24 * 60 * 60 * 1000]
    const amount = Math.max(1, Math.ceil(absoluteDelta / unitMs))
    const relativeAmount = delta > 0 ? amount : -amount

    return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(
        relativeAmount,
        unit
    )
}

/**
 * The compact filters deliberately collapse only workflow-adjacent states:
 * waiting = published / awaiting_feedback; feedback = feedback_received /
 * review_sending; delivered = review_sent. Timeline rows still show the exact
 * backend status, so an in-progress delivery is never presented as delivered.
 */
export function getShareFilterBucket(
    status: ShareSummary['status']
): ShareFilterBucket {
    switch (status) {
        case 'published':
        case 'awaiting_feedback':
            return 'waiting'
        case 'feedback_received':
        case 'review_sending':
            return 'feedback'
        case 'review_sent':
            return 'delivered'
    }
}

export function matchesShareFilter(
    share: ShareSummary,
    filter: ShareFilter
): boolean {
    return filter === 'all' || getShareFilterBucket(share.status) === filter
}

export function matchesShareSearch(
    share: ShareSummary,
    query: string
): boolean {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return true

    return [
        share.filename,
        share.sourceContext?.directoryName,
        share.sourceContext?.gitBranch
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
}

function ShareStatusIcon(props: {
    status: ShareSummary['status']
    className?: string
}) {
    const className = props.className ?? 'h-3.5 w-3.5'
    switch (props.status) {
        case 'published':
            return <CircleDot className={className} aria-hidden="true" />
        case 'awaiting_feedback':
            return <Clock3 className={className} aria-hidden="true" />
        case 'feedback_received':
            return <Inbox className={className} aria-hidden="true" />
        case 'review_sending':
            return <LoaderCircle className={className} aria-hidden="true" />
        case 'review_sent':
            return <CircleCheck className={className} aria-hidden="true" />
    }
}

function getStatusClassName(status: ShareSummary['status']): string {
    switch (status) {
        case 'awaiting_feedback':
            return 'text-amber-700 dark:text-amber-300'
        case 'feedback_received':
            return 'text-emerald-700 dark:text-emerald-300'
        case 'review_sending':
            return 'text-amber-700 dark:text-amber-300'
        case 'review_sent':
            return 'text-indigo-700 dark:text-indigo-300'
        default:
            return 'text-[var(--app-hint)]'
    }
}

function ActionToolbarButton(props: {
    label: string
    ariaLabel: string
    disabled?: boolean
    onClick: () => void
    buttonRef?: Ref<HTMLButtonElement>
    ariaExpanded?: boolean
    ariaControls?: string
    iconOnly?: boolean
    children: ReactNode
}) {
    return (
        <button
            ref={props.buttonRef}
            type="button"
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.ariaLabel}
            aria-expanded={props.ariaExpanded}
            aria-controls={props.ariaControls}
            title={props.ariaLabel}
            className="flex h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <span aria-hidden="true" className="shrink-0">
                {props.children}
            </span>
            {props.iconOnly ? null : (
                <span className="truncate">{props.label}</span>
            )}
        </button>
    )
}

export function ShareCard(props: {
    share: ShareSummary
    locale: string
    now: number
    pending: boolean
    onCopyLink: (share: ShareSummary) => void
    onOpenSourceSession: (source: NonNullable<ShareSummary['source']>) => void
    onDeliverToSourceSession: (share: ShareSummary) => void
    onOpenDetails: (share: ShareSummary) => void
    onRevoke: (share: ShareSummary) => void
    labels: {
        expiresAt: string
        copy: string
        copyLink: string
        source: string
        sourceSession: string
        deliver: string
        deliverToSource: string
        more: string
        details: string
        revoke: string
    }
}) {
    const source = props.share.source
    const sourceContext = props.share.sourceContext
    const canDeliver = Boolean(
        source && props.share.status === 'feedback_received'
    )
    const [moreOpen, setMoreOpen] = useState(false)
    const menuId = `share-card-more-${useId()}`
    const menuRef = useRef<HTMLDivElement | null>(null)
    const moreButtonRef = useRef<HTMLButtonElement | null>(null)

    const closeMoreMenu = useCallback((restoreFocus = false) => {
        setMoreOpen(false)
        if (restoreFocus) moreButtonRef.current?.focus()
    }, [])

    useEffect(() => {
        if (!moreOpen) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (
                menuRef.current?.contains(target) ||
                moreButtonRef.current?.contains(target)
            )
                return
            closeMoreMenu()
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            closeMoreMenu(true)
        }
        const handleFocusIn = (event: FocusEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (
                menuRef.current?.contains(target) ||
                moreButtonRef.current?.contains(target)
            )
                return
            closeMoreMenu()
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('focusin', handleFocusIn)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('focusin', handleFocusIn)
        }
    }, [closeMoreMenu, moreOpen])

    useEffect(() => {
        if (props.pending) setMoreOpen(false)
    }, [props.pending])

    return (
        <MotionArticle
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="relative rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
        >
            <div className="overflow-hidden rounded-[inherit]">
                <button
                    type="button"
                    onClick={() => props.onOpenDetails(props.share)}
                    aria-label={`${props.labels.details}: ${props.share.filename}`}
                    className="block w-full min-w-0 p-3.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]"
                >
                    <span className="flex min-w-0 items-start gap-2.5">
                        <span
                            aria-hidden="true"
                            className="mt-0.5 shrink-0 text-[var(--app-hint)]"
                        >
                            <FileText
                                className="h-[18px] w-[18px]"
                                strokeWidth={1.8}
                            />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span
                                className="block truncate text-[15px] font-semibold leading-5 text-[var(--app-fg)]"
                                title={props.share.filename}
                            >
                                {props.share.filename}
                            </span>
                            {sourceContext ? (
                                <span
                                    data-testid="share-source-context"
                                    className="mt-1 flex min-w-0 items-center gap-1 truncate text-xs text-[var(--app-hint)]"
                                >
                                    <span
                                        className="truncate"
                                        title={sourceContext.directoryName}
                                    >
                                        {sourceContext.directoryName}
                                    </span>
                                    {sourceContext.gitBranch ? (
                                        <>
                                            <span aria-hidden="true">·</span>
                                            <span
                                                className="truncate"
                                                title={sourceContext.gitBranch}
                                            >
                                                {sourceContext.gitBranch}
                                            </span>
                                        </>
                                    ) : null}
                                </span>
                            ) : null}
                            <span className="mt-2 flex min-w-0 items-center gap-2 text-xs text-[var(--app-hint)]">
                                <span
                                    data-testid="share-size"
                                    className="shrink-0"
                                >
                                    {formatBytes(props.share.size)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span
                                    className="flex min-w-0 items-center gap-1 truncate"
                                    title={`${props.labels.expiresAt}: ${formatTimestamp(props.share.expiresAt, props.locale)}`}
                                >
                                    <Clock3
                                        className="h-3.5 w-3.5 shrink-0"
                                        aria-hidden="true"
                                    />
                                    {formatRelativeExpiry(
                                        props.share.expiresAt,
                                        props.locale,
                                        props.now
                                    )}
                                </span>
                            </span>
                        </span>
                    </span>
                </button>

                <div className="flex gap-2 border-t border-[var(--app-border)] bg-[var(--app-subtle-bg)]/35 p-2">
                    <div className="min-w-0 flex-1">
                        <ActionToolbarButton
                            label={props.labels.copy}
                            ariaLabel={props.labels.copyLink}
                            disabled={props.pending}
                            onClick={() => props.onCopyLink(props.share)}
                        >
                            <CopyIcon className="h-[17px] w-[17px]" />
                        </ActionToolbarButton>
                    </div>
                    {source ? (
                        <div className="min-w-0 flex-1">
                            <ActionToolbarButton
                                label={props.labels.source}
                                ariaLabel={props.labels.sourceSession}
                                disabled={props.pending}
                                onClick={() =>
                                    props.onOpenSourceSession(source)
                                }
                            >
                                <SessionIcon className="h-[18px] w-[18px]" />
                            </ActionToolbarButton>
                        </div>
                    ) : null}
                    {canDeliver ? (
                        <div className="min-w-0 flex-1">
                            <ActionToolbarButton
                                label={props.labels.deliver}
                                ariaLabel={props.labels.deliverToSource}
                                disabled={props.pending}
                                onClick={() =>
                                    props.onDeliverToSourceSession(props.share)
                                }
                            >
                                <ShareIcon className="h-[17px] w-[17px]" />
                            </ActionToolbarButton>
                        </div>
                    ) : null}
                    <div className="relative w-11 shrink-0">
                        <ActionToolbarButton
                            label={props.labels.more}
                            ariaLabel={props.labels.more}
                            disabled={props.pending}
                            buttonRef={moreButtonRef}
                            ariaExpanded={moreOpen}
                            ariaControls={moreOpen ? menuId : undefined}
                            iconOnly
                            onClick={() => setMoreOpen((open) => !open)}
                        >
                            <Ellipsis
                                className="h-[18px] w-[18px]"
                                strokeWidth={2}
                            />
                        </ActionToolbarButton>
                    </div>
                </div>
            </div>
            {moreOpen ? (
                <div
                    ref={menuRef}
                    id={menuId}
                    className="absolute bottom-[3.75rem] right-2 z-20 min-w-36 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-[0_12px_32px_rgba(15,23,42,0.16)]"
                >
                    <button
                        type="button"
                        onClick={() => {
                            closeMoreMenu()
                            props.onRevoke(props.share)
                        }}
                        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                        <span aria-hidden="true">
                            <RevokeLinkIcon className="h-[18px] w-[18px]" />
                        </span>
                        {props.labels.revoke}
                    </button>
                </div>
            ) : null}
        </MotionArticle>
    )
}

export default function SharesPage() {
    const { api, baseUrl, token } = useAppContext()
    const { addToast } = useToast()
    const { locale, t } = useTranslation()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { copy } = useCopyToClipboard()
    const namespace = useMemo(() => getShareCacheNamespace(token), [token])
    const { shares, isLoading, error, refetch } = useShares(
        api,
        baseUrl,
        namespace
    )
    const [pendingShareId, setPendingShareId] = useState<string | null>(null)
    const [revokeTarget, setRevokeTarget] = useState<ShareSummary | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [activeFilter, setActiveFilter] = useState<ShareFilter>('all')
    const [now, setNow] = useState(() => Date.now())
    const [refreshPending, setRefreshPending] = useState(false)
    const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
    const localDay = useLocalDayKey()
    const filterCounts = useMemo<Record<ShareFilter, number>>(
        () => ({
            all: shares.length,
            waiting: shares.filter(
                (share) => getShareFilterBucket(share.status) === 'waiting'
            ).length,
            feedback: shares.filter(
                (share) => getShareFilterBucket(share.status) === 'feedback'
            ).length,
            delivered: shares.filter(
                (share) => getShareFilterBucket(share.status) === 'delivered'
            ).length
        }),
        [shares]
    )
    const visibleShares = useMemo(
        () =>
            shares.filter(
                (share) =>
                    matchesShareFilter(share, activeFilter) &&
                    matchesShareSearch(share, searchQuery)
            ),
        [activeFilter, searchQuery, shares]
    )
    const timelineGroups = useMemo(
        () =>
            groupShareTimeline(visibleShares, new Date(), dateLocale, {
                today: t('shares.timeline.today'),
                yesterday: t('shares.timeline.yesterday'),
                daysAgo: (days) => t('shares.timeline.daysAgo', { days })
            }),
        [dateLocale, localDay, t, visibleShares]
    )
    const newFeedbackCount = shares.filter(
        (share) => share.status === 'feedback_received'
    ).length
    const filters: Array<{ id: ShareFilter; label: string }> = [
        { id: 'all', label: t('shares.filters.all') },
        { id: 'waiting', label: t('shares.filters.waiting') },
        { id: 'feedback', label: t('shares.filters.feedback') },
        { id: 'delivered', label: t('shares.filters.delivered') }
    ]

    useEffect(() => {
        const updateNow = () => setNow(Date.now())
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') updateNow()
        }
        const interval = window.setInterval(updateNow, 60_000)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.clearInterval(interval)
            document.removeEventListener(
                'visibilitychange',
                handleVisibilityChange
            )
        }
    }, [])

    const refreshShares = useCallback(async () => {
        setRefreshPending(true)
        try {
            await refetch()
        } finally {
            setRefreshPending(false)
        }
    }, [refetch])

    const openSourceSession = useCallback(
        (source: NonNullable<ShareSummary['source']>) => {
            if (source.type === 'hapi') {
                void navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: source.sessionId }
                })
                return
            }
            void navigate({
                to: '/sessions/codex/$codexSessionId',
                params: { codexSessionId: source.codexSessionId },
                search: { machineId: source.machineId }
            })
        },
        [navigate]
    )

    const openDetails = useCallback(
        (share: ShareSummary) => {
            void navigate({
                to: '/shares/$shareId',
                params: { shareId: share.id }
            })
        },
        [navigate]
    )

    const copyLink = useCallback(
        async (share: ShareSummary) => {
            setPendingShareId(share.id)
            try {
                const result = await api.getShare(share.id)
                if (!result.share.url) {
                    addToast({
                        title: t('shares.actions.copyUnavailable'),
                        body: share.filename,
                        kind: 'warning',
                        ...shareDetailsTarget(share.id)
                    })
                    return
                }
                const copied = await copy(result.share.url)
                addToast({
                    title: copied
                        ? t('shares.actions.copied')
                        : t('shares.actions.copyFailed'),
                    body: share.filename,
                    kind: copied ? 'success' : 'error',
                    ...shareDetailsTarget(share.id)
                })
            } catch {
                addToast({
                    title: t('shares.actions.copyFailed'),
                    body: t('shares.toast.copyFailed.body'),
                    kind: 'error',
                    ...shareDetailsTarget(share.id)
                })
            } finally {
                setPendingShareId(null)
            }
        },
        [addToast, api, copy, t]
    )

    const deliverToSourceSession = useCallback(
        async (share: ShareSummary) => {
            if (!share.source || share.status !== 'feedback_received') return
            setPendingShareId(share.id)
            try {
                await api.deliverShareFeedback(share.id)
                await queryClient.invalidateQueries({
                    queryKey: queryKeys.shares(baseUrl, namespace)
                })
                addToast({
                    title: t('shares.actions.delivered'),
                    body: share.filename,
                    kind: 'success',
                    ...sourceSessionTarget(share)
                })
            } catch (reason) {
                addToast(feedbackDeliveryFailureToast(share, reason, t))
            } finally {
                setPendingShareId(null)
            }
        },
        [addToast, api, baseUrl, namespace, queryClient, t]
    )

    const requestRevoke = useCallback((share: ShareSummary) => {
        setRevokeTarget(share)
    }, [])

    const revoke = useCallback(async () => {
        if (!revokeTarget) return
        setPendingShareId(revokeTarget.id)
        try {
            await api.revokeShare(revokeTarget.id)
            await queryClient.invalidateQueries({
                queryKey: queryKeys.shares(baseUrl, namespace)
            })
            setRevokeTarget(null)
        } catch {
            addToast({
                title: t('shares.revoke'),
                body: t('shares.toast.revokeFailed.body'),
                kind: 'error',
                ...shareDetailsTarget(revokeTarget.id)
            })
        } finally {
            setPendingShareId(null)
        }
    }, [addToast, api, baseUrl, namespace, queryClient, revokeTarget, t])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]">
                <div className="mx-auto flex max-w-[760px] items-center gap-3">
                    <button
                        type="button"
                        onClick={goBack}
                        aria-label={t('shares.back')}
                        title={t('shares.back')}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <BackIcon className="h-5 w-5" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-base font-semibold leading-5 text-[var(--app-fg)]">
                            {t('shares.title')}
                        </h1>
                        <p className="mt-0.5 text-xs text-[var(--app-hint)]">
                            {t(
                                filterCounts.all === 1
                                    ? 'shares.subtitle.tasks.one'
                                    : 'shares.subtitle.tasks.other',
                                { count: filterCounts.all }
                            )}{' '}
                            ·{' '}
                            {t(
                                newFeedbackCount === 1
                                    ? 'shares.subtitle.feedback.one'
                                    : 'shares.subtitle.feedback.other',
                                { count: newFeedbackCount }
                            )}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void refreshShares()}
                        disabled={refreshPending}
                        aria-label={t('shares.refresh')}
                        title={t('shares.refresh')}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <RefreshCw
                            className={`h-5 w-5 ${refreshPending ? 'animate-spin motion-reduce:animate-none' : ''}`}
                            aria-hidden="true"
                        />
                    </button>
                </div>
            </header>

            <LazyMotion features={domAnimation} strict>
                <MotionConfig reducedMotion="user">
                    <main className="app-scroll-y flex-1 px-3 pb-[calc(1rem+var(--app-safe-area-bottom))] pt-3">
                        <div className="mx-auto max-w-[760px] space-y-4">
                            <div>
                                <label
                                    htmlFor="share-search"
                                    className="sr-only"
                                >
                                    {t('shares.search.label')}
                                </label>
                                <div className="relative">
                                    <Search
                                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-hint)]"
                                        aria-hidden="true"
                                    />
                                    <input
                                        id="share-search"
                                        type="search"
                                        value={searchQuery}
                                        onChange={(event) =>
                                            setSearchQuery(event.target.value)
                                        }
                                        placeholder={t(
                                            'shares.search.placeholder'
                                        )}
                                        className="ios-form-control h-11 w-full py-2 pl-10 pr-3 text-sm"
                                    />
                                </div>
                            </div>

                            <div
                                role="group"
                                aria-label={t('shares.filters.label')}
                                className="flex flex-wrap gap-2"
                            >
                                {filters.map((filter) => {
                                    const selected = activeFilter === filter.id
                                    return (
                                        <button
                                            key={filter.id}
                                            type="button"
                                            onClick={() =>
                                                setActiveFilter(filter.id)
                                            }
                                            aria-pressed={selected}
                                            className={`flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${
                                                selected
                                                    ? 'border-indigo-500 bg-indigo-50 text-indigo-800 dark:border-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-200'
                                                    : 'border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                                            }`}
                                        >
                                            <span>{filter.label}</span>
                                            <span
                                                aria-label={t(
                                                    filterCounts[filter.id] === 1
                                                        ? 'shares.filters.count.one'
                                                        : 'shares.filters.count.other',
                                                    {
                                                        count: filterCounts[
                                                            filter.id
                                                        ]
                                                    }
                                                )}
                                                className="rounded-full bg-black/10 px-1.5 py-0.5 text-[11px] leading-none dark:bg-white/15"
                                            >
                                                {filterCounts[filter.id]}
                                            </span>
                                        </button>
                                    )
                                })}
                            </div>

                            {error ? (
                                <div
                                    role="alert"
                                    className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-300"
                                >
                                    {error instanceof Error
                                        ? error.message
                                        : String(error)}
                                </div>
                            ) : null}

                            {isLoading ? (
                                <MotionDiv
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{
                                        duration: 0.14,
                                        ease: 'easeOut'
                                    }}
                                    className="px-1 text-sm text-[var(--app-hint)]"
                                >
                                    {t('shares.loading')}
                                </MotionDiv>
                            ) : null}

                            {!isLoading && !error && shares.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-[var(--app-border)] p-6 text-center text-sm leading-6 text-[var(--app-hint)]">
                                    {t('shares.empty')}
                                </div>
                            ) : null}

                            {!isLoading &&
                            !error &&
                            shares.length > 0 &&
                            visibleShares.length === 0 ? (
                                <div className="rounded-2xl border border-dashed border-[var(--app-border)] p-6 text-center text-sm leading-6 text-[var(--app-hint)]">
                                    {t('shares.search.noResults')}
                                </div>
                            ) : null}

                            {timelineGroups.length > 0 ? (
                                <div className="space-y-6">
                                    {timelineGroups.map((group) => (
                                        <section
                                            key={group.key}
                                            aria-labelledby={`share-timeline-${group.key}`}
                                            className="relative pl-7"
                                        >
                                            <span
                                                aria-hidden="true"
                                                className="absolute left-[7px] top-2.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_1px_3px_rgba(15,23,42,0.12)]"
                                            >
                                                <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-link)]" />
                                            </span>
                                            <span
                                                aria-hidden="true"
                                                className="absolute bottom-4 left-[7px] top-7 w-px bg-[var(--app-divider)]"
                                            />
                                            <h2
                                                id={`share-timeline-${group.key}`}
                                                className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 text-xs font-semibold text-[var(--app-fg)]"
                                            >
                                                <span>{group.label}</span>
                                                <span
                                                    aria-label={t(
                                                        group.shares.length === 1
                                                            ? 'shares.timeline.groupCount.one'
                                                            : 'shares.timeline.groupCount.other',
                                                        {
                                                            count: group.shares
                                                                .length
                                                        }
                                                    )}
                                                    className="rounded-full bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px] leading-none text-[var(--app-hint)]"
                                                >
                                                    {group.shares.length}
                                                </span>
                                            </h2>
                                            <div className="mt-3 space-y-4">
                                                {group.shares.map((share) => {
                                                    const statusLabel = t(
                                                        `shares.status.${share.status}`
                                                    )
                                                    return (
                                                        <div
                                                            key={share.id}
                                                            className="relative"
                                                        >
                                                            <span
                                                                aria-hidden="true"
                                                                className="absolute -left-[22px] top-1 h-2 w-2 rounded-full border border-[var(--app-border)] bg-[var(--app-link)]"
                                                            />
                                                            <span
                                                                aria-hidden="true"
                                                                className="absolute -left-[19px] top-[7px] h-px w-[19px] bg-[var(--app-divider)]"
                                                            />
                                                            <div className="mb-1.5 flex min-w-0 items-center justify-between gap-3 text-[11px] leading-4 text-[var(--app-hint)]">
                                                                <time
                                                                    dateTime={new Date(
                                                                        share.createdAt
                                                                    ).toISOString()}
                                                                    className="shrink-0 tabular-nums"
                                                                >
                                                                    {formatShareTimelineTime(
                                                                        share.createdAt,
                                                                        dateLocale
                                                                    )}
                                                                </time>
                                                                <span
                                                                    className={`ml-auto flex min-w-0 items-center gap-1 whitespace-nowrap font-medium ${getStatusClassName(share.status)}`}
                                                                >
                                                                    <ShareStatusIcon
                                                                        status={
                                                                            share.status
                                                                        }
                                                                        className="h-3.5 w-3.5 shrink-0"
                                                                    />
                                                                    <span className="truncate">
                                                                        {
                                                                            statusLabel
                                                                        }
                                                                    </span>
                                                                </span>
                                                            </div>
                                                            <ShareCard
                                                                share={share}
                                                                locale={
                                                                    dateLocale
                                                                }
                                                                now={now}
                                                                pending={
                                                                    pendingShareId ===
                                                                    share.id
                                                                }
                                                                onCopyLink={
                                                                    copyLink
                                                                }
                                                                onOpenSourceSession={
                                                                    openSourceSession
                                                                }
                                                                onDeliverToSourceSession={
                                                                    deliverToSourceSession
                                                                }
                                                                onOpenDetails={
                                                                    openDetails
                                                                }
                                                                onRevoke={
                                                                    requestRevoke
                                                                }
                                                                labels={{
                                                                    expiresAt:
                                                                        t(
                                                                            'shares.expiresAt'
                                                                        ),
                                                                    copy: t(
                                                                        'shares.actions.copy'
                                                                    ),
                                                                    copyLink: t(
                                                                        'shares.actions.copyLink'
                                                                    ),
                                                                    source: t(
                                                                        'shares.actions.source'
                                                                    ),
                                                                    sourceSession:
                                                                        t(
                                                                            'shares.sourceSession'
                                                                        ),
                                                                    deliver: t(
                                                                        'shares.actions.deliver'
                                                                    ),
                                                                    deliverToSource:
                                                                        t(
                                                                            'shares.actions.deliverToSource'
                                                                        ),
                                                                    more: t(
                                                                        'shares.actions.more'
                                                                    ),
                                                                    details: t(
                                                                        'shares.actions.details'
                                                                    ),
                                                                    revoke: t(
                                                                        'shares.revoke'
                                                                    )
                                                                }}
                                                            />
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </section>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    </main>
                </MotionConfig>
            </LazyMotion>

            <ConfirmDialog
                isOpen={revokeTarget !== null}
                onClose={() => setRevokeTarget(null)}
                title={t('shares.revokeConfirm.title')}
                description={
                    revokeTarget
                        ? t('shares.revokeConfirm.description', {
                              filename: revokeTarget.filename
                          })
                        : ''
                }
                confirmLabel={t('shares.revokeConfirm.confirm')}
                confirmingLabel={t('shares.revokeConfirm.confirming')}
                onConfirm={revoke}
                isPending={pendingShareId === revokeTarget?.id}
                destructive
            />
        </div>
    )
}
