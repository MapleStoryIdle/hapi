import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { CheckIcon, CopyIcon, SessionIcon, ShareIcon } from '@/components/icons'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAppContext } from '@/lib/app-context'
import { getShareCacheNamespace } from '@/lib/shareCacheScope'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { ShareDetails, ShareFeedbackResponse } from '@/types/api'

type DetailTab = 'preview' | 'source' | 'info' | 'feedback'
type FeedbackMode = 'preview' | 'source'

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

function SourceDocument(props: { content: string }) {
    return (
        <pre className="overflow-x-auto whitespace-pre rounded-2xl border border-[var(--app-border)] bg-[var(--app-code-bg)] p-4 font-mono text-xs leading-5 text-[var(--app-fg)]">
            {props.content}
        </pre>
    )
}

function TabButton(props: {
    active: boolean
    label: string
    onClick: () => void
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={props.active}
            onClick={props.onClick}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${props.active ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}
        >
            {props.label}
        </button>
    )
}

function FeedbackPreview(props: {
    feedback: ShareFeedbackResponse['feedback']
    previewLabel: string
    sourceLabel: string
    metadataLabel: string
    agentLabel: string
    modelLabel: string
    environmentLabel: string
}) {
    const [mode, setMode] = useState<FeedbackMode>('preview')

    return (
        <section className="space-y-4">
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
                <div>
                    <dt className="text-xs text-[var(--app-hint)]">{props.agentLabel}</dt>
                    <dd className="mt-0.5 break-words text-[var(--app-fg)]">{props.feedback.metadata.agent.name} · {props.feedback.metadata.agent.version}</dd>
                </div>
                <div>
                    <dt className="text-xs text-[var(--app-hint)]">{props.modelLabel}</dt>
                    <dd className="mt-0.5 break-words text-[var(--app-fg)]">{props.feedback.metadata.model.provider} · {props.feedback.metadata.model.id}</dd>
                </div>
                <div>
                    <dt className="text-xs text-[var(--app-hint)]">{props.environmentLabel}</dt>
                    <dd className="mt-0.5 break-words text-[var(--app-fg)]">{props.feedback.metadata.environment.os} · {props.feedback.metadata.environment.arch}</dd>
                </div>
            </dl>
            <div role="tablist" aria-label={props.metadataLabel} className="inline-flex rounded-lg bg-[var(--app-bg)] p-0.5">
                <TabButton active={mode === 'preview'} label={props.previewLabel} onClick={() => setMode('preview')} />
                <TabButton active={mode === 'source'} label={props.sourceLabel} onClick={() => setMode('source')} />
            </div>
            {mode === 'preview' ? <MarkdownRenderer content={props.feedback.content} standalone /> : <SourceDocument content={props.feedback.content} />}
        </section>
    )
}

