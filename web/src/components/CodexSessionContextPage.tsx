import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert, GitFork, LoaderCircle } from 'lucide-react'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexLocalSessionContextMessage, CodexLocalSessionContextResponse, DecryptedMessage } from '@/types/api'
import { LoadingState } from '@/components/LoadingState'
import { FloatingSessionHeader, type SessionHeaderDetail } from '@/components/SessionHeader'
import { SESSION_DETAIL_HEADER_HEIGHT_PX } from '@/components/SessionDetailHeader'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { buildConversationOutline } from '@/chat/outline'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import { groupAssistantResultDetails } from '@/chat/assistantResultGrouping'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useReliableTopEdgeAction } from '@/hooks/useReliableTopEdgeAction'

type Translator = (key: string, params?: Record<string, string | number>) => string

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function formatForkError(error: unknown, t: Translator): string {
    if (error instanceof ApiError) {
        switch (error.code) {
            case 'runner_offline':
                return t('recentCodex.fork.error.runnerOffline')
            case 'hub_unavailable':
                return t('recentCodex.fork.error.hubUnavailable')
            case 'session_not_found':
                return t('recentCodex.fork.error.sessionMissing')
            case 'workspace_missing':
                return t('recentCodex.fork.error.workspaceMissing')
            case 'codex_home_unavailable':
                return t('recentCodex.fork.error.runnerUnavailable')
        }
    }
    return t('recentCodex.fork.error.generic')
}

function buildReadOnlyCodexMessages(
    messages: readonly CodexLocalSessionContextMessage[]
): DecryptedMessage[] {
    return messages.map((message) => ({
        id: message.id,
        seq: (message.position ?? message.createdAt) + 1,
        localId: null,
        content: message.content,
        createdAt: message.createdAt
    }))
}

/**
 * Use the normal HAPI message normalizer and reducer so local Codex history
 * renders tool calls, tool results, and reasoning exactly as an imported chat.
 */
export function buildReadOnlyCodexBlocks(
    messages: readonly CodexLocalSessionContextMessage[]
): ChatBlock[] {
    const normalizedMessages: NormalizedMessage[] = []
    for (const message of buildReadOnlyCodexMessages(messages)) {
        const normalized = normalizeDecryptedMessage(message)
        if (normalized) normalizedMessages.push(normalized)
    }
    return reduceChatBlocks(normalizedMessages, null).blocks
}

function NativeCodexThread(props: {
    api: ApiClient
    sessionId: string
    title: string
    messages: readonly CodexLocalSessionContextMessage[]
    version: number
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    isProcessing: boolean
    composerDisabled: boolean
    composerNotice: string | null
    sendError: ComposerSendError | null
    onClearSendError: () => void
    onSendMessage: (text: string) => void
}) {
    const [outlineOpen, setOutlineOpen] = useState(false)
    const composerOverlayRef = useRef<HTMLDivElement | null>(null)
    const [composerHeight, setComposerHeight] = useState(0)
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const nativeSession = useMemo(() => ({ active: true, thinking: props.isProcessing }), [props.isProcessing])
    const ungroupedBlocks = useMemo(
        () => buildReadOnlyCodexBlocks(props.messages),
        [props.messages]
    )
    const blocks = useMemo(
        () => groupAssistantResultDetails(buildVisibleChatBlocks(ungroupedBlocks, {
            hasMoreMessages: props.hasMoreMessages,
            terminalToolDisplayMode
        })),
        [props.hasMoreMessages, terminalToolDisplayMode, ungroupedBlocks]
    )
    const outlineItems = useMemo(() => buildConversationOutline(ungroupedBlocks), [ungroupedBlocks])
    const runtime = useHappyRuntime({
        session: nativeSession,
        blocks,
        isSending: props.composerDisabled,
        isRunning: props.isProcessing,
        onSendMessage: props.onSendMessage,
        onAbort: async () => {}
    })

    useLayoutEffect(() => {
        const node = composerOverlayRef.current
        if (!node) return

        const measure = () => {
            const height = Math.ceil(node.getBoundingClientRect().height)
            setComposerHeight((current) => current === height ? current : height)
        }
        measure()
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure)
            return () => window.removeEventListener('resize', measure)
        }
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        window.addEventListener('resize', measure)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [])

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="relative flex min-h-0 flex-1 flex-col">
                <HappyThread
                    key={`codex-context-thread-${props.sessionId}`}
                    api={props.api}
                    sessionId={`codex-context-${props.sessionId}`}
                    metadata={null}
                    disabled={false}
                    onRefresh={() => {}}
                    onFlushPending={() => {}}
                    onAtBottomChange={() => {}}
                    isLoadingMessages={false}
                    messagesWarning={null}
                    hasMoreMessages={props.hasMoreMessages}
                    isLoadingMoreMessages={props.isLoadingMoreMessages}
                    onLoadMore={props.onLoadMore}
                    pendingCount={0}
                    rawMessagesCount={props.messages.length}
                    normalizedMessagesCount={ungroupedBlocks.length}
                    messagesVersion={props.version}
                    toolGroupRunActive={props.isProcessing}
                    toolGroupCompletionKey={null}
                    forceScrollToken={0}
                    outlineOpen={outlineOpen}
                    outlineTitle={props.title}
                    outlineItems={outlineItems}
                    topInset={SESSION_DETAIL_HEADER_HEIGHT_PX}
                    bottomInset={composerHeight || undefined}
                    scrollButtonBottomInset={composerHeight > 0 ? composerHeight + 8 : undefined}
                    onOutlineOpenChange={setOutlineOpen}
                />

                <div
                    ref={composerOverlayRef}
                    className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
                    data-testid="codex-native-session-composer-overlay"
                >
                    <div className="pointer-events-auto">
                        <HappyComposer
                            key={`codex-native-composer-${props.sessionId}`}
                            sessionId={`codex-native-${props.sessionId}`}
                            disabled={props.composerDisabled}
                            active
                            agentFlavor={null}
                            showStatusBar={false}
                            allowAttachments={false}
                            inactiveNotice={props.composerNotice}
                            sendError={props.sendError}
                            onClearSendError={props.onClearSendError}
                        />
                    </div>
                </div>
            </div>
        </AssistantRuntimeProvider>
    )
}

