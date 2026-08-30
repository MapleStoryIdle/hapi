import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CopyIcon, ShareIcon } from '@/components/icons'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ApiClient } from '@/api/client'
import { useAppContext } from '@/lib/app-context'
import { getShareCacheNamespace } from '@/lib/shareCacheScope'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useShares } from '@/hooks/queries/useShares'
import type { ShareDetails, ShareSummary } from '@/types/api'

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

export function ShareCard(props: {
    share: ShareSummary
    locale: string
    busy: boolean
    onDetails: (share: ShareSummary) => void
    onRevoke: (share: ShareSummary) => void
    labels: {
        createdAt: string
        expiresAt: string
        revoke: string
        revokeLabel: string
        detailsLabel: string
    }
}) {
    return (
        <article className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
            <div className="flex min-w-0 items-start gap-3">
                <button
                    type="button"
                    onClick={() => props.onDetails(props.share)}
                    aria-label={`${props.labels.detailsLabel}: ${props.share.filename}`}
                    className="min-w-0 flex-1 rounded-xl text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <span className="flex min-w-0 items-start gap-3 p-1">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-[var(--app-fg)]" aria-hidden="true">
                            <ShareIcon className="h-5 w-5" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-[var(--app-fg)]" title={props.share.filename}>
                                {props.share.filename}
                            </span>
                            <span className="mt-1 block text-xs text-[var(--app-hint)]">{formatBytes(props.share.size)}</span>
                        </span>
                    </span>
                    <span className="mt-2 grid gap-1 px-1 pb-1 text-xs text-[var(--app-hint)] sm:grid-cols-2 sm:gap-x-4">
                        <span className="flex min-w-0 gap-1.5">
                            <span className="shrink-0">{props.labels.createdAt}</span>
                            <span className="truncate text-[var(--app-fg)]">{formatTimestamp(props.share.createdAt, props.locale)}</span>
                        </span>
                        <span className="flex min-w-0 gap-1.5">
                            <span className="shrink-0">{props.labels.expiresAt}</span>
                            <span className="truncate text-[var(--app-fg)]">{formatTimestamp(props.share.expiresAt, props.locale)}</span>
                        </span>
                    </span>
                </button>
                <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.onRevoke(props.share)}
                    aria-label={`${props.labels.revokeLabel}: ${props.share.filename}`}
                    className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/25"
                >
                    {props.labels.revoke}
                </button>
            </div>
        </article>
    )
}