export default function KanbanTaskPage() {
    const { shareId } = useParams({ from: '/shares/$shareId' })
    const { api, baseUrl, token } = useAppContext()
    const { locale, t } = useTranslation()
    const { addToast } = useToast()
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const { copied: linkCopied, copy: copyLinkValue } = useCopyToClipboard()
    const { copied: documentCopied, copy: copyDocument } = useCopyToClipboard()
    const { copied: feedbackCopied, copy: copyFeedback } = useCopyToClipboard()
    const namespace = useMemo(() => getShareCacheNamespace(token), [token])
    const [tab, setTab] = useState<DetailTab>('preview')
    const [details, setDetails] = useState<ShareDetails | null>(null)
    const [content, setContent] = useState<string | null>(null)
    const [feedback, setFeedback] = useState<ShareFeedbackResponse['feedback'] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [contentError, setContentError] = useState<string | null>(null)
    const [feedbackError, setFeedbackError] = useState<string | null>(null)
    const [revokeOpen, setRevokeOpen] = useState(false)
    const [revoking, setRevoking] = useState(false)
    const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'

    useEffect(() => {
        setTab('preview')
    }, [shareId])

    useEffect(() => {
        let cancelled = false
        setDetails(null)
        setError(null)
        setFeedback(null)
        setFeedbackError(null)
        void api.getShare(shareId)
            .then((response) => {
                if (!cancelled) setDetails(response.share)
            })
            .catch((reason: unknown) => {
                if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
            })
        return () => {
            cancelled = true
        }
    }, [api, shareId])

    useEffect(() => {
        let cancelled = false
        setContent(null)
        setContentError(null)
        void api.getShareContent(shareId)
            .then((response) => {
                if (!cancelled) setContent(response.content)
            })
            .catch((reason: unknown) => {
                if (!cancelled) setContentError(reason instanceof Error ? reason.message : String(reason))
            })
        return () => {
            cancelled = true
        }
    }, [api, shareId])

    useEffect(() => {
        if (!details?.feedback) return
        let cancelled = false
        void api.getShareFeedback(shareId)
            .then((response) => {
                if (!cancelled) setFeedback(response.feedback)
            })
            .catch((reason: unknown) => {
                if (!cancelled) setFeedbackError(reason instanceof Error ? reason.message : String(reason))
            })
        return () => {
            cancelled = true
        }
    }, [api, details?.feedback, shareId])

    const goBack = useCallback(() => {
        void navigate({ to: '/shares' })
    }, [navigate])

    const copyLink = useCallback(async () => {
        if (!details?.url) return
        const success = await copyLinkValue(details.url)
        addToast({
            title: success ? t('shares.actions.copied') : t('shares.actions.copyFailed'),
            body: details.filename,
            kind: success ? 'success' : 'error',
            url: `/shares/${shareId}`
        })
    }, [addToast, copyLinkValue, details, shareId, t])

    const copyVisibleContent = useCallback(async () => {
        if (tab === 'feedback') {
            if (feedback === null) return
            await copyFeedback(feedback.content)
            return
        }
        if (tab === 'info' || content === null) return
        await copyDocument(content)
    }, [content, copyDocument, copyFeedback, feedback, tab])

    const openSourceSession = useCallback(() => {
        if (!details?.source) return
        if (details.source.type === 'hapi') {
            void navigate({ to: '/sessions/$sessionId', params: { sessionId: details.source.sessionId } })
            return
        }
        void navigate({
            to: '/sessions/codex/$codexSessionId',
            params: { codexSessionId: details.source.codexSessionId },
            search: { machineId: details.source.machineId }
        })
    }, [details?.source, navigate])

    const revoke = useCallback(async () => {
        if (!details) return
        setRevoking(true)
        try {
            await api.revokeShare(details.id)
            await queryClient.invalidateQueries({ queryKey: queryKeys.shares(baseUrl, namespace) })
            void navigate({ to: '/shares' })
        } catch {
            addToast({
                title: t('shares.revoke'),
                body: t('shares.toast.revokeFailed.body'),
                kind: 'error',
                url: `/shares/${shareId}`
            })
        } finally {
            setRevoking(false)
        }
    }, [addToast, api, baseUrl, details, namespace, navigate, queryClient, t])

    const documentTabContent = (() => {
        if (contentError) {
            return <p className="rounded-xl bg-[var(--app-subtle-bg)] p-3 text-sm leading-5 text-[var(--app-hint)]">{contentError}</p>
        }
        if (content === null) {
            return <p className="p-3 text-sm text-[var(--app-hint)]">{t('shares.details.documentLoading')}</p>
        }
        if (tab === 'preview' && details && isMarkdownDocument(details.filename)) {
            return <MarkdownRenderer content={content} standalone />
        }
        return <SourceDocument content={content} />
    })()

    const feedbackTabContent = (() => {
        if (feedbackError) {
            return <p className="rounded-xl bg-[var(--app-subtle-bg)] p-3 text-sm leading-5 text-[var(--app-hint)]">{feedbackError}</p>
        }
        if (feedback === null) {
            return <p className="p-3 text-sm text-[var(--app-hint)]">{t('shares.feedback.loading')}</p>
        }
        return (
            <FeedbackPreview
                feedback={feedback}
                previewLabel={t('shares.details.preview')}
                sourceLabel={t('shares.document.source')}
                metadataLabel={t('shares.feedback.metadata')}
                agentLabel={t('shares.feedback.agent')}
                modelLabel={t('shares.feedback.model')}
                environmentLabel={t('shares.feedback.environment')}
            />
        )
    })()

    if (error) {
        return (
            <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
                <header className="flex items-center gap-2 border-b border-[var(--app-border)] px-3 pb-3 pt-[calc(0.75rem+var(--app-safe-area-top))]">
                    <button type="button" onClick={goBack} aria-label={t('shares.back')} className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)]">
                        <BackIcon className="h-5 w-5" />
                    </button>
                    <h1 className="text-base font-semibold text-[var(--app-fg)]">{t('shares.title')}</h1>
                </header>
                <div role="alert" className="m-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/25 dark:text-red-300">
                    {error}
                </div>
            </div>
        )
    }

    const filename = details?.filename ?? t('shares.details.loading')
    const sourceExists = Boolean(details?.source)
    const copyContentAvailable = tab === 'feedback'
        ? feedback !== null
        : tab !== 'info' && content !== null
    const copyContentLabel = tab === 'feedback'
        ? t('shares.actions.copyFeedback')
        : t('shares.actions.copyContent')
    const visibleContentCopied = tab === 'feedback' ? feedbackCopied : documentCopied

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.75rem+var(--app-safe-area-top))]">
                <button
                    type="button"
                    onClick={goBack}
                    aria-label={t('shares.back')}
                    title={t('shares.back')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <BackIcon className="h-5 w-5" />
                </button>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-base font-semibold text-[var(--app-fg)]">{filename}</h1>
                </div>
            </header>

            <main className="app-scroll-y flex-1 p-3">
                <div className="mx-auto max-w-[760px]">
                    <div className="mb-4 flex items-center gap-2">
                        <div role="tablist" aria-label={t('shares.details.tabsLabel')} className="flex min-w-0 flex-1 overflow-x-auto rounded-xl bg-[var(--app-subtle-bg)] p-1">
                            <TabButton active={tab === 'preview'} label={t('shares.details.preview')} onClick={() => setTab('preview')} />
                            <TabButton active={tab === 'source'} label={t('shares.document.source')} onClick={() => setTab('source')} />
                            {details?.feedback ? (
                                <TabButton active={tab === 'feedback'} label={t('shares.details.feedback')} onClick={() => setTab('feedback')} />
                            ) : null}
                            <TabButton active={tab === 'info'} label={t('shares.details.info')} onClick={() => setTab('info')} />
                        </div>
                        {copyContentAvailable ? (
                            <button
                                type="button"
                                onClick={() => { void copyVisibleContent() }}
                                aria-label={copyContentLabel}
                                title={copyContentLabel}
                                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            >
                                {visibleContentCopied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                            </button>
                        ) : null}
                    </div>

                    {tab === 'info' && details ? (
                        <div className="space-y-4">
                            <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4">
                                <dl className="grid gap-4 text-sm sm:grid-cols-2">
                                    <div>
                                        <dt className="text-xs text-[var(--app-hint)]">{t('shares.details.size')}</dt>
                                        <dd className="mt-1 text-[var(--app-fg)]">{formatBytes(details.size)}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-[var(--app-hint)]">{t('shares.createdAt')}</dt>
                                        <dd className="mt-1 text-[var(--app-fg)]">{formatTimestamp(details.createdAt, dateLocale)}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-[var(--app-hint)]">{t('shares.expiresAt')}</dt>
                                        <dd className="mt-1 text-[var(--app-fg)]">{formatTimestamp(details.expiresAt, dateLocale)}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs text-[var(--app-hint)]">{t('shares.details.status')}</dt>
                                        <dd className="mt-1 text-[var(--app-fg)]">{t(`shares.status.${details.status}`)}</dd>
                                    </div>
                                </dl>
                            </section>

                            <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4">
                                <h2 className="text-sm font-semibold text-[var(--app-fg)]">{t('shares.details.link')}</h2>
                                {details.url ? (
                                    <div className="mt-2 flex items-center gap-2">
                                        <code className="min-w-0 flex-1 truncate rounded-lg bg-[var(--app-subtle-bg)] px-2.5 py-2 text-xs text-[var(--app-fg)]">{details.url}</code>
                                        <button
                                            type="button"
                                            onClick={() => { void copyLink() }}
                                            aria-label={t('shares.actions.copyLink')}
                                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                        >
                                            {linkCopied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
                                        </button>
                                    </div>
                                ) : (
                                    <p className="mt-2 text-sm text-[var(--app-hint)]">{t('shares.details.unavailable')}</p>
                                )}
                            </section>

                            <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4">
                                <h2 className="text-sm font-semibold text-[var(--app-fg)]">{t('shares.sourceSession')}</h2>
                                <button
                                    type="button"
                                    disabled={!sourceExists}
                                    onClick={openSourceSession}
                                    className="mt-2 inline-flex items-center gap-2 rounded-lg bg-[var(--app-subtle-bg)] px-3 py-2 text-sm font-semibold text-[var(--app-fg)] transition-colors hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <SessionIcon className="h-4 w-4" />
                                    {sourceExists ? t('shares.sourceSession') : t('shares.actions.sourceUnavailable')}
                                </button>
                            </section>

                            <section className="rounded-2xl border border-red-200 bg-red-50/50 p-4 dark:border-red-900/50 dark:bg-red-950/15">
                                <h2 className="text-sm font-semibold text-red-700 dark:text-red-300">{t('shares.revoke')}</h2>
                                <p className="mt-1 text-sm leading-5 text-[var(--app-hint)]">{t('shares.revokeConfirm.description', { filename: details.filename })}</p>
                                <button
                                    type="button"
                                    onClick={() => setRevokeOpen(true)}
                                    className="mt-3 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/30"
                                >
                                    {t('shares.revoke')}
                                </button>
                            </section>
                        </div>
                    ) : tab === 'info' ? (
                        <p className="p-3 text-sm text-[var(--app-hint)]">{t('shares.details.loading')}</p>
                    ) : tab === 'feedback' ? feedbackTabContent : documentTabContent}
                </div>
            </main>

            <ConfirmDialog
                isOpen={revokeOpen}
                onClose={() => setRevokeOpen(false)}
                title={t('shares.revokeConfirm.title')}
                description={details ? t('shares.revokeConfirm.description', { filename: details.filename }) : ''}
                confirmLabel={t('shares.revokeConfirm.confirm')}
                confirmingLabel={t('shares.revokeConfirm.confirming')}
                onConfirm={revoke}
                isPending={revoking}
                destructive
            />
        </div>
    )
}
