import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { article as MotionArticle, div as MotionDiv } from 'motion/react-m'
import { CopyIcon, RevokeLinkIcon, SessionIcon, ShareIcon } from '@/components/icons'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAppContext } from '@/lib/app-context'
import { getShareCacheNamespace } from '@/lib/shareCacheScope'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useShares } from '@/hooks/queries/useShares'
import type { ShareSummary } from '@/types/api'

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
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
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

function ActionIconButton(props: {
    label: string
    disabled?: boolean
    onClick: () => void
    children: ReactNode
}) {
    return (
        <button
            type="button"
            disabled={props.disabled}
            onClick={props.onClick}
            aria-label={props.label}
            title={props.label}
            className="flex h-10 w-full items-center justify-center rounded-xl text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            {props.children}
        </button>
    )
}

export function ShareCard(props: {
    share: ShareSummary
    locale: string
    pending: boolean
    onCopyLink: (share: ShareSummary) => void
    onOpenSourceSession: (sessionId: string) => void
    onDeliverToSourceSession: (share: ShareSummary) => void
    onOpenDetails: (share: ShareSummary) => void
    onRevoke: (share: ShareSummary) => void
    labels: {
        createdAt: string
        expiresAt: string
        copyLink: string
        sourceSession: string
        sourceSessionUnavailable: string
        deliverToSource: string
        deliverUnavailable: string
        delivered: string
        details: string
        revoke: string
    }
}) {
    const sourceSessionId = props.share.sourceSessionId
    const canDeliver = Boolean(sourceSessionId && props.share.status === 'feedback_received')
    const deliveryLabel = props.share.status === 'review_sent'
        ? props.labels.delivered
        : canDeliver
            ? props.labels.deliverToSource
            : props.labels.deliverUnavailable

    return (
        <MotionArticle
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={`overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_1px_3px_rgba(15,23,42,0.04)] ${props.share.feedback ? 'border-l-[3px] border-l-emerald-500' : ''}`}
        >
            <button
                type="button"
                onClick={() => props.onOpenDetails(props.share)}
                aria-label={`${props.labels.details}: ${props.share.filename}`}
                className="block w-full min-w-0 p-4 pb-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]"
            >
                <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-semibold leading-5 text-[var(--app-fg)]" title={props.share.filename}>
                        {props.share.filename}
                    </h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--app-hint)]">
                        <span>{formatBytes(props.share.size)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{props.labels.createdAt} {formatTimestamp(props.share.createdAt, props.locale)}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-[var(--app-hint)]">
                        {props.labels.expiresAt} {formatTimestamp(props.share.expiresAt, props.locale)}
                    </p>
                </div>
            </button>

            <div className="grid grid-cols-4 border-t border-[var(--app-border)] bg-[var(--app-subtle-bg)]/35 px-2 py-1">
                <ActionIconButton
                    label={props.labels.copyLink}
                    disabled={props.pending}
                    onClick={() => props.onCopyLink(props.share)}
                >
                    <CopyIcon className="h-[18px] w-[18px]" />
                </ActionIconButton>
                <ActionIconButton
                    label={sourceSessionId ? props.labels.sourceSession : props.labels.sourceSessionUnavailable}
                    disabled={props.pending || !sourceSessionId}
                    onClick={() => {
                        if (sourceSessionId) props.onOpenSourceSession(sourceSessionId)
                    }}
                >
                    <SessionIcon className="h-[19px] w-[19px]" />
                </ActionIconButton>
                <ActionIconButton
                    label={deliveryLabel}
                    disabled={props.pending || !canDeliver}
                    onClick={() => props.onDeliverToSourceSession(props.share)}
                >
                    <ShareIcon className="h-[18px] w-[18px]" />
                </ActionIconButton>
                <ActionIconButton
                    label={props.labels.revoke}
                    disabled={props.pending}
                    onClick={() => props.onRevoke(props.share)}
                >
                    <RevokeLinkIcon className="h-[19px] w-[19px]" />
                </ActionIconButton>
            </div>
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
    const { shares, isLoading, error } = useShares(api, baseUrl, namespace)
    const [pendingShareId, setPendingShareId] = useState<string | null>(null)
    const [revokeTarget, setRevokeTarget] = useState<ShareSummary | null>(null)
    const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'

    const openSourceSession = useCallback((sessionId: string) => {
        void navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    }, [navigate])

    const openDetails = useCallback((share: ShareSummary) => {
        void navigate({ to: '/shares/$shareId', params: { shareId: share.id } })
    }, [navigate])

    const copyLink = useCallback(async (share: ShareSummary) => {
        setPendingShareId(share.id)
        try {
            const result = await api.getShare(share.id)
            if (!result.share.url) {
                addToast({
                    title: t('shares.actions.copyUnavailable'),
                    body: share.filename,
                    sessionId: '',
                    url: ''
                })
                return
            }
            const copied = await copy(result.share.url)
            addToast({
                title: copied ? t('shares.actions.copied') : t('shares.actions.copyFailed'),
                body: share.filename,
                sessionId: '',
                url: ''
            })
        } catch (reason) {
            addToast({
                title: t('shares.actions.copyFailed'),
                body: reason instanceof Error ? reason.message : String(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setPendingShareId(null)
        }
    }, [addToast, api, copy, t])

    const deliverToSourceSession = useCallback(async (share: ShareSummary) => {
        if (!share.sourceSessionId || share.status !== 'feedback_received') return
        setPendingShareId(share.id)
        try {
            await api.deliverShareFeedback(share.id)
            await queryClient.invalidateQueries({ queryKey: queryKeys.shares(baseUrl, namespace) })
            addToast({
                title: t('shares.actions.delivered'),
                body: share.filename,
                sessionId: '',
                url: ''
            })
        } catch (reason) {
            addToast({
                title: t('shares.actions.deliveryFailed'),
                body: reason instanceof Error ? reason.message : String(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setPendingShareId(null)
        }
    }, [addToast, api, baseUrl, namespace, queryClient, t])

    const requestRevoke = useCallback((share: ShareSummary) => {
        setRevokeTarget(share)
    }, [])

    const revoke = useCallback(async () => {
        if (!revokeTarget) return
        setPendingShareId(revokeTarget.id)
        try {
            const result = await api.revokeShare(revokeTarget.id)
            await queryClient.invalidateQueries({ queryKey: queryKeys.shares(baseUrl, namespace) })
            if (result.cleanupPending) {
                addToast({
                    title: t('shares.cleanupPending.title'),
                    body: t('shares.cleanupPending.body'),
                    sessionId: '',
                    url: ''
                })
            }
            setRevokeTarget(null)
        } catch (reason) {
            addToast({
                title: t('shares.revoke'),
                body: reason instanceof Error ? reason.message : String(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setPendingShareId(null)
        }
    }, [addToast, api, baseUrl, namespace, queryClient, revokeTarget, t])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.75rem+var(--app-safe-area-top))]">
                <button
                    type="button"
                    onClick={goBack}
                    aria-label={t('shares.back')}
                    title={t('shares.back')}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <BackIcon className="h-5 w-5" />
                </button>
                <div className="min-w-0 flex-1">
                    <h1 className="text-base font-semibold text-[var(--app-fg)]">{t('shares.title')}</h1>
                </div>
            </header>

            <LazyMotion features={domAnimation} strict>
                <MotionConfig reducedMotion="user">
                    <main className="app-scroll-y flex-1 p-3">
                        <div className="mx-auto max-w-[680px] space-y-3">
                            {error ? (
                                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-300">
                                    {error instanceof Error ? error.message : String(error)}
                                </div>
                            ) : null}

                            {isLoading ? (
                                <MotionDiv
                                    initial={{ opacity: 0, y: 6 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.14, ease: 'easeOut' }}
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

                            {shares.map((share) => (
                                <ShareCard
                                    key={share.id}
                                    share={share}
                                    locale={dateLocale}
                                    pending={pendingShareId === share.id}
                                    onCopyLink={copyLink}
                                    onOpenSourceSession={openSourceSession}
                                    onDeliverToSourceSession={deliverToSourceSession}
                                    onOpenDetails={openDetails}
                                    onRevoke={requestRevoke}
                                    labels={{
                                        createdAt: t('shares.createdAt'),
                                        expiresAt: t('shares.expiresAt'),
                                        copyLink: t('shares.actions.copyLink'),
                                        sourceSession: t('shares.sourceSession'),
                                        sourceSessionUnavailable: t('shares.actions.sourceUnavailable'),
                                        deliverToSource: t('shares.actions.deliverToSource'),
                                        deliverUnavailable: t('shares.actions.deliverUnavailable'),
                                        delivered: t('shares.actions.delivered'),
                                        details: t('shares.actions.details'),
                                        revoke: t('shares.revoke')
                                    }}
                                />
                            ))}
                        </div>
                    </main>
                </MotionConfig>
            </LazyMotion>

            <ConfirmDialog
                isOpen={revokeTarget !== null}
                onClose={() => setRevokeTarget(null)}
                title={t('shares.revokeConfirm.title')}
                description={revokeTarget ? t('shares.revokeConfirm.description', { filename: revokeTarget.filename }) : ''}
                confirmLabel={t('shares.revokeConfirm.confirm')}
                confirmingLabel={t('shares.revokeConfirm.confirming')}
                onConfirm={revoke}
                isPending={pendingShareId === revokeTarget?.id}
                destructive
            />
        </div>
    )
}