export function ShareDetailsDialog(props: {
    api: ApiClient
    share: ShareSummary
    locale: string
    onClose: () => void
    labels: {
        title: string
        loading: string
        size: string
        createdAt: string
        expiresAt: string
        link: string
        unavailable: string
        copy: string
        copied: string
    }
}) {
    const [details, setDetails] = useState<ShareDetails | null>(null)
    const [error, setError] = useState<string | null>(null)
    const { copied, copy } = useCopyToClipboard()

    useEffect(() => {
        let cancelled = false

        void props.api.getShare(props.share.id)
            .then((response) => {
                if (!cancelled) setDetails(response.share)
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
            })

        return () => {
            cancelled = true
        }
    }, [props.api, props.share.id])

    return (
        <Dialog open onOpenChange={(open) => !open && props.onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{props.labels.title}</DialogTitle>
                    <DialogDescription className="mt-2 break-all">{props.share.filename}</DialogDescription>
                </DialogHeader>

                {error ? (
                    <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-300">
                        {error}
                    </div>
                ) : null}

                {!details && !error ? <p className="mt-4 text-sm text-[var(--app-hint)]">{props.labels.loading}</p> : null}

                {details ? (
                    <div className="mt-4 space-y-4">
                        <dl className="grid gap-3 text-sm sm:grid-cols-2">
                            <div>
                                <dt className="text-xs text-[var(--app-hint)]">{props.labels.size}</dt>
                                <dd className="mt-1 text-[var(--app-fg)]">{formatBytes(details.size)}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-[var(--app-hint)]">{props.labels.createdAt}</dt>
                                <dd className="mt-1 text-[var(--app-fg)]">{formatTimestamp(details.createdAt, props.locale)}</dd>
                            </div>
                            <div className="sm:col-span-2">
                                <dt className="text-xs text-[var(--app-hint)]">{props.labels.expiresAt}</dt>
                                <dd className="mt-1 text-[var(--app-fg)]">{formatTimestamp(details.expiresAt, props.locale)}</dd>
                            </div>
                        </dl>

                        {details.url ? (
                            <div>
                                <div className="text-xs text-[var(--app-hint)]">{props.labels.link}</div>
                                <div className="mt-1.5 flex gap-2">
                                    <code className="min-w-0 flex-1 break-all rounded-lg bg-[var(--app-subtle-bg)] px-2.5 py-2 text-xs leading-5 text-[var(--app-fg)]">
                                        {details.url}
                                    </code>
                                    <button
                                        type="button"
                                        onClick={() => { void copy(details.url!) }}
                                        aria-label={props.labels.copy}
                                        className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    >
                                        {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                                        {copied ? props.labels.copied : props.labels.copy}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <p className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2.5 text-sm leading-5 text-[var(--app-hint)]">
                                {props.labels.unavailable}
                            </p>
                        )}
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}

export default function SharesPage() {
    const { api, baseUrl, token } = useAppContext()
    const { addToast } = useToast()
    const { locale, t } = useTranslation()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const namespace = useMemo(() => getShareCacheNamespace(token), [token])
    const { shares, isLoading, error } = useShares(api, baseUrl, namespace)
    const [selectedShare, setSelectedShare] = useState<ShareSummary | null>(null)
    const [detailShare, setDetailShare] = useState<ShareSummary | null>(null)
    const [pendingShareId, setPendingShareId] = useState<string | null>(null)
    const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'

    const revokeSelectedShare = useCallback(async () => {
        if (!selectedShare) return

        setPendingShareId(selectedShare.id)
        try {
            const result = await api.revokeShare(selectedShare.id)
            if (result.cleanupPending) {
                addToast({
                    title: t('shares.cleanupPending.title'),
                    body: t('shares.cleanupPending.body'),
                    sessionId: '',
                    url: ''
                })
            }
        } finally {
            await queryClient.invalidateQueries({ queryKey: queryKeys.shares(baseUrl, namespace) })
            setDetailShare((current) => current?.id === selectedShare.id ? null : current)
            setPendingShareId(null)
        }
    }, [addToast, api, baseUrl, namespace, queryClient, selectedShare, t])

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

            <main className="app-scroll-y flex-1 p-3">
                <div className="mx-auto max-w-[680px] space-y-3">
                    <p className="px-1 text-sm leading-5 text-[var(--app-hint)]">{t('shares.hint')}</p>

                    {error ? (
                        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-300">
                            {error instanceof Error ? error.message : String(error)}
                        </div>
                    ) : null}

                    {isLoading ? <div className="px-1 text-sm text-[var(--app-hint)]">{t('shares.loading')}</div> : null}

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
                            busy={pendingShareId !== null}
                            onDetails={setDetailShare}
                            onRevoke={setSelectedShare}
                            labels={{
                                createdAt: t('shares.createdAt'),
                                expiresAt: t('shares.expiresAt'),
                                revoke: t('shares.revoke'),
                                revokeLabel: t('shares.revoke'),
                                detailsLabel: t('shares.details.open')
                            }}
                        />
                    ))}
                </div>
            </main>

            <ConfirmDialog
                isOpen={selectedShare !== null}
                onClose={() => setSelectedShare(null)}
                title={t('shares.revokeConfirm.title')}
                description={selectedShare ? t('shares.revokeConfirm.description', { filename: selectedShare.filename }) : ''}
                confirmLabel={t('shares.revokeConfirm.confirm')}
                confirmingLabel={t('shares.revokeConfirm.confirming')}
                onConfirm={revokeSelectedShare}
                isPending={pendingShareId !== null}
                destructive
            />

            {detailShare ? (
                <ShareDetailsDialog
                    key={detailShare.id}
                    api={api}
                    share={detailShare}
                    locale={dateLocale}
                    onClose={() => setDetailShare(null)}
                    labels={{
                        title: t('shares.details.title'),
                        loading: t('shares.details.loading'),
                        size: t('shares.details.size'),
                        createdAt: t('shares.createdAt'),
                        expiresAt: t('shares.expiresAt'),
                        link: t('shares.details.link'),
                        unavailable: t('shares.details.unavailable'),
                        copy: t('shares.details.copy'),
                        copied: t('shares.details.copied')
                    }}
                />
            ) : null}
        </div>
    )
}
