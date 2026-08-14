import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, GitFork } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionContextMessage, CodexLocalSessionContextResponse, DecryptedMessage } from '@/types/api'
import { LoadingState } from '@/components/LoadingState'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function buildReadOnlyCodexMessages(
    messages: readonly CodexLocalSessionContextMessage[]
): DecryptedMessage[] {
    return messages.map((message) => ({
        id: message.id,
        seq: message.createdAt + 1,
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

function ReadOnlyCodexThread(props: {
    api: ApiClient
    sessionId: string
    title: string
    messages: readonly CodexLocalSessionContextMessage[]
    version: number
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
}) {
    const [outlineOpen, setOutlineOpen] = useState(false)
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const readOnlySession = useMemo(() => ({ active: false, thinking: false }), [])
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
        session: readOnlySession,
        blocks,
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {}
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyThread
                key={`codex-context-thread-${props.sessionId}`}
                api={props.api}
                sessionId={`codex-context-${props.sessionId}`}
                metadata={null}
                disabled
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
                forceScrollToken={0}
                outlineOpen={outlineOpen}
                outlineTitle={props.title}
                outlineItems={outlineItems}
                topInset={ungroupedBlocks.length > 0 ? 60 : undefined}
                onOutlineOpenChange={setOutlineOpen}
            />
        </AssistantRuntimeProvider>
    )
}

/**
 * Renders a local Codex CLI transcript through the normal session thread while
 * keeping it read-only. Forking is available from the normal header position.
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
    const [olderPages, setOlderPages] = useState<CodexLocalSessionContextResponse[]>([])
    const [isLoadingMore, setIsLoadingMore] = useState(false)
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

    const title = context?.session.title ?? t('recentCodex.context.title')

    const fork = useCallback(async () => {
        if (!props.machineId || isForking) {
            return
        }
        setIsForking(true)
        setForkError(null)
        try {
            const response = await props.api.forkCodexSession(props.sessionId, { machineId: props.machineId })
            if (response.type === 'error') {
                throw new Error(response.message)
            }
            props.onForked(response.sessionId)
        } catch (error) {
            setForkError(errorMessage(error))
        } finally {
            setIsForking(false)
        }
    }, [isForking, props.api, props.machineId, props.onForked, props.sessionId])

    return (
        <div className="relative flex h-full min-h-0 flex-col bg-[var(--app-bg)]" data-testid="codex-session-context-page">
            <header className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-transparent pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 p-3">
                    <div className="pointer-events-auto flex min-w-0 items-center gap-0.5 rounded-[20px] border border-[color-mix(in_srgb,var(--app-border)_70%,transparent)] bg-[color-mix(in_srgb,var(--app-bg)_24%,transparent)] px-1.5 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.08)] backdrop-blur-xl">
                        <button
                            type="button"
                            onClick={props.onBack}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            aria-label={t('recentCodex.back')}
                            title={t('recentCodex.back')}
                        >
                            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                        </button>
                        <h1 className="min-w-0 truncate px-0.5 pr-1 text-left font-semibold text-[var(--app-fg)]" title={title}>
                            {title}
                        </h1>
                    </div>
                    <button
                        type="button"
                        onClick={() => void fork()}
                        disabled={isForking || !props.machineId}
                        className="pointer-events-auto ml-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-[0_8px_24px_rgba(15,23,42,0.08)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={t('recentCodex.fork')}
                        title={t('recentCodex.fork')}
                    >
                        <GitFork className={`h-5 w-5 ${isForking ? 'animate-pulse' : ''}`} aria-hidden="true" />
                    </button>
                </div>
            </header>

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
                ) : messages.length === 0 ? (
                    <div className="px-3 py-3">
                        <div className="mx-auto w-full max-w-content rounded-lg bg-[var(--app-subtle-bg)] px-3 py-3 text-sm text-[var(--app-hint)]">
                            {t('recentCodex.context.empty')}
                        </div>
                    </div>
                ) : context ? (
                    <ReadOnlyCodexThread
                        api={props.api}
                        sessionId={props.sessionId}
                        title={title}
                        messages={messages}
                        version={contextQuery.dataUpdatedAt + olderPages.length}
                        hasMoreMessages={hasMoreMessages}
                        isLoadingMoreMessages={isLoadingMore}
                        onLoadMore={loadMore}
                    />
                ) : null}
            </main>
            {forkError ? (
                <div className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-30 px-3">
                    <div className="pointer-events-auto mx-auto w-full max-w-content rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600" role="status">
                        {t('recentCodex.fork.failed')}: {forkError}
                    </div>
                </div>
            ) : null}
        </div>
    )
}