/**
 * Renders a local Codex CLI transcript through the normal session thread.
 * Text can be delivered directly to the original native thread only after its
 * lifecycle confirms that it is idle; Fork remains available in the header.
 */
export function CodexSessionContextPage(props: {
    api: ApiClient
    sessionId: string
    machineId?: string
    onBack: () => void
    onForked: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const [isForking, setIsForking] = useState(false)
    const [forkError, setForkError] = useState<string | null>(null)
    const contextQuery = useQuery({
        queryKey: queryKeys.codexSessionContext(props.machineId ?? 'unknown', props.sessionId),
        queryFn: async () => {
            if (!props.machineId) {
                throw new Error(t('recentCodex.runnerRequired'))
            }
            return await props.api.getCodexSessionContext(props.sessionId, props.machineId, { limit: 50 })
        },
        enabled: Boolean(props.machineId),
        retry: false,
    })
    const statusQuery = useQuery({
        queryKey: queryKeys.codexSessionStatus(props.machineId ?? 'unknown', props.sessionId),
        queryFn: async () => {
            if (!props.machineId) {
                throw new Error(t('recentCodex.runnerRequired'))
            }
            return await props.api.getCodexSessionStatus(props.sessionId, props.machineId)
        },
        enabled: Boolean(props.machineId),
        retry: 1,
        retryDelay: 500,
        // Native Codex can start a new turn outside HAPI while this page is
        // open. Keep the direct-send gate current instead of trusting only
        // the status captured when the detail page first mounted.
        refetchInterval: 2_000,
        refetchIntervalInBackground: false,
    })
    const [olderPages, setOlderPages] = useState<CodexLocalSessionContextResponse[]>([])
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [isSendingDirect, setIsSendingDirect] = useState(false)
    const [directSendError, setDirectSendError] = useState<ComposerSendError | null>(null)
    const [dismissedRunnerError, setDismissedRunnerError] = useState<string | null>(null)
    const pageScope = `${props.machineId ?? ''}:${props.sessionId}`
    const pageScopeRef = useRef(pageScope)
    pageScopeRef.current = pageScope

    useEffect(() => {
        setOlderPages([])
        setIsLoadingMore(false)
    }, [props.machineId, props.sessionId])

    const messages = useMemo(
        () => [...olderPages.flatMap((page) => page.messages), ...(contextQuery.data?.messages ?? [])],
        [contextQuery.data?.messages, olderPages]
    )
    const oldestPage = olderPages[0] ?? contextQuery.data
    const hasMoreMessages = oldestPage?.page.hasMore ?? false
    const loadMore = useCallback(async () => {
        if (isLoadingMore || !props.machineId || !oldestPage?.page.hasMore || oldestPage.page.nextBefore === null) {
            return
        }

        const requestScope = pageScope
        setIsLoadingMore(true)
        try {
            const page = await props.api.getCodexSessionContext(props.sessionId, props.machineId, {
                limit: 50,
                before: oldestPage.page.nextBefore
            })
            if (pageScopeRef.current === requestScope) {
                setOlderPages((pages) => [page, ...pages])
            }
        } finally {
            if (pageScopeRef.current === requestScope) {
                setIsLoadingMore(false)
            }
        }
    }, [isLoadingMore, oldestPage, pageScope, props.api, props.machineId, props.sessionId])

    const context = contextQuery.data
    const directStatus = statusQuery.data?.success === true ? statusQuery.data.status : null
    const directStatusError = statusQuery.data?.success === true ? statusQuery.data.lastError ?? null : null
    const refetchContext = contextQuery.refetch
    const refetchStatus = statusQuery.refetch
    const isNativeProcessing = isSendingDirect || directStatus === 'processing'
    const isNativeIdle = !isSendingDirect && directStatus === 'idle'
    const canFork = Boolean(props.machineId) && !isForking && isNativeIdle
    const composerDisabled = !props.machineId || !isNativeIdle
    const composerNotice = isNativeProcessing
        ? t('recentCodex.direct.processing')
        : directStatus === 'idle'
            ? null
            : directStatus === 'unknown'
            ? t('recentCodex.direct.unknown')
            : statusQuery.isLoading
                ? t('recentCodex.direct.checking')
                : statusQuery.isError || directStatus === null
                ? t('recentCodex.direct.statusFailed')
                : null
    const visibleRunnerError = directStatusError === dismissedRunnerError ? null : directStatusError
    const composerSendError = directSendError ?? (visibleRunnerError
        ? {
            id: statusQuery.dataUpdatedAt,
            text: '',
            message: visibleRunnerError,
            scheduledAt: null
        }
        : null)

    const title = context?.session.title ?? t('recentCodex.context.title')
    const sessionDetails = useMemo<SessionHeaderDetail[]>(() => [
        { key: 'title', label: t('session.header.details.fullName'), value: title },
        { key: 'session-id', label: t('session.header.details.sessionId'), value: props.sessionId },
        {
            key: 'path',
            label: t('session.header.details.projectPath'),
            value: context?.session.cwd ?? t('session.header.details.unavailable')
        },
        { key: 'agent', label: t('session.header.details.agentInfo'), value: 'codex', isAgentInfo: true }
    ], [context?.session.cwd, props.sessionId, t, title])

    const fork = useCallback(async () => {
        if (!canFork || !props.machineId) {
            return
        }
        setIsForking(true)
        setForkError(null)
        try {
            const response = await props.api.forkCodexSession(props.sessionId, { machineId: props.machineId })
            if (response.type === 'error') {
                throw new ApiError(response.message, 500, response.code)
            }
            props.onForked(response.sessionId)
        } catch (error) {
            setForkError(formatForkError(error, t))
        } finally {
            setIsForking(false)
        }
    }, [canFork, props.api, props.machineId, props.onForked, props.sessionId, t])

    const forkActivation = useReliableTopEdgeAction(() => {
        void fork()
    })

    const sendDirectMessage = useCallback((text: string) => {
        if (!props.machineId || isSendingDirect || directStatus !== 'idle') {
            return
        }
        setIsSendingDirect(true)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        void (async () => {
            try {
                const response = await props.api.sendCodexSessionMessage(props.sessionId, {
                    machineId: props.machineId!,
                    message: text
                })
                if (response.success !== true) {
                    throw new Error(response.error)
                }
                await Promise.all([refetchStatus(), refetchContext()])
            } catch (error) {
                setDirectSendError({
                    id: Date.now(),
                    text,
                    message: errorMessage(error),
                    scheduledAt: null
                })
            } finally {
                setIsSendingDirect(false)
            }
        })()
    }, [directStatus, isSendingDirect, props.api, props.machineId, props.sessionId, refetchContext, refetchStatus])

    useEffect(() => {
        if (!isNativeProcessing) return
        const refresh = () => {
            void refetchStatus()
            void refetchContext()
        }
        refresh()
        const interval = window.setInterval(refresh, 1_000)
        return () => window.clearInterval(interval)
    }, [isNativeProcessing, refetchContext, refetchStatus])

    return (
        <div className="relative flex h-full min-h-0 flex-col bg-[var(--app-bg)]" data-testid="codex-session-context-page">
            <FloatingSessionHeader
                onBack={props.onBack}
                backLabel={t('recentCodex.back')}
                title={title}
                details={sessionDetails}
                floating
                actions={(
                    <button
                        type="button"
                        {...forkActivation}
                        disabled={!canFork}
                        className="pointer-events-auto touch-manipulation flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--app-fg)_14%,var(--app-bg))] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-[0_8px_24px_rgba(15,23,42,0.10)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]"
                        aria-busy={isForking || undefined}
                        aria-label={isForking ? t('recentCodex.forking') : t('recentCodex.fork')}
                        title={isForking ? t('recentCodex.forking') : t('recentCodex.fork')}
                    >
                        {isForking
                            ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
                            : <GitFork className="h-5 w-5" aria-hidden="true" />}
                    </button>
                )}
            />

            <main className="flex min-h-0 flex-1 flex-col" aria-label={t('recentCodex.context.title')}>
                {!props.machineId ? (
                    <div className="px-3 py-3">
                        <div className="mx-auto w-full max-w-content rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                            {t('recentCodex.runnerRequired')}
                        </div>
                    </div>
                ) : contextQuery.isLoading ? (
                    <div className="flex flex-1 items-center justify-center" data-testid="codex-session-context-loading">
                        <LoadingState label={t('recentCodex.context.loading')} className="text-sm" />
                    </div>
                ) : contextQuery.error ? (
                    <div className="px-3 py-3">
                        <div className="mx-auto w-full max-w-content rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-600">
                            <div>{t('recentCodex.context.failed')}: {errorMessage(contextQuery.error)}</div>
                            <button
                                type="button"
                                onClick={() => void contextQuery.refetch()}
                                className="mt-2 rounded-md border border-current/30 px-2 py-1 text-xs font-medium transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
                            >
                                {t('recentCodex.retry')}
                            </button>
                        </div>
                    </div>
                ) : context ? (
                    <NativeCodexThread
                        api={props.api}
                        sessionId={props.sessionId}
                        title={title}
                        messages={messages}
                        version={contextQuery.dataUpdatedAt + olderPages.length}
                        hasMoreMessages={hasMoreMessages}
                        isLoadingMoreMessages={isLoadingMore}
                        onLoadMore={loadMore}
                        isProcessing={isNativeProcessing}
                        composerDisabled={composerDisabled}
                        composerNotice={composerNotice}
                        sendError={composerSendError}
                        onClearSendError={() => {
                            setDirectSendError(null)
                            if (directStatusError) {
                                setDismissedRunnerError(directStatusError)
                            }
                        }}
                        onSendMessage={sendDirectMessage}
                    />
                ) : null}
            </main>
            {isForking ? (
                <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                    <div className="pointer-events-auto mx-auto flex w-full max-w-content items-center gap-2.5 rounded-xl border border-sky-500/20 bg-[var(--app-bg)] px-3 py-2.5 text-left shadow-[0_10px_28px_rgba(15,23,42,0.12)]" role="status" aria-live="polite">
                        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-600" aria-hidden="true" />
                        <div className="min-w-0">
                            <div className="text-xs font-semibold text-[var(--app-fg)]">{t('recentCodex.fork.progress.title')}</div>
                            <div className="mt-0.5 text-[11px] leading-4 text-[var(--app-hint)]">{t('recentCodex.fork.progress.body')}</div>
                        </div>
                    </div>
                </div>
            ) : forkError ? (
                <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                    <div className="pointer-events-auto mx-auto flex w-full max-w-content items-start gap-2.5 rounded-xl border border-red-500/25 bg-[var(--app-bg)] px-3 py-2.5 text-left shadow-[0_10px_28px_rgba(15,23,42,0.12)]" role="alert">
                        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-[var(--app-fg)]">{t('recentCodex.fork.failed.title')}</div>
                            <div className="mt-0.5 text-[11px] leading-4 text-[var(--app-hint)]">{forkError}</div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void fork()}
                            disabled={!canFork}
                            className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {t('recentCodex.retry')}
                        </button>
                    </div>
                </div>
            ) : isNativeProcessing ? (
                <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                    <div className="pointer-events-auto mx-auto flex w-full max-w-content items-center gap-2.5 rounded-xl border border-sky-500/20 bg-[var(--app-bg)] px-3 py-2.5 text-left shadow-[0_10px_28px_rgba(15,23,42,0.12)]" role="status" aria-live="polite">
                        <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-600" aria-hidden="true" />
                        <div className="min-w-0">
                            <div className="text-xs font-semibold text-[var(--app-fg)]">{t('recentCodex.status.processing')}</div>
                            <div className="mt-0.5 text-[11px] leading-4 text-[var(--app-hint)]">{t('recentCodex.status.locked')}</div>
                        </div>
                    </div>
                </div>
            ) : directStatus === 'unknown' || statusQuery.isError ? (
                <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                    <div className="pointer-events-auto mx-auto flex w-full max-w-content items-center gap-2.5 rounded-xl border border-amber-500/25 bg-[var(--app-bg)] px-3 py-2.5 text-left shadow-[0_10px_28px_rgba(15,23,42,0.12)]" role="status">
                        <CircleAlert className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold text-[var(--app-fg)]">
                                {directStatus === 'unknown' ? t('recentCodex.status.unknown') : t('recentCodex.status.failed')}
                            </div>
                            <div className="mt-0.5 text-[11px] leading-4 text-[var(--app-hint)]">{t('recentCodex.status.locked')}</div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void refetchStatus()}
                            className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-400"
                        >
                            {t('recentCodex.retry')}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    )
}
