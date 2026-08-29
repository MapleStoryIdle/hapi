import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, type ApiClient } from '@/api/client'
import type {
    CodexLocalSessionContextMessage,
    CodexLocalSessionContextResponse,
    CodexLocalSessionQueuedMessage,
    CodexLocalSessionRealtimeSnapshot,
    CodexLocalSessionSnapshotResponse,
    CodexLocalSessionStatusResponse,
    DecryptedMessage,
    SessionMetadataSummary
} from '@/types/api'
import {
    buildSessionHeaderDetails,
    CodexSubscriptionLimitsBadge,
    FloatingSessionHeader,
    SessionConnectionRecoveryControl,
    type SessionHeaderDetail
} from '@/components/SessionHeader'
import { AgentFlavorIcon, AgentFlavorStatusIcon } from '@/components/AgentFlavorIcon'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SESSION_DETAIL_HEADER_HEIGHT_PX } from '@/components/SessionDetailHeader'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { NativeQueuedMessagesBar } from '@/components/NativeQueuedMessagesBar'
import { buildConversationOutline } from '@/chat/outline'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildSessionDetailTimeline } from '@/chat/sessionDetailTimeline'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { makeClientSideId } from '@/lib/messages'
import {
    getNativeCodexDirectMessageScopeKey,
    readNativeCodexDirectMessageEchoes,
    updateNativeCodexDirectMessageEchoes,
    type NativeCodexDirectMessageEcho,
    type NativeCodexDirectMessageScope
} from '@/lib/native-codex-direct-messages'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import {
    SessionConnectionProvider,
    type SessionConnectionHealth
} from '@/lib/session-connection-context'
import { useNativeCodexRealtime } from '@/lib/native-codex-realtime-context'
import {
    getNativeCodexRealtimeSnapshot,
    subscribeNativeCodexSessionUpdated
} from '@/lib/native-codex-realtime-events'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useReliableTopEdgeAction } from '@/hooks/useReliableTopEdgeAction'
import { useCodexSubscriptionLimits } from '@/hooks/queries/useCodexSubscriptionLimits'
import { SessionDetailContent, SessionDetailSurface } from '@/components/SessionDetailSurface'
import { SessionDetailStatusNotice } from '@/components/SessionDetailStatusNotice'
import {
    SessionDetailBottomDock,
    SessionDetailBottomDockAccessory,
    SessionDetailBottomDockComposer,
    SESSION_DETAIL_BOTTOM_ACCESSORY_GAP_PX
} from '@/components/SessionDetailBottomDock'

type Translator = (key: string, params?: Record<string, string | number>) => string

const NATIVE_QUEUE_FLOATING_GAP_PX = SESSION_DETAIL_BOTTOM_ACCESSORY_GAP_PX
const NATIVE_CONTEXT_REFRESH_INTERVAL_MS = 5_000
const NATIVE_CONTEXT_ACTIVE_REFRESH_INTERVAL_MS = 1_000
const NATIVE_CONTEXT_STALE_AFTER_MS = 12_000
const NATIVE_STATUS_STALE_AFTER_MS = 6_000

export function buildNativeRealtimeContextResponse(
    snapshot: CodexLocalSessionRealtimeSnapshot
): CodexLocalSessionSnapshotResponse | null {
    const { session, importedMessages, startIndex, page } = snapshot
    if (
        !session
        || !importedMessages
        || startIndex === undefined
        || !page
    ) {
        return null
    }
    return {
        success: true,
        session,
        messages: importedMessages.map((content, index) => ({
            id: `codex-local:${session.id}:${startIndex + index}`,
            createdAt: content.createdAt ?? session.modifiedAt,
            position: startIndex + index,
            content
        })),
        page,
        status: snapshot.status,
        revision: snapshot.revision,
        timing: snapshot.timing
    }
}

/**
 * The first native transcript request can take a moment while the runner
 * reads Codex's local history. Keep that wait inside the conversation rather
 * than presenting it as an app-level dialog or a blocking spinner.
 */
function NativeContextTypingIndicator(props: { label: string }) {
    return (
        <div
            className="flex flex-1 items-end px-5 pb-5"
            data-testid="codex-session-context-loading"
            role="status"
            aria-label={props.label}
            aria-live="polite"
            aria-busy="true"
        >
            <div className="mx-auto flex w-full max-w-content items-end gap-2">
                <AgentFlavorIcon
                    flavor="codex"
                    className="mb-0.5 h-5 w-5 shrink-0 text-[var(--app-hint)]"
                />
                <div
                    className="w-36 rounded-2xl rounded-bl-md bg-[var(--app-subtle-bg)] px-3.5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.06)] animate-bounce-in dark:shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
                    data-testid="codex-session-context-typing"
                    aria-hidden="true"
                >
                    <span className="block h-2.5 w-24 rounded-full bg-[var(--app-border)]/70 motion-safe:animate-pulse" data-loading-line />
                    <span className="mt-2 block h-2.5 w-16 rounded-full bg-[var(--app-border)]/50 motion-safe:animate-pulse" data-loading-line />
                </div>
            </div>
        </div>
    )
}

export function getNativeContextRefreshInterval(
    status: CodexLocalSessionStatusResponse | undefined
): number | false {
    return status?.success === true && status.status === 'processing'
        ? NATIVE_CONTEXT_ACTIVE_REFRESH_INTERVAL_MS
        : NATIVE_CONTEXT_REFRESH_INTERVAL_MS
}

