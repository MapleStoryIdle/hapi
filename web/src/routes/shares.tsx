import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import {
    article as MotionArticle,
    div as MotionDiv,
    p as MotionParagraph,
} from 'motion/react-m'
import { CheckIcon, CopyIcon, SessionIcon, ShareIcon } from '@/components/icons'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
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
import type { ShareDetails, ShareFeedbackResponse, ShareSummary } from '@/types/api'

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

function isMarkdownDocument(filename: string): boolean {
    return /\.(?:md|markdown|mdx)$/i.test(filename)
}

function DocumentViewer(props: {
    filename: string
    content: string
    labels: { markdown: string; source: string }
}) {
    const markdown = isMarkdownDocument(props.filename)
    const [mode, setMode] = useState<'markdown' | 'source'>(markdown ? 'markdown' : 'source')

    useEffect(() => {
        setMode(markdown ? 'markdown' : 'source')
    }, [markdown, props.filename])

    return (
        <div>
            {markdown ? (
                <div role="tablist" aria-label={props.filename} className="mb-2 inline-flex rounded-lg bg-[var(--app-subtle-bg)] p-0.5">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'markdown'}
                        onClick={() => setMode('markdown')}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${mode === 'markdown' ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                    >
                        {props.labels.markdown}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={mode === 'source'}
                        onClick={() => setMode('source')}
                        className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${mode === 'source' ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
                    >
                        {props.labels.source}
                    </button>
                </div>
            ) : null}

            {markdown && mode === 'markdown' ? (
                <div className="max-h-80 overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                    <MarkdownRenderer content={props.content} standalone />
                </div>
            ) : (
                <pre className="max-h-80 overflow-auto whitespace-pre rounded-xl border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3 font-mono text-xs leading-5 text-[var(--app-fg)]">
                    {props.content}
                </pre>
            )}
        </div>
    )
}

export function ShareCard(props: {
    share: ShareSummary
    locale: string
    busy: boolean
    onDetails: (share: ShareSummary) => void
    onRevoke: (share: ShareSummary) => void
    onOpenSourceSession?: (sessionId: string) => void
    onViewFeedback?: (share: ShareSummary) => void
    statusLabel?: string
    labels: {
        createdAt: string
        expiresAt: string
        revoke: string
        revokeLabel: string
        detailsLabel: string
        sourceSessionLabel?: string
        feedbackLabel?: string
    }
}) {
    return (
        <MotionArticle
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
        >
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
                            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--app-hint)]">
                                <span>{formatBytes(props.share.size)}</span>
                                {props.statusLabel ? (
                                    <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 font-medium text-[var(--app-fg)]">
                                        {props.statusLabel}
                                    </span>
                                ) : null}
                            </span>
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
                <div className="flex shrink-0 flex-col items-end gap-1">
                    {props.share.sourceSessionId && props.onOpenSourceSession ? (
                        <button
                            type="button"
                            onClick={() => props.onOpenSourceSession?.(props.share.sourceSessionId!)}
                            aria-label={`${props.labels.sourceSessionLabel ?? 'Open source session'}: ${props.share.filename}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <SessionIcon className="h-[18px] w-[18px]" />
                        </button>
                    ) : null}
                    {props.share.feedback && props.onViewFeedback ? (
                        <button
                            type="button"
                            onClick={() => props.onViewFeedback?.(props.share)}
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            {props.labels.feedbackLabel ?? 'Feedback'}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onRevoke(props.share)}
                        aria-label={`${props.labels.revokeLabel}: ${props.share.filename}`}
                        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-950/25"
                    >
                        {props.labels.revoke}
                    </button>
                </div>
            </div>
        </MotionArticle>
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
        document: string
        documentLoading: string
        documentUnavailable: string
        markdown: string
        source: string
    }
}) {
    const [details, setDetails] = useState<ShareDetails | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [content, setContent] = useState<string | null>(null)
    const [contentError, setContentError] = useState<string | null>(null)
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

    useEffect(() => {
        let cancelled = false

        void props.api.getShareContent(props.share.id)
            .then((response) => {
                if (!cancelled) setContent(response.content)
            })
            .catch((reason: unknown) => {
                if (!cancelled) setContentError(reason instanceof Error ? reason.message : String(reason))
            })

        return () => {
            cancelled = true
        }
    }, [props.api, props.share.id])

    return (
        <LazyMotion features={domAnimation} strict>
            <MotionConfig reducedMotion="user">
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

                        {!details && !error ? (
                            <MotionParagraph
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.14, ease: 'easeOut' }}
                                className="mt-4 text-sm text-[var(--app-hint)]"
                            >
                                {props.labels.loading}
                            </MotionParagraph>
                        ) : null}

                        {details ? (
                            <MotionDiv
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.16, ease: 'easeOut' }}
                                className="mt-4 space-y-4"
                            >
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

                                <section>
                                    <h3 className="text-sm font-semibold text-[var(--app-fg)]">{props.labels.document}</h3>
                                    <div className="mt-2">
                                        {content !== null ? (
                                            <DocumentViewer
                                                filename={details.filename}
                                                content={content}
                                                labels={{ markdown: props.labels.markdown, source: props.labels.source }}
                                            />
                                        ) : contentError ? (
                                            <p className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2.5 text-sm leading-5 text-[var(--app-hint)]">
                                                {props.labels.documentUnavailable}: {contentError}
                                            </p>
                                        ) : (
                                            <p className="text-sm text-[var(--app-hint)]">{props.labels.documentLoading}</p>
                                        )}
                                    </div>
                                </section>
                            </MotionDiv>
                        ) : null}
                    </DialogContent>
                </Dialog>
            </MotionConfig>
        </LazyMotion>
    )
}

export function ShareFeedbackDialog(props: {
    api: ApiClient
    share: ShareSummary
    onClose: () => void
    onDelivered: () => Promise<void>
    labels: {
        title: string
        loading: string
        metadata: string
        agent: string
        model: string
        environment: string
        content: string
        markdown: string
        source: string
        sendToSession: string
        sendingToSession: string
        reviewSent: string
    }
}) {
    const [feedback, setFeedback] = useState<ShareFeedbackResponse['feedback'] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [delivering, setDelivering] = useState(false)

    useEffect(() => {
        let cancelled = false
        void props.api.getShareFeedback(props.share.id)
            .then((response) => {
                if (!cancelled) setFeedback(response.feedback)
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
            })
        return () => {
            cancelled = true
        }
    }, [props.api, props.share.id])

    const deliver = useCallback(async () => {
        setDelivering(true)
        setError(null)
        try {
            await props.api.deliverShareFeedback(props.share.id)
            await props.onDelivered()
            props.onClose()
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
            setDelivering(false)
        }
    }, [props])

    const canDeliver = Boolean(props.share.sourceSessionId && props.share.status === 'feedback_received')
    const alreadyDelivered = props.share.status === 'review_sent'

    return (
        <LazyMotion features={domAnimation} strict>
            <MotionConfig reducedMotion="user">
                <Dialog open onOpenChange={(open) => !open && props.onClose()}>
                    <DialogContent className="max-h-[min(760px,calc(100dvh-2rem))] max-w-2xl overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle>{props.labels.title}</DialogTitle>
                            <DialogDescription className="mt-2 break-all">{props.share.filename}</DialogDescription>
                        </DialogHeader>

                        {error ? (
                            <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-300">
                                {error}
                            </div>
                        ) : null}

                        {!feedback && !error ? (
                            <p className="mt-4 text-sm text-[var(--app-hint)]">{props.labels.loading}</p>
                        ) : null}

                        {feedback ? (
                            <MotionDiv
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.16, ease: 'easeOut' }}
                                className="mt-4 space-y-4"
                            >
                                <section className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">{props.labels.metadata}</h3>
                                    <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                                        <div>
                                            <dt className="text-xs text-[var(--app-hint)]">{props.labels.agent}</dt>
                                            <dd className="mt-0.5 break-words text-[var(--app-fg)]">{feedback.metadata.agent.name} · {feedback.metadata.agent.version}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-[var(--app-hint)]">{props.labels.model}</dt>
                                            <dd className="mt-0.5 break-words text-[var(--app-fg)]">{feedback.metadata.model.provider} · {feedback.metadata.model.id}{feedback.metadata.model.reasoningEffort ? ` · ${feedback.metadata.model.reasoningEffort}` : ''}</dd>
                                        </div>
                                        <div>
                                            <dt className="text-xs text-[var(--app-hint)]">{props.labels.environment}</dt>
                                            <dd className="mt-0.5 break-words text-[var(--app-fg)]">{feedback.metadata.environment.os} · {feedback.metadata.environment.arch} · {feedback.metadata.environment.runtime}</dd>
                                        </div>
                                    </dl>
                                </section>

                                <section>
                                    <h3 className="text-sm font-semibold text-[var(--app-fg)]">{props.labels.content}</h3>
                                    <div className="mt-2">
                                        <DocumentViewer
                                            filename={feedback.filename}
                                            content={feedback.content}
                                            labels={{ markdown: props.labels.markdown, source: props.labels.source }}
                                        />
                                    </div>
                                </section>

                                {alreadyDelivered ? (
                                    <p className="rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700 dark:bg-emerald-950/25 dark:text-emerald-300">
                                        {props.labels.reviewSent}
                                    </p>
                                ) : null}

                                {canDeliver ? (
                                    <button
                                        type="button"
                                        disabled={delivering}
                                        onClick={() => { void deliver() }}
                                        className="w-full rounded-xl bg-[var(--app-fg)] px-4 py-2.5 text-sm font-semibold text-[var(--app-bg)] transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    >
                                        {delivering ? props.labels.sendingToSession : props.labels.sendToSession}
                                    </button>
                                ) : null}
                            </MotionDiv>
                        ) : null}
                    </DialogContent>
                </Dialog>
            </MotionConfig>
        </LazyMotion>
    )
}

export default function SharesPage() {
    const { api, baseUrl, token } = useAppContext()
    const { addToast } = useToast()
    const { locale, t } = useTranslation()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const namespace = useMemo(() => getShareCacheNamespace(token), [token])
    const { shares, isLoading, error } = useShares(api, baseUrl, namespace)
    const [selectedShare, setSelectedShare] = useState<ShareSummary | null>(null)
    const [detailShare, setDetailShare] = useState<ShareSummary | null>(null)
    const [feedbackShare, setFeedbackShare] = useState<ShareSummary | null>(null)
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

    const refreshShares = useCallback(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.shares(baseUrl, namespace) })
    }, [baseUrl, namespace, queryClient])

    const openSourceSession = useCallback((sessionId: string) => {
        void navigate({ to: '/sessions/$sessionId', params: { sessionId } })
    }, [navigate])

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
                            <p className="px-1 text-sm leading-5 text-[var(--app-hint)]">{t('shares.hint')}</p>

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
                                    busy={pendingShareId !== null}
                                    onDetails={setDetailShare}
                                    onRevoke={setSelectedShare}
                                    onOpenSourceSession={openSourceSession}
                                    onViewFeedback={setFeedbackShare}
                                    statusLabel={t(`shares.status.${share.status}`)}
                                    labels={{
                                        createdAt: t('shares.createdAt'),
                                        expiresAt: t('shares.expiresAt'),
                                        revoke: t('shares.revoke'),
                                        revokeLabel: t('shares.revoke'),
                                        detailsLabel: t('shares.details.open'),
                                        sourceSessionLabel: t('shares.sourceSession'),
                                        feedbackLabel: t('shares.feedback.open')
                                    }}
                                />
                            ))}
                        </div>
                    </main>
                </MotionConfig>
            </LazyMotion>

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
                        copied: t('shares.details.copied'),
                        document: t('shares.details.document'),
                        documentLoading: t('shares.details.documentLoading'),
                        documentUnavailable: t('shares.details.documentUnavailable'),
                        markdown: t('shares.document.markdown'),
                        source: t('shares.document.source')
                    }}
                />
            ) : null}

            {feedbackShare ? (
                <ShareFeedbackDialog
                    key={feedbackShare.id}
                    api={api}
                    share={feedbackShare}
                    onClose={() => setFeedbackShare(null)}
                    onDelivered={refreshShares}
                    labels={{
                        title: t('shares.feedback.title'),
                        loading: t('shares.feedback.loading'),
                        metadata: t('shares.feedback.metadata'),
                        agent: t('shares.feedback.agent'),
                        model: t('shares.feedback.model'),
                        environment: t('shares.feedback.environment'),
                        content: t('shares.feedback.content'),
                        markdown: t('shares.document.markdown'),
                        source: t('shares.document.source'),
                        sendToSession: t('shares.feedback.sendToSession'),
                        sendingToSession: t('shares.feedback.sendingToSession'),
                        reviewSent: t('shares.feedback.reviewSent')
                    }}
                />
            ) : null}
        </div>
    )
}