export function deriveNativeSessionConnectionHealth(input: {
    machineAvailable: boolean
    recovering: boolean
    contextAvailable: boolean
    contextError: boolean
    contextUpdatedAt: number
    statusAvailable: boolean
    statusError: boolean
    statusUpdatedAt: number
    realtimeConnected?: boolean
    now?: number
}): SessionConnectionHealth {
    if (input.recovering) {
        return 'recovering'
    }
    if (!input.machineAvailable) {
        return 'offline'
    }

    const now = input.now ?? Date.now()
    const hasAnyData = input.contextAvailable || input.statusAvailable
    const hasTransportError = input.contextError || input.statusError
    if (!hasAnyData && hasTransportError) {
        return 'offline'
    }
    if (!input.contextAvailable || !input.statusAvailable) {
        if (hasTransportError) {
            return 'degraded'
        }
        return 'recovering'
    }
    if (hasTransportError) {
        return 'degraded'
    }
    if (input.realtimeConnected) {
        return 'connected'
    }
    if (
        now - input.contextUpdatedAt > NATIVE_CONTEXT_STALE_AFTER_MS
        || now - input.statusUpdatedAt > NATIVE_STATUS_STALE_AFTER_MS
    ) {
        return 'degraded'
    }
    return 'connected'
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function formatDirectSendError(error: unknown, t: Translator): string {
    if (error instanceof ApiError) {
        switch (error.code) {
            case 'queue_full':
                return t('recentCodex.direct.error.queueFull')
            case 'session_status_unknown':
                return t('recentCodex.direct.error.statusUnknown')
            case 'workspace_unavailable':
                return t('recentCodex.direct.error.workspaceUnavailable')
            case 'session_not_found':
                return t('recentCodex.direct.error.sessionMissing')
            case 'not_native_session':
                return t('recentCodex.direct.error.hapiManaged')
        }
        if (error.code === 'session_busy' || error.status === 409) {
            return t('recentCodex.direct.error.conflict')
        }
        if (error.status === 408) {
            return t('recentCodex.direct.error.timeout')
        }
        if (error.status >= 500) {
            return t('recentCodex.direct.error.runnerUnavailable')
        }
        // ApiClient includes the raw response body in ApiError.message for
        // diagnostics. Keep that payload out of the composer; it can contain
        // long transcript paths or implementation details.
        return t('recentCodex.direct.error.generic')
    }
    return errorMessage(error)
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
    return buildCodexBlocksFromDecryptedMessages(buildReadOnlyCodexMessages(messages))
}

/**
 * Merge the newest context page with older pages without allowing an
 * overlapping transcript read to render the same message twice.  Native
 * transcript files can grow between requests, so the page boundary is not a
 * sufficient identity on its own; the stable local message id is.
 */
export function mergeCodexContextMessages(
    pages: readonly CodexLocalSessionContextResponse[]
): CodexLocalSessionContextMessage[] {
    const byId = new Map<string, CodexLocalSessionContextMessage>()
    for (const page of pages) {
        for (const message of page.messages) {
            byId.set(message.id, message)
        }
    }

    return [...byId.values()].sort((left, right) => {
        const leftPosition = left.position ?? left.createdAt
        const rightPosition = right.position ?? right.createdAt
        return leftPosition - rightPosition || left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    })
}

/**
 * A native prompt is accepted by a separate local Codex process, so there is
 * no HAPI message row or localId for the transcript to echo back. Keep a
 * small client-side copy until a *new* matching transcript record arrives.
 */
export type NativeDirectMessageEcho = NativeCodexDirectMessageEcho

function getNativeUserMessageText(message: CodexLocalSessionContextMessage): string | null {
    if (message.content.role !== 'user') return null
    const content = message.content.content
    if (
        content
        && typeof content === 'object'
        && 'type' in content
        && 'text' in content
        && (content as { type?: unknown }).type === 'text'
        && typeof (content as { text?: unknown }).text === 'string'
    ) {
        return (content as { text: string }).text.trim()
    }
    return null
}

/**
 * Hide an optimistic native bubble as soon as its authoritative transcript
 * entry arrives. IDs seen at submit time protect repeated prompts ("continue"
 * sent twice) from reconciling against an older, identical message.
 */
export function getVisibleNativeDirectMessageEchoes(
    echoes: readonly NativeDirectMessageEcho[],
    transcriptMessages: readonly CodexLocalSessionContextMessage[]
): NativeDirectMessageEcho[] {
    const matchedTranscriptIds = new Set<string>()
    return echoes.filter((echo) => {
        const observedIds = new Set(echo.observedTranscriptMessageIds)
        const match = transcriptMessages.find((message) => (
            (echo.observedThroughPosition === null
                ? !observedIds.has(message.id)
                : typeof message.position === 'number' && message.position > echo.observedThroughPosition)
            && !matchedTranscriptIds.has(message.id)
            && getNativeUserMessageText(message) === echo.text
        ))
        if (!match) return true
        matchedTranscriptIds.add(match.id)
        return false
    })
}

function buildNativeDirectEchoMessages(
    echoes: readonly NativeDirectMessageEcho[]
): DecryptedMessage[] {
    return echoes.map((echo) => ({
        id: echo.id,
        seq: null,
        localId: echo.id,
        content: {
            role: 'user',
            content: { type: 'text', text: echo.text }
        },
        createdAt: echo.createdAt,
        status: echo.status,
        originalText: echo.text
    }))
}

function buildCodexBlocksFromDecryptedMessages(messages: readonly DecryptedMessage[]): ChatBlock[] {
    const normalizedMessages: NormalizedMessage[] = []
    for (const message of messages) {
        const normalized = normalizeDecryptedMessage(message)
        if (normalized) normalizedMessages.push(normalized)
    }
    return reduceChatBlocks(normalizedMessages, null).blocks
}

/** Build a native transcript plus any unconfirmed direct-send bubbles. */
export function buildNativeCodexBlocks(
    messages: readonly CodexLocalSessionContextMessage[],
    echoes: readonly NativeDirectMessageEcho[] = []
): ChatBlock[] {
    return buildCodexBlocksFromDecryptedMessages([
        ...buildReadOnlyCodexMessages(messages),
        ...buildNativeDirectEchoMessages(echoes)
    ])
}

function NativeCodexThread(props: {
    api: ApiClient
    sessionId: string
    title: string
    metadata: SessionMetadataSummary
    messages: readonly CodexLocalSessionContextMessage[]
    directMessageEchoes: readonly NativeDirectMessageEcho[]
    version: number
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    outlineOpen: boolean
    onOutlineOpenChange: (open: boolean) => void
    isProcessing: boolean
    queuedMessages: readonly CodexLocalSessionQueuedMessage[]
    composerDisabled: boolean
    composerNotice: string | null
    sendError: ComposerSendError | null
    onClearSendError: () => void
    onSendMessage: (text: string) => void
    onRefresh: () => void
    forceScrollToken: number
}) {
    const composerOverlayRef = useRef<HTMLDivElement | null>(null)
    const queueOverlayRef = useRef<HTMLDivElement | null>(null)
    const [composerHeight, setComposerHeight] = useState(0)
    const [queueHeight, setQueueHeight] = useState(0)
    const [queueAccessoryExpanded, setQueueAccessoryExpanded] = useState(false)
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const nativeSession = useMemo(() => ({ active: true, thinking: props.isProcessing }), [props.isProcessing])
    const transcriptBlocks = useMemo(
        () => buildReadOnlyCodexBlocks(props.messages),
        [props.messages]
    )
    const ungroupedBlocks = useMemo(
        () => buildNativeCodexBlocks(props.messages, props.directMessageEchoes),
        [props.directMessageEchoes, props.messages]
    )
    const timeline = useMemo(
        () => buildSessionDetailTimeline(ungroupedBlocks, {
            hasMoreMessages: props.hasMoreMessages,
            terminalToolDisplayMode,
            runActive: props.isProcessing
        }),
        [props.hasMoreMessages, props.isProcessing, terminalToolDisplayMode, ungroupedBlocks]
    )
    const blocks = timeline.visible
    // A local echo is useful in the thread immediately, but it must not become
    // a durable outline anchor until the runner has actually written it.
    const outlineItems = useMemo(() => buildConversationOutline(transcriptBlocks), [transcriptBlocks])
    const runtime = useHappyRuntime({
        session: nativeSession,
        blocks,
        // Processing a native turn does not disable the composer: the runner
        // accepts the prompt into its FIFO queue. Only an unavailable or
        // unknown native session state disables sending.
        isSending: props.composerDisabled,
        // This is a read-only transcript adapter. A native turn is owned by
        // the external Codex process, so exposing assistant-ui's cancel/stop
        // control would look actionable but could never abort that process.
        isRunning: false,
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

    useLayoutEffect(() => {
        const node = queueOverlayRef.current
        if (!node) {
            setQueueHeight(0)
            return
        }

        const measure = () => {
            const height = Math.ceil(node.getBoundingClientRect().height)
            setQueueHeight((current) => current === height ? current : height)
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
    }, [props.queuedMessages.length])

    const queueAccessoryVisible = props.queuedMessages.length > 0
    const totalBottomInset = composerHeight + (queueHeight > 0 ? queueHeight + NATIVE_QUEUE_FLOATING_GAP_PX : 0)

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="relative flex min-h-0 flex-1 flex-col">
                <HappyThread
                    key={`codex-context-thread-${props.sessionId}`}
                    api={props.api}
                    sessionId={`codex-context-${props.sessionId}`}
                    metadata={props.metadata}
                    disabled={false}
                    onRefresh={props.onRefresh}
                    onFlushPending={() => {}}
                    onAtBottomChange={() => {}}
                    isLoadingMessages={false}
                    messagesWarning={null}
                    hasMoreMessages={props.hasMoreMessages}
                    isLoadingMoreMessages={props.isLoadingMoreMessages}
                    onLoadMore={props.onLoadMore}
                    pendingCount={0}
                    rawMessagesCount={props.messages.length + props.directMessageEchoes.length}
                    normalizedMessagesCount={ungroupedBlocks.length}
                    messagesVersion={props.version}
                    toolGroupRunActive={props.isProcessing}
                    toolGroupCompletionKey={null}
                    forceScrollToken={props.forceScrollToken}
                    outlineOpen={props.outlineOpen}
                    outlineTitle={props.title}
                    outlineItems={outlineItems}
                    topInset={SESSION_DETAIL_HEADER_HEIGHT_PX}
                    bottomInset={totalBottomInset || undefined}
                    scrollButtonBottomInset={totalBottomInset > 0 ? totalBottomInset + 8 : undefined}
                    bottomAccessoryVisible={queueAccessoryVisible}
                    bottomAccessoryExpanded={queueAccessoryExpanded}
                    onOutlineOpenChange={props.onOutlineOpenChange}
                />

                <SessionDetailBottomDock>
                    <SessionDetailBottomDockComposer
                        ref={composerOverlayRef}
                        testId="codex-native-session-composer-overlay"
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
                    </SessionDetailBottomDockComposer>

                    {queueAccessoryVisible ? (
                        <SessionDetailBottomDockAccessory
                            ref={queueOverlayRef}
                            testId="codex-native-session-queue-overlay"
                        >
                            <div className="pointer-events-auto">
                                <NativeQueuedMessagesBar
                                    messages={props.queuedMessages}
                                    onExpandedChange={setQueueAccessoryExpanded}
                                />
                            </div>
                        </SessionDetailBottomDockAccessory>
                    ) : null}
                </SessionDetailBottomDock>
            </div>
        </AssistantRuntimeProvider>
    )
}

/**
 * Renders a local Codex CLI transcript through the normal session thread.
 * Text is delivered to the original native thread. Its owning app-server
 * accepts prompts while a turn is running; HAPI keeps only a small FIFO for
 * the hand-off command and retains the visible receipt across page exits.
 */
export function CodexSessionContextPage(props: {
    api: ApiClient
    sessionId: string
    machineId?: string
    /** Known runner liveness when the route has already loaded its machine. */
    machineAvailable?: boolean
    /** Older runners remain on polling until they advertise transcript events. */
    realtimeAvailable?: boolean
    onBack: () => void
    onForked: (sessionId: string) => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const nativeRealtime = useNativeCodexRealtime()
    const hasRealtimeUpdates = props.realtimeAvailable === true && nativeRealtime?.connected === true
    const nativeSnapshotQueryKey = useMemo(
        () => queryKeys.codexSessionSnapshot(props.machineId ?? 'unknown', props.sessionId),
        [props.machineId, props.sessionId]
    )
    const latestNativeRealtimeUpdateAtRef = useRef(0)
    const [isForking, setIsForking] = useState(false)
    const [forkError, setForkError] = useState<string | null>(null)
    const contextQuery = useQuery({
        queryKey: nativeSnapshotQueryKey,
        queryFn: async () => {
            if (!props.machineId) {
                throw new Error(t('recentCodex.runnerRequired'))
            }
            const requestStartedAt = Date.now()
            const response = await props.api.getCodexSessionSnapshot(props.sessionId, props.machineId, { limit: 50 })
            const current = queryClient.getQueryData<CodexLocalSessionSnapshotResponse>(nativeSnapshotQueryKey)
            // A bounded SSE page can arrive while its preceding HTTP read is
            // still in flight. Do not let that older response roll the visible
            // transcript/status backwards after the push was applied.
            if (current && (
                current.revision > response.revision
                || (current.revision === response.revision && latestNativeRealtimeUpdateAtRef.current > requestStartedAt)
            )) {
                return current
            }
            return response
        },
        enabled: Boolean(props.machineId),
        retry: 1,
        retryDelay: 500,
        // A native realtime payload updates this cache directly. Poll only
        // when an older runner cannot provide that stream.
        refetchInterval: hasRealtimeUpdates
            ? false
            : (query) => getNativeContextRefreshInterval(
                (query.state.data as CodexLocalSessionSnapshotResponse | undefined)?.status
            ),
        refetchIntervalInBackground: false,
        refetchOnMount: 'always',
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
    })
    const statusQuery = {
        data: contextQuery.data?.status,
        isLoading: contextQuery.isLoading,
        isError: contextQuery.isError,
        error: contextQuery.error,
        dataUpdatedAt: contextQuery.dataUpdatedAt,
        isFetching: contextQuery.isFetching,
        refetch: contextQuery.refetch
    }
    const pageScope = `${props.machineId ?? ''}:${props.sessionId}`
    const nativeDirectMessageScope = useMemo<NativeCodexDirectMessageScope>(() => ({
        machineId: props.machineId ?? '',
        sessionId: props.sessionId
    }), [props.machineId, props.sessionId])
    const nativeDirectMessageScopeKey = getNativeCodexDirectMessageScopeKey(nativeDirectMessageScope)
    const [olderPages, setOlderPages] = useState<CodexLocalSessionContextResponse[]>([])
    const [isLoadingMore, setIsLoadingMore] = useState(false)
    const [pendingDirectSendCount, setPendingDirectSendCount] = useState(0)
    const [isRecoveringConnection, setIsRecoveringConnection] = useState(false)
    const [nativeQueuedMessages, setNativeQueuedMessages] = useState<CodexLocalSessionQueuedMessage[]>([])
    const [nativeDirectMessageEchoScopeKey, setNativeDirectMessageEchoScopeKey] = useState(nativeDirectMessageScopeKey)
    const [nativeDirectMessageEchoes, setNativeDirectMessageEchoes] = useState<NativeDirectMessageEcho[]>(() => (
        nativeDirectMessageScope.machineId
            ? readNativeCodexDirectMessageEchoes(nativeDirectMessageScope)
            : []
    ))
    const [nativeForceScrollToken, setNativeForceScrollToken] = useState(0)
    const [directSendError, setDirectSendError] = useState<ComposerSendError | null>(null)
    const [dismissedRunnerError, setDismissedRunnerError] = useState<string | null>(null)
    const [connectionNow, setConnectionNow] = useState(() => Date.now())
    const [outlineOpen, setOutlineOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState({ x: 0, y: 0 })
    const pageScopeRef = useRef(pageScope)
    const nativeDirectMessageScopeKeyRef = useRef(nativeDirectMessageScopeKey)
    const nativeDirectMessagePageMountedRef = useRef(true)
    const connectionRecoveryTokenRef = useRef(0)
    const foregroundRefreshAtRef = useRef(0)
    const nativeEventRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const menuId = useId()
    pageScopeRef.current = pageScope
    nativeDirectMessageScopeKeyRef.current = nativeDirectMessageScopeKey

    useEffect(() => {
        nativeDirectMessagePageMountedRef.current = true
        return () => {
            nativeDirectMessagePageMountedRef.current = false
        }
    }, [])

    const updateNativeDirectMessageEchoes = useCallback((
        scope: NativeCodexDirectMessageScope,
        updater: (messages: NativeDirectMessageEcho[]) => readonly NativeDirectMessageEcho[]
    ): NativeDirectMessageEcho[] => {
        if (!scope.machineId) return []
        const next = updateNativeCodexDirectMessageEchoes(scope, updater)
        const scopeKey = getNativeCodexDirectMessageScopeKey(scope)
        if (
            nativeDirectMessagePageMountedRef.current
            && nativeDirectMessageScopeKeyRef.current === scopeKey
        ) {
            setNativeDirectMessageEchoScopeKey(scopeKey)
            setNativeDirectMessageEchoes(next)
        }
        return next
    }, [])

    useEffect(() => {
        setOlderPages([])
        setIsLoadingMore(false)
        setPendingDirectSendCount(0)
        setNativeQueuedMessages([])
        const restoredEchoes = nativeDirectMessageScope.machineId
            ? readNativeCodexDirectMessageEchoes(nativeDirectMessageScope)
            : []
        setNativeDirectMessageEchoScopeKey(nativeDirectMessageScopeKey)
        setNativeDirectMessageEchoes(restoredEchoes)
        setNativeForceScrollToken(0)
        setIsRecoveringConnection(false)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        setConnectionNow(Date.now())
        foregroundRefreshAtRef.current = 0
        setOutlineOpen(false)
        setMenuOpen(false)
        connectionRecoveryTokenRef.current += 1
    }, [nativeDirectMessageScope, nativeDirectMessageScopeKey, props.machineId, props.sessionId])

    useEffect(() => {
        const response = statusQuery.data
        if (response?.success === true && Array.isArray(response.queuedMessages)) {
            // Do not clear a locally confirmed queue from a response produced
            // by an older runner (or from the short processing window before
            // the runner has published its queue). Once the native turn is
            // idle, an explicit empty array is authoritative and clears it.
            setNativeQueuedMessages((current) => response.queuedMessages!.length === 0
                && current.length > 0
                && response.status !== 'idle'
                ? current
                : response.queuedMessages!)
            const queuedMessageIds = new Set(response.queuedMessages.map((message) => message.id))
            updateNativeDirectMessageEchoes(nativeDirectMessageScope, (current) => {
                let changed = false
                const next = current.map((echo) => {
                    if (echo.status !== 'queued' || !echo.queueId || queuedMessageIds.has(echo.queueId)) {
                        return echo
                    }
                    changed = true
                    return { ...echo, status: 'sending' as const }
                })
                return changed ? next : current
            })
        }
    }, [nativeDirectMessageScope, statusQuery.data, updateNativeDirectMessageEchoes])

    const messages = useMemo(
        () => mergeCodexContextMessages([
            ...olderPages,
            ...(contextQuery.data ? [contextQuery.data] : [])
        ]),
        [contextQuery.data, olderPages]
    )
    const currentNativeDirectMessageEchoes = nativeDirectMessageEchoScopeKey === nativeDirectMessageScopeKey
        ? nativeDirectMessageEchoes
        : []
    const visibleNativeDirectMessageEchoes = useMemo(
        () => getVisibleNativeDirectMessageEchoes(currentNativeDirectMessageEchoes, messages),
        [currentNativeDirectMessageEchoes, messages]
    )
    // Once a local echo has been reconciled, actually remove it from state.
    // Otherwise it could reappear after its transcript row eventually rolls
    // out of the latest 50-message context page.
    useEffect(() => {
        updateNativeDirectMessageEchoes(nativeDirectMessageScope, (current) => {
            const next = getVisibleNativeDirectMessageEchoes(current, messages)
            return next.length === current.length ? current : next
        })
    }, [messages, nativeDirectMessageScope, updateNativeDirectMessageEchoes])
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
    // Native transcripts do not carry HAPI's SessionMetadata row. Supplying a
    // small, explicit Codex metadata view keeps the shared thread renderer's
    // agent icon, path shortening and permission presentation identical to a
    // normal Codex session without inventing HAPI-only state.
    const nativeMetadata = useMemo<SessionMetadataSummary>(() => ({
        path: context?.session.cwd ?? '',
        host: 'local',
        flavor: 'codex',
        capabilities: { terminal: true }
    }), [context?.session.cwd])
    const directStatus = statusQuery.data?.success === true ? statusQuery.data.status : null
    const directStatusError = statusQuery.data?.success === true ? statusQuery.data.lastError ?? null : null
    const codexLimitsState = useCodexSubscriptionLimits({
        api: props.api,
        machineId: props.machineId,
        model: context?.session.model ?? null,
        // Read the model from the transcript first, so a native GPT-specific
        // session renders the matching Codex quota bucket instead of a
        // generic one during the first paint.
        enabled: Boolean(props.machineId && context),
        thinking: directStatus === 'processing'
    })
    const refetchNativeSnapshot = contextQuery.refetch
    const refetchNativeSnapshotRef = useRef(refetchNativeSnapshot)
    refetchNativeSnapshotRef.current = refetchNativeSnapshot

    const applyNativeRealtimeSnapshot = useCallback((event: Parameters<typeof getNativeCodexRealtimeSnapshot>[0]): boolean => {
        const snapshot = getNativeCodexRealtimeSnapshot(event)
        if (!snapshot) {
            return false
        }
        const context = buildNativeRealtimeContextResponse(snapshot)
        let covered = false
        let applied = false
        queryClient.setQueryData<CodexLocalSessionSnapshotResponse>(
            nativeSnapshotQueryKey,
            (current) => {
                if (context) {
                    if (current && current.revision > context.revision) {
                        covered = true
                        return current
                    }
                    covered = true
                    applied = true
                    return context
                }
                if (!current) {
                    return current
                }
                // Direct-send lifecycle updates do not change the transcript
                // revision. Accept an equal revision so processing/queued
                // state reaches the composer without a follow-up HTTP read.
                if (current.revision > snapshot.revision) {
                    covered = true
                    return current
                }
                // A status-only event is allowed to describe a lifecycle
                // change at the current transcript revision. A future
                // revision would mean its message page is missing, so leave
                // it uncovered and fetch one authoritative snapshot.
                if (current.revision < snapshot.revision) {
                    return current
                }
                covered = true
                applied = true
                return {
                    ...current,
                    status: snapshot.status,
                    revision: snapshot.revision,
                    timing: snapshot.timing
                }
            }
        )
        if (applied) {
            latestNativeRealtimeUpdateAtRef.current = Date.now()
        }
        setConnectionNow(Date.now())
        return covered
    }, [nativeSnapshotQueryKey, queryClient])

    const scheduleNativeSnapshotRefresh = useCallback(() => {
        if (nativeEventRefreshTimerRef.current !== null) {
            return
        }
        nativeEventRefreshTimerRef.current = setTimeout(() => {
            nativeEventRefreshTimerRef.current = null
            void refetchNativeSnapshotRef.current()
        }, 80)
    }, [])

    useEffect(() => () => {
        if (nativeEventRefreshTimerRef.current !== null) {
            clearTimeout(nativeEventRefreshTimerRef.current)
            nativeEventRefreshTimerRef.current = null
        }
    }, [pageScope])

    // Freshness is time-based, so it must be re-evaluated even when a hung
    // request has not produced a new React Query notification.  The clock is
    // cheap, pauses while the tab is hidden, and also makes the native status
    // control react predictably after the stale thresholds are crossed.
    useEffect(() => {
        const tick = () => {
            if (document.visibilityState === 'visible') {
                setConnectionNow(Date.now())
            }
        }
        tick()
        const timer = window.setInterval(tick, 1_000)
        return () => window.clearInterval(timer)
    }, [])

    // React Query normally refetches on focus/reconnect, but an explicit
    // foreground read avoids waiting for stale-time bookkeeping and keeps the
    // native detail route aligned with HAPI's reconnect behaviour.
    const refreshNativeDataOnForeground = useCallback(() => {
        if (document.visibilityState !== 'visible') return
        const now = Date.now()
        if (now - foregroundRefreshAtRef.current < 300) return
        foregroundRefreshAtRef.current = now
        setConnectionNow(now)
        void refetchNativeSnapshot()
    }, [refetchNativeSnapshot])

    useEffect(() => {
        if (!hasRealtimeUpdates || !props.machineId) {
            return
        }

        const refreshFromNativeEvent = () => {
            setConnectionNow(Date.now())
            void refetchNativeSnapshotRef.current()
        }
        // Reconcile once when this detail first gets a healthy event stream;
        // any file writes missed before subscription are covered too.
        refreshFromNativeEvent()
        return subscribeNativeCodexSessionUpdated((event) => {
            if (event.machineId !== props.machineId || event.codexSessionId !== props.sessionId) {
                return
            }
            if (!applyNativeRealtimeSnapshot(event)) {
                scheduleNativeSnapshotRefresh()
            }
        })
    }, [
        applyNativeRealtimeSnapshot,
        hasRealtimeUpdates,
        props.machineId,
        props.sessionId,
        scheduleNativeSnapshotRefresh
    ])

    useEffect(() => {
        window.addEventListener('focus', refreshNativeDataOnForeground)
        window.addEventListener('pageshow', refreshNativeDataOnForeground)
        window.addEventListener('online', refreshNativeDataOnForeground)
        document.addEventListener('visibilitychange', refreshNativeDataOnForeground)
        return () => {
            window.removeEventListener('focus', refreshNativeDataOnForeground)
            window.removeEventListener('pageshow', refreshNativeDataOnForeground)
            window.removeEventListener('online', refreshNativeDataOnForeground)
            document.removeEventListener('visibilitychange', refreshNativeDataOnForeground)
        }
    }, [refreshNativeDataOnForeground])

    const nativeConnectionHealth = deriveNativeSessionConnectionHealth({
        machineAvailable: props.machineAvailable ?? Boolean(props.machineId),
        recovering: isRecoveringConnection,
        contextAvailable: Boolean(contextQuery.data),
        contextError: Boolean(contextQuery.error),
        contextUpdatedAt: contextQuery.dataUpdatedAt,
        statusAvailable: statusQuery.data?.success === true,
        statusError: Boolean(statusQuery.error),
        statusUpdatedAt: statusQuery.dataUpdatedAt,
        realtimeConnected: hasRealtimeUpdates,
        now: connectionNow
    })
    const recoverNativeConnection = useCallback(async (): Promise<void> => {
        if (!props.machineId || isRecoveringConnection) {
            return
        }

        const recoveryToken = ++connectionRecoveryTokenRef.current
        setIsRecoveringConnection(true)
        try {
            await refetchNativeSnapshot()
        } finally {
            if (connectionRecoveryTokenRef.current === recoveryToken) {
                setIsRecoveringConnection(false)
            }
        }
    }, [isRecoveringConnection, props.machineId, refetchNativeSnapshot])
    const handleMenuToggle = useCallback(() => {
        if (!menuOpen && menuAnchorRef.current) {
            const rect = menuAnchorRef.current.getBoundingClientRect()
            setMenuAnchorPoint({ x: rect.right, y: rect.bottom })
        }
        setMenuOpen((open) => !open)
    }, [menuOpen])
    const menuActivation = useReliableTopEdgeAction(handleMenuToggle)
    const nativeConnectionContext = useMemo(() => ({
        health: nativeConnectionHealth,
        recover: recoverNativeConnection,
        lastUpdatedAt: contextQuery.dataUpdatedAt || null
    }), [contextQuery.dataUpdatedAt, nativeConnectionHealth, recoverNativeConnection])
    const hasNativeQueuedMessages = nativeQueuedMessages.length > 0
    const isSendingDirect = pendingDirectSendCount > 0
    const isNativeProcessing = isSendingDirect || directStatus === 'processing'
    // A runner can briefly report idle between the native turn ending and the
    // queue pump starting its next child. Treat that window as non-idle so
    // Fork cannot race a prompt that is already waiting for delivery.
    const isNativeQueueWaiting = hasNativeQueuedMessages && directStatus === 'idle'
    const isNativeIdle = !isSendingDirect && directStatus === 'idle' && !hasNativeQueuedMessages
    const canFork = Boolean(props.machineId) && !isForking && isNativeIdle
    const composerDisabled = !props.machineId
        || statusQuery.isLoading
        || statusQuery.isError
        || directStatus === null
        || directStatus === 'unknown'
    const composerNotice = isNativeProcessing
        ? t('recentCodex.direct.processing')
        : isNativeQueueWaiting
            ? t('recentCodex.status.queued')
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

    const nativeAgentStatusClass = nativeConnectionHealth === 'offline'
        ? 'bg-[#FF3B30]'
        : nativeConnectionHealth === 'degraded' || nativeConnectionHealth === 'recovering'
            ? 'bg-[#FF9500] animate-pulse'
            : directStatus === 'processing'
                ? 'bg-[#007AFF] animate-pulse'
                : 'bg-[#34C759]'

    const title = context?.session.title ?? t('recentCodex.context.title')
    const sessionDetails = useMemo<SessionHeaderDetail[]>(() => buildSessionHeaderDetails({
        title,
        sessionId: props.sessionId,
        projectPath: context?.session.cwd,
        lastActivityAt: context?.session.modifiedAt,
        agentFlavor: 'codex',
        model: context?.session.model,
        reasoning: context?.session.modelReasoningEffort
    }, t), [context?.session.cwd, context?.session.model, context?.session.modelReasoningEffort, context?.session.modifiedAt, props.sessionId, t, title])

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

    const sendDirectMessage = useCallback((text: string) => {
        if (!props.machineId || directStatus === null || directStatus === 'unknown') {
            return
        }
        const requestScope = pageScope
        const requestNativeDirectMessageScope = nativeDirectMessageScope
        const echoId = makeClientSideId('native')
        const echo: NativeDirectMessageEcho = {
            id: echoId,
            text,
            createdAt: Date.now(),
            status: 'sending',
            queueId: null,
            observedTranscriptMessageIds: messages.map((message) => message.id),
            observedThroughPosition: messages.reduce<number | null>((latest, message) => (
                typeof message.position !== 'number'
                    ? latest
                    : Math.max(latest ?? message.position, message.position)
            ), null)
        }
        // Show the person's words before the hub/runner round trip completes.
        // This makes a slow native process feel like an acknowledged action,
        // rather than a button press that appears to have done nothing.
        updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => [...current, echo])
        setNativeForceScrollToken((token) => token + 1)
        setPendingDirectSendCount((count) => count + 1)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        void (async () => {
            try {
                const response = await props.api.sendCodexSessionMessage(props.sessionId, {
                    machineId: props.machineId!,
                    message: text
                })
                if (response.success !== true) {
                    throw new ApiError(response.error, 409, response.code)
                }
                updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                    message.id !== echoId
                        ? message
                        : {
                            ...message,
                            // The HTTP 202 is the runner's acceptance receipt.
                            // Stop showing a network spinner once it has
                            // accepted the prompt; the clock remains until the
                            // native transcript echoes it back.
                            status: 'queued' as const,
                            queueId: response.queueId ?? null
                        }
                )))
                if (pageScopeRef.current !== requestScope) {
                    return
                }
                if (Array.isArray(response.queuedMessages) && response.queuedMessages.length > 0) {
                    setNativeQueuedMessages(response.queuedMessages)
                } else if (response.status === 'queued' && response.queueId && response.queuedAt !== undefined) {
                    setNativeQueuedMessages((messages) => [
                        ...messages,
                        { id: response.queueId!, text, queuedAt: response.queuedAt! }
                    ])
                }
                // The accepted post already tells us whether it is running or
                // queued. Let the push update/background read reconcile the
                // transcript without blocking another message from being sent.
                void refetchNativeSnapshot()
            } catch (error) {
                // Keep an explicit failure receipt even if the person already
                // left this page. It is removed if a late runner write proves
                // the prompt did reach the native transcript after all.
                updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                    message.id === echoId ? { ...message, status: 'failed' as const } : message
                )))
                if (pageScopeRef.current !== requestScope) {
                    return
                }
                setDirectSendError({
                    id: Date.now(),
                    text,
                    message: formatDirectSendError(error, t),
                    scheduledAt: null
                })
            } finally {
                if (pageScopeRef.current === requestScope) {
                    setPendingDirectSendCount((count) => Math.max(0, count - 1))
                }
            }
        })()
    }, [
        directStatus,
        messages,
        nativeDirectMessageScope,
        pageScope,
        props.api,
        props.machineId,
        props.sessionId,
        refetchNativeSnapshot,
        t,
        updateNativeDirectMessageEchoes
    ])

    return (
        <SessionConnectionProvider value={nativeConnectionContext}>
            <SessionDetailSurface source="codex" testId="codex-session-context-page">
                <FloatingSessionHeader
                    onBack={props.onBack}
                    backLabel={t('recentCodex.back')}
                    title={title}
                    details={sessionDetails}
                    floating
                    actions={(
                        <div className="flex shrink-0 items-center gap-1">
                            <CodexSubscriptionLimitsBadge
                                limits={codexLimitsState.limits}
                                isFetching={codexLimitsState.isFetching}
                                error={codexLimitsState.error}
                            />
                            <button
                                type="button"
                                {...menuActivation}
                                onPointerDown={(event) => {
                                    menuActivation.onPointerDown(event)
                                    event.stopPropagation()
                                }}
                                ref={menuAnchorRef}
                                data-testid="codex-native-session-menu-trigger"
                                aria-haspopup="menu"
                                aria-expanded={menuOpen}
                                aria-controls={menuOpen ? menuId : undefined}
                                aria-label={t('session.more')}
                                className="pointer-events-auto touch-manipulation flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--app-fg)_14%,var(--app-bg))] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-[0_8px_24px_rgba(15,23,42,0.10)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]"
                                title={t('session.more')}
                            >
                                <AgentFlavorStatusIcon
                                    flavor="codex"
                                    className="h-5 w-5"
                                    showStatus
                                    statusClassName={nativeAgentStatusClass}
                                />
                            </button>
                        </div>
                    )}
                />
                <SessionActionMenu
                    isOpen={menuOpen}
                    onClose={() => setMenuOpen(false)}
                    sessionActive={directStatus === 'processing'}
                    onRefresh={() => void recoverNativeConnection()}
                    refreshLabel={t('recentCodex.refresh')}
                    refreshPending={isRecoveringConnection}
                    onFork={() => void fork()}
                    forkLabel={t('recentCodex.fork')}
                    forkPendingLabel={t('recentCodex.forking')}
                    forkPending={isForking}
                    forkDisabled={!canFork}
                    onToggleOutline={() => setOutlineOpen((open) => !open)}
                    outlineActive={outlineOpen}
                    anchorPoint={menuAnchorPoint}
                    menuId={menuId}
                />
                <SessionConnectionRecoveryControl
                    labels={{
                        degraded: t('session.connection.native.degraded'),
                        recovering: t('session.connection.native.recovering'),
                        offline: t('session.connection.native.offline'),
                        recover: t('session.connection.native.recover')
                    }}
                />

                <SessionDetailContent ariaLabel={t('recentCodex.context.title')}>
                    {!props.machineId ? (
                        <div className="px-3 py-3">
                            <SessionDetailStatusNotice
                                tone="error"
                                title={t('recentCodex.runnerRequired')}
                                testId="codex-runner-required"
                            />
                        </div>
                    ) : contextQuery.isLoading ? (
                        <NativeContextTypingIndicator label={t('recentCodex.context.loading')} />
                    ) : contextQuery.error && !context ? (
                        <div className="px-3 py-3">
                            <SessionDetailStatusNotice
                                tone="error"
                                title={t('recentCodex.context.failed')}
                                detail={errorMessage(contextQuery.error)}
                                action={{
                                    label: t('recentCodex.retry'),
                                    onClick: () => void contextQuery.refetch(),
                                    busy: contextQuery.isFetching
                                }}
                                testId="codex-session-context-error"
                            />
                        </div>
                    ) : context ? (
                        <NativeCodexThread
                            api={props.api}
                            sessionId={props.sessionId}
                            title={title}
                            metadata={nativeMetadata}
                            messages={messages}
                            directMessageEchoes={visibleNativeDirectMessageEchoes}
                            version={contextQuery.dataUpdatedAt + olderPages.length + nativeForceScrollToken}
                            hasMoreMessages={hasMoreMessages}
                            isLoadingMoreMessages={isLoadingMore}
                            onLoadMore={loadMore}
                            outlineOpen={outlineOpen}
                            onOutlineOpenChange={setOutlineOpen}
                            isProcessing={isNativeProcessing}
                            queuedMessages={nativeQueuedMessages}
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
                            onRefresh={refreshNativeDataOnForeground}
                            forceScrollToken={nativeForceScrollToken}
                        />
                    ) : null}
                </SessionDetailContent>
                {isForking ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="loading"
                            title={t('recentCodex.fork.progress.title')}
                            detail={t('recentCodex.fork.progress.body')}
                            testId="codex-fork-progress"
                        />
                    </div>
                ) : forkError ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="error"
                            title={t('recentCodex.fork.failed.title')}
                            detail={forkError}
                            action={{
                                label: t('recentCodex.retry'),
                                onClick: () => void fork(),
                                disabled: !canFork
                            }}
                            testId="codex-fork-error"
                        />
                    </div>
                ) : isNativeQueueWaiting ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="processing"
                            title={t('recentCodex.status.queued')}
                            compact
                            testId="codex-status-queued"
                        />
                    </div>
                ) : directStatus === 'unknown' || statusQuery.isError ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="warning"
                            title={directStatus === 'unknown' ? t('recentCodex.status.unknown') : t('recentCodex.status.failed')}
                            detail={t('recentCodex.status.locked')}
                            action={{
                                label: t('recentCodex.retry'),
                                onClick: () => void refetchNativeSnapshot(),
                                busy: statusQuery.isFetching
                            }}
                            testId="codex-status-error"
                        />
                    </div>
                ) : null}
            </SessionDetailSurface>
        </SessionConnectionProvider>
    )
}
