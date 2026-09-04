import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BadgeCheck, Bot, BrainCircuit, Clock3, RefreshCw, Zap } from 'lucide'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, type ApiClient } from '@/api/client'
import type {
    CodexLocalSessionContextMessage,
    CodexLocalSessionContextResponse,
    CodexLocalSessionDirectSendProgress,
    CodexLocalSessionDirectSendRecoveryReason,
    CodexLocalSessionPlan,
    CodexLocalSessionQueuedMessage,
    CodexLocalSessionRunState,
    CodexLocalSessionSnapshotResponse,
    CodexLocalSessionStatusResponse,
    DecryptedMessage,
    SessionMetadataSummary,
    SkillSummary
} from '@/types/api'
import {
    buildSessionHeaderDetails,
    CodexSubscriptionLimitsBadge,
    FloatingSessionHeader,
    SessionConnectionRecoveryControl,
    type SessionHeaderDetail
} from '@/components/SessionHeader'
import { AgentFlavorStatusIcon } from '@/components/AgentFlavorIcon'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SESSION_DETAIL_HEADER_HEIGHT_PX } from '@/components/SessionDetailHeader'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { PlanStatusSummary, type PlanStatusSummaryData } from '@/components/AssistantChat/PlanStatusSummary'
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
import { expandCodexCustomPrompt } from '@/lib/codexSlashCommands'
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
import {
    createNativeSnapshotRefreshCoordinator,
    isNativeSnapshotVersionCovered,
    type NativeSnapshotRefreshCoordinator,
    type NativeSnapshotVersion
} from '@/lib/native-snapshot-refresh-coordinator'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useCodexSubscriptionLimits } from '@/hooks/queries/useCodexSubscriptionLimits'
import { useNativeCodexSessionComposerCapabilities } from '@/hooks/queries/useNativeCodexSessionComposerCapabilities'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { SessionDetailContent, SessionDetailSurface } from '@/components/SessionDetailSurface'
import { SessionDetailStatusNotice } from '@/components/SessionDetailStatusNotice'
import { SessionConversationLoading } from '@/components/SessionEntryLoading'
import { MotionIcon, toMotionIcon } from '@/components/MotionIcon'
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
const NATIVE_ORPHANED_RECEIPT_GRACE_MS = 3_000
const NATIVE_UNCONFIRMED_RECEIPT_GRACE_MS = 15_000

function areNativeQueueRefsCurrent(
    messages: readonly CodexLocalSessionQueuedMessage[],
    refs: ReadonlyArray<Pick<CodexLocalSessionQueuedMessage, 'id' | 'recoveryRequired' | 'recoveryReason'>>
): boolean {
    return messages.length === refs.length && messages.every((message, index) => {
        const ref = refs[index]
        return ref?.id === message.id
            && Boolean(ref.recoveryRequired) === Boolean(message.recoveryRequired)
            && ref.recoveryReason === message.recoveryReason
    })
}

export type NativeCodexDirectSendPhase = CodexLocalSessionDirectSendProgress['phase'] | 'queued'

const NATIVE_DIRECT_SEND_PHASE_ICONS = {
    queued: Clock3,
    launching: Zap,
    matching: Bot,
    connected: BadgeCheck,
    retrying: RefreshCw,
    reasoning: BrainCircuit
} as const

function NativeCodexDirectSendPhaseIcon(props: { phase: NativeCodexDirectSendPhase }) {
    return (
        <MotionIcon
            icon={toMotionIcon(NATIVE_DIRECT_SEND_PHASE_ICONS[props.phase])}
            className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400"
            data-motion-icon={`native-direct-${props.phase}`}
        />
    )
}

/**
 * Native Codex has a real hand-off gap between runner acceptance and the
 * transcript write. Surface that gap instead of leaving a generic spinner.
 */
export function getNativeCodexDirectSendPhase(input: {
    pendingDirectSendCount: number
    queuedMessages: readonly CodexLocalSessionQueuedMessage[]
    directMessageEchoes: readonly NativeDirectMessageEcho[]
    runState: CodexLocalSessionRunState | null
    progress?: CodexLocalSessionDirectSendProgress | null
    hasAgentReply?: boolean
}): NativeCodexDirectSendPhase | null {
    const activeEchoes = input.directMessageEchoes.filter((echo) => echo.status !== 'failed')
    if (input.pendingDirectSendCount > 0 || activeEchoes.some((echo) => echo.deliveryPhase === 'launching')) {
        return 'launching'
    }
    if (input.queuedMessages.length > 0 || activeEchoes.some((echo) => echo.deliveryPhase === 'queued')) {
        return 'queued'
    }
    if (input.progress) {
        if (input.progress.phase === 'reasoning' && input.hasAgentReply && activeEchoes.length === 0) {
            return null
        }
        return input.progress.phase
    }
    if (input.runState === 'processing') {
        if (input.hasAgentReply && activeEchoes.length === 0) {
            return null
        }
        return 'reasoning'
    }
    return [...activeEchoes]
        .reverse()
        .find((echo) => echo.deliveryPhase !== 'queued')
        ?.deliveryPhase ?? null
}

function isNativeCodexAgentReply(message: CodexLocalSessionContextMessage): boolean {
    if (message.content.role !== 'agent') return false
    const content = message.content.content
    if (!content || typeof content !== 'object' || Array.isArray(content)) return false
    const envelope = content as { type?: unknown; data?: unknown }
    if (envelope.type !== 'codex' || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
        return false
    }
    const data = envelope.data as { type?: unknown; message?: unknown }
    return data.type === 'message'
        && typeof data.message === 'string'
        && data.message.trim().length > 0
}

/** An agent text response belongs to the newest native prompt in the transcript. */
export function hasNativeCodexAgentReply(messages: readonly CodexLocalSessionContextMessage[]): boolean {
    let latestUserMessageIndex = -1
    let latestAgentReplyIndex = -1
    messages.forEach((message, index) => {
        if (message.content.role === 'user') {
            latestUserMessageIndex = index
        } else if (isNativeCodexAgentReply(message)) {
            latestAgentReplyIndex = index
        }
    })
    return latestAgentReplyIndex > latestUserMessageIndex
}

function getNativeCodexDirectSendPhaseStartedAt(input: {
    phase: NativeCodexDirectSendPhase | null
    progress?: CodexLocalSessionDirectSendProgress | null
    directMessageEchoes: readonly NativeDirectMessageEcho[]
}): number | null {
    if (!input.phase) return null
    if (input.progress?.phase === input.phase) return input.progress.phaseStartedAt
    const matchingEcho = [...input.directMessageEchoes]
        .reverse()
        .find((echo) => echo.status !== 'failed' && echo.deliveryPhase === input.phase)
    return matchingEcho?.phaseStartedAt ?? null
}

/**
 * Native transcript reads can take a moment while the runner reads Codex's
 * local history. Match the SHAPI session's first-paint conversation skeleton.
 */
function NativeContextTypingIndicator(props: { label: string }) {
    return (
        <SessionConversationLoading
            label={props.label}
            testId="codex-session-context-loading"
            composerTestId="codex-session-context-composer-skeleton"
        />
    )
}

export function getNativeContextRefreshInterval(
    status: CodexLocalSessionStatusResponse | undefined
): number | false {
    return status?.success === true && (status.status === 'processing' || status.controlledByCodexSsh === true)
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
            case 'external_writer_active':
                return t('recentCodex.direct.error.externalWriter')
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
        if (error.code === 'request_timeout') {
            return t('recentCodex.direct.error.deliveryUnconfirmed')
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

function shouldVerifyDirectSendReceipt(error: unknown): boolean {
    // The POST may have reached the hub/runner before the browser gave up on
    // its response. Do not label that receipt as a definite failure or
    // silently submit it again with a new id.
    return error instanceof ApiError && (
        error.code === 'request_timeout'
        || error.status === 408
        || error.status >= 500
    )
}

function getNativeRecoveryDetail(
    reason: CodexLocalSessionDirectSendRecoveryReason | null,
    uncertain: boolean,
    t: Translator
): string {
    switch (reason) {
        case 'external_writer_active':
            return t('recentCodex.direct.error.externalWriter')
        case 'codex_timeout':
            return t('recentCodex.direct.recovery.timeout')
        case 'session_status_unknown':
            return t('recentCodex.direct.recovery.statusUnknown')
        case 'launch_failed':
            return t('recentCodex.direct.recovery.launchFailed')
        case 'runner_restarted':
            return t('recentCodex.direct.recovery.uncertain')
        default:
            return uncertain
                ? t('recentCodex.direct.recovery.uncertain')
                : t('recentCodex.direct.recovery.stalled')
    }
}

function getNativeRecoveryActionLabel(
    reason: CodexLocalSessionDirectSendRecoveryReason | null,
    t: Translator
): string {
    return reason === 'launch_failed'
        ? t('recentCodex.direct.recovery.retry')
        : t('recentCodex.direct.recovery.action')
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
 * Use the normal SHAPI message normalizer and reducer so local Codex history
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
 * no SHAPI message row or localId for the transcript to echo back. Keep a
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
            && (() => {
                const messageText = getNativeUserMessageText(message)
                return messageText === echo.text || messageText === echo.deliveryText
            })()
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

/**
 * Native transcript plans are not SHAPI messages. Build the shared visual
 * model directly from the full snapshot, and only while the runner confirms
 * that exact Codex turn is still processing.
 */
export function getNativeCodexPlanStatus(
    plan: CodexLocalSessionPlan | null | undefined,
    runState: CodexLocalSessionRunState | null,
    activeTurnId: string | null | undefined
): PlanStatusSummaryData | null {
    if (!plan || runState !== 'processing' || !activeTurnId || plan.turnId !== activeTurnId || plan.steps.length === 0) {
        return null
    }

    const steps = plan.steps.map((step) => ({
        text: step.text,
        status: step.status
    }))
    const inProgressIndex = steps.findIndex((step) => step.status === 'in_progress')
    const pendingIndex = steps.findIndex((step) => step.status === 'pending')
    const currentIndex = inProgressIndex >= 0
        ? inProgressIndex
        : pendingIndex >= 0
            ? pendingIndex
            : Math.max(0, steps.length - 1)

    return {
        sourceBlockId: `native-plan:${plan.turnId}:${plan.callId}`,
        steps,
        total: steps.length,
        completed: steps.filter((step) => step.status === 'completed').length,
        currentIndex,
        currentStep: steps[currentIndex]
    }
}

function NativeCodexThread(props: {
    api: ApiClient
    sessionId: string
    projectPath?: string | null
    machineId?: string
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
    runState: CodexLocalSessionRunState | null
    activeTurnId?: string | null
    plan?: CodexLocalSessionPlan | null
    queuedMessages: readonly CodexLocalSessionQueuedMessage[]
    composerDisabled: boolean
    composerLocked: boolean
    composerNotice: string | null
    sendError: ComposerSendError | null
    autocompleteSuggestions: (query: string) => Promise<Suggestion[]>
    skills: SkillSummary[]
    skillsLoading: boolean
    skillsError: string | null
    onClearSendError: () => void
    onSendMessage: (text: string) => void
    onRefresh: () => void
    forceScrollToken: number
}) {
    const composerOverlayRef = useRef<HTMLDivElement | null>(null)
    const accessoryOverlayRef = useRef<HTMLDivElement | null>(null)
    const [composerHeight, setComposerHeight] = useState(0)
    const [accessoryHeight, setAccessoryHeight] = useState(0)
    const [queueAccessoryExpanded, setQueueAccessoryExpanded] = useState(false)
    const [planAccessoryExpanded, setPlanAccessoryExpanded] = useState(false)
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
    const nativePlan = useMemo(
        () => getNativeCodexPlanStatus(props.plan, props.runState, props.activeTurnId),
        [props.activeTurnId, props.plan, props.runState]
    )
    useEffect(() => {
        if (!nativePlan) {
            setPlanAccessoryExpanded(false)
        }
    }, [nativePlan])
    const timeline = useMemo(
        () => buildSessionDetailTimeline(ungroupedBlocks, {
            hasMoreMessages: props.hasMoreMessages,
            terminalToolDisplayMode,
            runActive: props.isProcessing,
            aggregateActiveProcess: true
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
        const node = accessoryOverlayRef.current
        if (!node) {
            setAccessoryHeight(0)
            return
        }

        const measure = () => {
            const height = Math.ceil(node.getBoundingClientRect().height)
            setAccessoryHeight((current) => current === height ? current : height)
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
    }, [nativePlan?.sourceBlockId, props.queuedMessages.length])

    const queueAccessoryVisible = props.queuedMessages.length > 0
    const accessoryVisible = queueAccessoryVisible || nativePlan !== null
    const totalBottomInset = composerHeight + (accessoryHeight > 0 ? accessoryHeight + NATIVE_QUEUE_FLOATING_GAP_PX : 0)

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <div className="relative flex min-h-0 flex-1 flex-col">
                <HappyThread
                    key={`codex-context-thread-${props.sessionId}`}
                    api={props.api}
                    sessionId={`codex-context-${props.sessionId}`}
                    metadata={props.metadata}
                    fileLinkTarget={props.machineId ? {
                        type: 'native-codex',
                        sessionId: props.sessionId,
                        machineId: props.machineId
                    } : undefined}
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
                    bottomAccessoryVisible={accessoryVisible}
                    bottomAccessoryExpanded={queueAccessoryExpanded || planAccessoryExpanded}
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
                                projectPath={props.projectPath}
                                disabled={props.composerDisabled}
                                locked={props.composerLocked}
                                active
                                agentFlavor={null}
                                showStatusBar={false}
                                allowAttachments={false}
                                inactiveNotice={props.composerNotice}
                                autocompletePrefixes={['/', '$']}
                                autocompleteSuggestions={props.autocompleteSuggestions}
                                skills={props.skills}
                                skillsLoading={props.skillsLoading}
                                skillsError={props.skillsError}
                                sendError={props.sendError}
                                onClearSendError={props.onClearSendError}
                            />
                        </div>
                    </SessionDetailBottomDockComposer>

                    {accessoryVisible ? (
                        <SessionDetailBottomDockAccessory
                            ref={accessoryOverlayRef}
                            testId="codex-native-session-accessory-overlay"
                        >
                            <div className="pointer-events-auto flex flex-col gap-2">
                                {nativePlan ? (
                                    <PlanStatusSummary
                                        plan={nativePlan}
                                        onExpandedChange={setPlanAccessoryExpanded}
                                    />
                                ) : null}
                                {queueAccessoryVisible ? (
                                    <NativeQueuedMessagesBar
                                        messages={props.queuedMessages}
                                        onExpandedChange={setQueueAccessoryExpanded}
                                    />
                                ) : null}
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
 * accepts prompts while a turn is running; SHAPI keeps only a small FIFO for
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
    const nativeApplySequenceRef = useRef(0)
    const [isForking, setIsForking] = useState(false)
    const [forkError, setForkError] = useState<string | null>(null)
    const contextQuery = useQuery({
        queryKey: nativeSnapshotQueryKey,
        queryFn: async (): Promise<CodexLocalSessionSnapshotResponse> => {
            if (!props.machineId) {
                throw new Error(t('recentCodex.runnerRequired'))
            }
            const requestApplySequence = nativeApplySequenceRef.current
            const known = queryClient.getQueryData<CodexLocalSessionSnapshotResponse>(nativeSnapshotQueryKey)
            const response = await props.api.getCodexSessionSnapshot(props.sessionId, props.machineId, {
                limit: 50,
                ...(known?.version ? { knownVersion: known.version } : {})
            })
            if (response.unchanged === true) {
                const current = queryClient.getQueryData<CodexLocalSessionSnapshotResponse>(nativeSnapshotQueryKey)
                if (!current) {
                    // A cache clear can race a conditional response. Recover
                    // with the ordinary full read instead of inventing data.
                    const recovered = await props.api.getCodexSessionSnapshot(
                        props.sessionId,
                        props.machineId,
                        { limit: 50 }
                    )
                    if (recovered.unchanged === true) {
                        throw new Error('Native Codex runner returned an invalid conditional snapshot')
                    }
                    return recovered
                }
                const realtimeAppliedAfterRequest = nativeApplySequenceRef.current > requestApplySequence
                return {
                    ...current,
                    session: response.session
                        ? { ...current.session, ...response.session }
                        : current.session,
                    status: realtimeAppliedAfterRequest ? current.status : response.status,
                    version: response.version,
                    revision: response.revision,
                    timing: realtimeAppliedAfterRequest ? current.timing : response.timing
                }
            }

            const current = queryClient.getQueryData<CodexLocalSessionSnapshotResponse>(nativeSnapshotQueryKey)
            if (current && nativeApplySequenceRef.current > requestApplySequence) {
                if (
                    current.version
                    && response.version
                    && isNativeSnapshotVersionCovered(current.version, response.version)
                ) {
                    return current
                }
                if (!current.version && !response.version && current.revision > response.revision) {
                    return current
                }
                // Transcript revision and run status advance independently.
                // A compact status event applied while this full body was in
                // flight is newer in browser application order. Keep that
                // status while accepting the response's transcript/page.
                return {
                    ...response,
                    status: current.status,
                    timing: current.timing
                }
            }
            return response
        },
        enabled: Boolean(props.machineId),
        // The page coordinator owns bounded retry/backoff. Query-level retry
        // would double every attempt, including permanent 4xx responses.
        retry: false,
        // A native realtime payload updates this cache directly. Poll only
        // when an older runner cannot provide that stream, except while SSH
        // owns this thread: bounded polling recovers a missed release event.
        refetchInterval: (query) => {
            const status = (query.state.data as CodexLocalSessionSnapshotResponse | undefined)?.status
            if (hasRealtimeUpdates && status?.controlledByCodexSsh !== true) return false
            return getNativeContextRefreshInterval(status)
        },
        refetchIntervalInBackground: false,
        refetchOnMount: 'always',
        // Foreground and reconnect recovery are coalesced below. Letting React
        // Query run its own copies caused the same large snapshot to race in
        // from several independent entry points.
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
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
    const nativeComposerCapabilities = useNativeCodexSessionComposerCapabilities(
        props.api,
        props.machineId,
        props.sessionId
    )
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
    const [isRecoveringNativeDelivery, setIsRecoveringNativeDelivery] = useState(false)
    const [isDiscardingNativeRecovery, setIsDiscardingNativeRecovery] = useState(false)
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
    const attemptedNativeDirectMessageIdsRef = useRef(new Set<string>())
    const connectionRecoveryTokenRef = useRef(0)
    const nativeRecoveryAbortControllerRef = useRef<AbortController | null>(null)
    const nativeRecoveryRequestTokenRef = useRef(0)
    const snapshotRefreshCoordinatorRef = useRef<NativeSnapshotRefreshCoordinator | null>(null)
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const menuId = useId()
    pageScopeRef.current = pageScope
    nativeDirectMessageScopeKeyRef.current = nativeDirectMessageScopeKey

    useEffect(() => {
        nativeDirectMessagePageMountedRef.current = true
        return () => {
            nativeDirectMessagePageMountedRef.current = false
            nativeRecoveryRequestTokenRef.current += 1
            nativeRecoveryAbortControllerRef.current?.abort()
            nativeRecoveryAbortControllerRef.current = null
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
        nativeRecoveryRequestTokenRef.current += 1
        nativeRecoveryAbortControllerRef.current?.abort()
        nativeRecoveryAbortControllerRef.current = null
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
        setIsRecoveringNativeDelivery(false)
        setIsDiscardingNativeRecovery(false)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        setConnectionNow(Date.now())
        attemptedNativeDirectMessageIdsRef.current.clear()
        setOutlineOpen(false)
        setMenuOpen(false)
        connectionRecoveryTokenRef.current += 1
    }, [nativeDirectMessageScope, nativeDirectMessageScopeKey, props.machineId, props.sessionId])

    useEffect(() => {
        const response = statusQuery.data
        if (response?.success === true) {
            const queuedMessages = Array.isArray(response.queuedMessages) ? response.queuedMessages : null
            // Do not clear a locally confirmed queue from a response produced
            // by an older runner (or from the short processing window before
            // the runner has published its queue). Once the native turn is
            // idle, an explicit empty array is authoritative and clears it.
            if (queuedMessages) {
                setNativeQueuedMessages((current) => queuedMessages.length === 0
                    && current.length > 0
                    && response.status !== 'idle'
                    ? current
                    : queuedMessages)
            }
            const queuedMessageIds = new Set(queuedMessages?.map((message) => message.id) ?? [])
            const discardedExternalWriterEchoId = response.lastErrorCode === 'external_writer_active'
                ? response.lastErrorClientMessageId ?? null
                : null
            updateNativeDirectMessageEchoes(nativeDirectMessageScope, (current) => {
                if (discardedExternalWriterEchoId && current.some((echo) => echo.id === discardedExternalWriterEchoId)) {
                    // A writer conflict is reported before turn/start, so the
                    // optimistic bubble is known not to exist in Codex.
                    return current.filter((echo) => echo.id !== discardedExternalWriterEchoId)
                }
                let changed = false
                const failedEchoIndex = response.lastError && (
                    response.lastErrorClientMessageId !== undefined || response.lastErrorAt !== undefined
                )
                    ? current.reduce((latest, echo, index) => (
                        (response.lastErrorClientMessageId !== undefined
                            ? echo.id === response.lastErrorClientMessageId
                            : echo.createdAt <= response.lastErrorAt!)
                        && echo.status !== 'failed'
                        && echo.deliveryPhase !== 'queued'
                            ? index
                            : latest
                    ), -1)
                    : -1
                const activeEchoIndex = response.progress
                    ? current.reduce((latest, echo, index) => (
                        echo.status !== 'failed' && echo.deliveryPhase !== 'queued' ? index : latest
                    ), -1)
                    : -1
                const next = current.map((echo, index) => {
                    if (index === failedEchoIndex) {
                        changed = true
                        return { ...echo, status: 'failed' as const }
                    }
                    if (
                        queuedMessages
                        && echo.deliveryPhase === 'queued'
                        && echo.queueId
                        && !queuedMessageIds.has(echo.queueId)
                        // An explicit empty queue without runner-owned
                        // progress can also mean the runner restarted. Keep
                        // this durable receipt queued until the person
                        // confirms recovery; do not turn it into an implicit
                        // retry that could duplicate work.
                        && response.progress
                    ) {
                        changed = true
                        return {
                            ...echo,
                            status: 'sending' as const,
                            deliveryPhase: 'matching' as const,
                            phaseStartedAt: Date.now()
                        }
                    }
                    if (response.progress && index === activeEchoIndex) {
                        if (
                            echo.deliveryPhase === response.progress.phase
                            && echo.phaseStartedAt === response.progress.phaseStartedAt
                        ) {
                            return echo
                        }
                        changed = true
                        return {
                            ...echo,
                            deliveryPhase: response.progress.phase,
                            phaseStartedAt: response.progress.phaseStartedAt
                        }
                    }
                    return echo
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
    // Native transcripts do not carry SHAPI's SessionMetadata row. Supplying a
    // small, explicit Codex metadata view keeps the shared thread renderer's
    // agent icon, path shortening and permission presentation identical to a
    // normal Codex session without inventing SHAPI-only state.
    const nativeMetadata = useMemo<SessionMetadataSummary>(() => ({
        path: context?.session.cwd ?? '',
        host: 'local',
        flavor: 'codex',
        capabilities: { terminal: true }
    }), [context?.session.cwd])
    const directStatus = statusQuery.data?.success === true ? statusQuery.data.status : null
    // This remains a processing run state so every web prompt is safely
    // queued. The actual question and its answer never leave local Codex.
    const nativeWaitingForUserInput = statusQuery.data?.success === true
        && statusQuery.data.waitingForUserInput === true
    const rawDirectStatusError = statusQuery.data?.success === true ? statusQuery.data.lastError ?? null : null
    const directStatusErrorCode = statusQuery.data?.success === true ? statusQuery.data.lastErrorCode ?? null : null
    const controlledByCodexSsh = statusQuery.data?.success === true
        ? statusQuery.data.controlledByCodexSsh
        : undefined
    // A current runner explicitly sends false on release. The old
    // post-resume conflict remains a compatibility fallback only when this
    // field is absent, so a stale `lastErrorCode` cannot keep a new UI locked.
    const legacyExternalWriterActive = controlledByCodexSsh === undefined
        && directStatusErrorCode === 'external_writer_active'
    const sshControlled = controlledByCodexSsh === true || legacyExternalWriterActive
    const directStatusErrorClientMessageId = statusQuery.data?.success === true
        ? statusQuery.data.lastErrorClientMessageId ?? null
        : null
    const directStatusError = controlledByCodexSsh === false && directStatusErrorCode === 'external_writer_active'
        ? null
        : rawDirectStatusError && directStatusErrorCode
            ? getNativeRecoveryDetail(directStatusErrorCode, true, t)
            : rawDirectStatusError
    const nativeStalledSince = statusQuery.data?.success === true ? statusQuery.data.stalledSince ?? null : null
    const runnerQueuedMessages = statusQuery.data?.success === true && Array.isArray(statusQuery.data.queuedMessages)
        ? statusQuery.data.queuedMessages
        : null
    const nativeRecoveryCandidate = useMemo(() => {
        if (directStatusErrorCode === 'external_writer_active') {
            // The runner knows the bridge was rejected before turn/start, so
            // this is not an uncertain delivery and must not block reading or
            // offer a retry for the discarded optimistic message.
            return { candidate: null, uncertain: false, reason: null }
        }
        const runnerQueueIds = new Set(runnerQueuedMessages?.map((message) => message.id) ?? [])
        const recoveryRequired = nativeQueuedMessages.find((message) => message.recoveryRequired)
        const staleQueued = nativeStalledSince !== null ? nativeQueuedMessages[0] : null
        const failedEcho = directStatusErrorCode && directStatusErrorClientMessageId
            ? currentNativeDirectMessageEchoes.find((echo) => echo.id === directStatusErrorClientMessageId) ?? null
            : null
        const orphanedQueued = runnerQueuedMessages
            ? nativeQueuedMessages.find((message) => (
                !runnerQueueIds.has(message.id)
                && connectionNow - message.queuedAt >= NATIVE_ORPHANED_RECEIPT_GRACE_MS
            ))
            : null
        const orphanedEcho = runnerQueuedMessages
            ? currentNativeDirectMessageEchoes.find((echo) => (
                (
                    echo.status === 'queued'
                    && echo.deliveryPhase === 'queued'
                    && echo.queueId !== null
                    && !runnerQueueIds.has(echo.queueId)
                    && connectionNow - echo.phaseStartedAt >= NATIVE_ORPHANED_RECEIPT_GRACE_MS
                )
                || (
                    echo.status !== 'queued'
                    && !runnerQueueIds.has(echo.id)
                    && connectionNow - echo.createdAt >= NATIVE_UNCONFIRMED_RECEIPT_GRACE_MS
                )
            ))
            : null
        const queued = recoveryRequired ?? staleQueued ?? orphanedQueued
        const matchingEcho = queued
            ? currentNativeDirectMessageEchoes.find((echo) => echo.id === queued.id) ?? null
            : orphanedEcho ?? failedEcho
        const id = queued?.id ?? orphanedEcho?.id ?? failedEcho?.id ?? null
        const reason = recoveryRequired?.recoveryReason
            ?? (nativeStalledSince !== null ? 'codex_timeout' : null)
            ?? (failedEcho ? directStatusErrorCode : null)
            ?? (orphanedQueued || orphanedEcho ? 'runner_restarted' : null)
        if (!id) {
            return {
                candidate: null,
                uncertain: Boolean(recoveryRequired || orphanedQueued || orphanedEcho || failedEcho),
                reason
            }
        }
        return {
            candidate: {
                id,
                text: matchingEcho?.text ?? queued?.text ?? '',
                deliveryText: matchingEcho?.deliveryText ?? matchingEcho?.text ?? queued?.text ?? ''
            },
            uncertain: Boolean(recoveryRequired || orphanedQueued || orphanedEcho || failedEcho),
            reason
        }
    }, [
        connectionNow,
        currentNativeDirectMessageEchoes,
        directStatusErrorClientMessageId,
        directStatusErrorCode,
        nativeQueuedMessages,
        nativeStalledSince,
        runnerQueuedMessages
    ])
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
    const rawRefetchNativeSnapshot = contextQuery.refetch
    const nativeSnapshotInFlightRef = useRef<{
        scope: string
        promise: ReturnType<typeof rawRefetchNativeSnapshot>
    } | null>(null)
    const refetchNativeSnapshot = useCallback(() => {
        const current = nativeSnapshotInFlightRef.current
        if (current?.scope === pageScope) {
            return current.promise
        }
        const request = rawRefetchNativeSnapshot({ cancelRefetch: false })
        const tracked = { scope: pageScope, promise: request }
        nativeSnapshotInFlightRef.current = tracked
        void request.finally(() => {
            if (nativeSnapshotInFlightRef.current === tracked) {
                nativeSnapshotInFlightRef.current = null
            }
        })
        return request
    }, [pageScope, rawRefetchNativeSnapshot])
    const refetchNativeSnapshotRef = useRef(refetchNativeSnapshot)
    refetchNativeSnapshotRef.current = refetchNativeSnapshot

    const applyNativeRealtimeSnapshot = useCallback((event: Parameters<typeof getNativeCodexRealtimeSnapshot>[0]): {
        covered: boolean
        requiresStatusRefresh: boolean
        version: NativeSnapshotVersion
    } | null => {
        const snapshot = getNativeCodexRealtimeSnapshot(event)
        if (!snapshot) {
            return null
        }
        let covered = false
        let applied = false
        let requiresStatusRefresh = false
        queryClient.setQueryData<CodexLocalSessionSnapshotResponse>(
            nativeSnapshotQueryKey,
            (current) => {
                if (!current) {
                    return current
                }
                const { queuedMessageRefs, ...realtimeStatus } = snapshot.status
                if (
                    queuedMessageRefs
                    && !areNativeQueueRefsCurrent(current.status.queuedMessages ?? [], queuedMessageRefs)
                ) {
                    requiresStatusRefresh = true
                }
                const nextStatus: Extract<CodexLocalSessionStatusResponse, { success: true }> = {
                    ...realtimeStatus,
                    ...(current.status.queuedMessages === undefined
                        ? {}
                        : { queuedMessages: current.status.queuedMessages })
                }

                if (current.version?.runnerEpoch === snapshot.version.runnerEpoch) {
                    if (current.version.revision > snapshot.version.revision) {
                        covered = true
                        return current
                    }
                    if (current.version.revision === snapshot.version.revision) {
                        covered = true
                        applied = true
                        return {
                            ...current,
                            status: nextStatus,
                            version: snapshot.version,
                            revision: snapshot.revision,
                            timing: snapshot.timing
                        }
                    }
                }

                // A newer/different runner version has no transcript body in
                // the global SSE event. Show its status immediately but keep
                // the old page/version so the coordinator cannot mistake it
                // for a complete snapshot.
                applied = true
                return {
                    ...current,
                    status: nextStatus,
                    timing: snapshot.timing
                }
            }
        )
        if (applied) {
            nativeApplySequenceRef.current += 1
        }
        setConnectionNow(Date.now())
        return { covered, requiresStatusRefresh, version: snapshot.version }
    }, [nativeSnapshotQueryKey, queryClient])

    useEffect(() => {
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => (
                queryClient.getQueryData<CodexLocalSessionSnapshotResponse>(nativeSnapshotQueryKey)?.version ?? null
            ),
            isVisible: () => document.visibilityState === 'visible',
            refresh: async () => {
                const result = await refetchNativeSnapshotRef.current()
                if (result.error) throw result.error
            }
        })
        snapshotRefreshCoordinatorRef.current = coordinator
        return () => {
            coordinator.dispose()
            if (snapshotRefreshCoordinatorRef.current === coordinator) {
                snapshotRefreshCoordinatorRef.current = null
            }
        }
    }, [nativeSnapshotQueryKey, pageScope, queryClient])

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

    // Mobile browsers often emit focus, pageshow, online and visibility in one
    // foreground episode. Feed all of them to one coordinator so the episode
    // performs one conditional read instead of four full snapshots.
    const refreshNativeDataOnForeground = useCallback(() => {
        if (document.visibilityState !== 'visible') return
        const now = Date.now()
        setConnectionNow(now)
        snapshotRefreshCoordinatorRef.current?.request({
            authoritative: true,
            delayMs: 250
        })
    }, [])

    useEffect(() => {
        if (!hasRealtimeUpdates || !props.machineId) {
            return
        }

        // Reconcile once after the stream's short replay grace. This remains
        // necessary because the Hub event history is bounded and does not yet
        // report a replay gap explicitly.
        snapshotRefreshCoordinatorRef.current?.request({
            authoritative: true,
            delayMs: 250
        })
        return subscribeNativeCodexSessionUpdated((event) => {
            if (event.machineId !== props.machineId || event.codexSessionId !== props.sessionId) {
                return
            }
            const applied = applyNativeRealtimeSnapshot(event)
            if (!applied) {
                snapshotRefreshCoordinatorRef.current?.request({
                    authoritative: true,
                    delayMs: 250
                })
            } else if (applied.requiresStatusRefresh) {
                snapshotRefreshCoordinatorRef.current?.request({
                    authoritative: true,
                    ...(!applied.covered ? { requiredVersion: applied.version } : {}),
                    delayMs: 250
                })
            } else if (!applied.covered) {
                snapshotRefreshCoordinatorRef.current?.request({
                    requiredVersion: applied.version,
                    delayMs: 250
                })
            }
        })
    }, [
        applyNativeRealtimeSnapshot,
        hasRealtimeUpdates,
        props.machineId,
        props.sessionId
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
    const nativeConnectionContext = useMemo(() => ({
        health: nativeConnectionHealth,
        recover: recoverNativeConnection,
        lastUpdatedAt: contextQuery.dataUpdatedAt || null
    }), [contextQuery.dataUpdatedAt, nativeConnectionHealth, recoverNativeConnection])
    const hasNativeQueuedMessages = nativeQueuedMessages.length > 0
    const isSendingDirect = pendingDirectSendCount > 0
    const nativeNeedsManualRecovery = nativeRecoveryCandidate.candidate !== null
        && (nativeStalledSince !== null || nativeRecoveryCandidate.uncertain)
    const canRecoverNativeDelivery = nativeRecoveryCandidate.candidate !== null
        && !sshControlled
        && (directStatus === 'idle' || nativeStalledSince !== null)
    const directSendPhase = getNativeCodexDirectSendPhase({
        pendingDirectSendCount,
        queuedMessages: nativeQueuedMessages,
        directMessageEchoes: visibleNativeDirectMessageEchoes,
        runState: directStatus,
        progress: statusQuery.data?.success === true ? statusQuery.data.progress ?? null : null,
        hasAgentReply: hasNativeCodexAgentReply(messages)
    })
    const directSendPhaseStartedAt = getNativeCodexDirectSendPhaseStartedAt({
        phase: directSendPhase,
        progress: statusQuery.data?.success === true ? statusQuery.data.progress ?? null : null,
        directMessageEchoes: visibleNativeDirectMessageEchoes
    })
    const directSendPhaseElapsedSeconds = directSendPhaseStartedAt === null
        ? null
        : Math.max(0, Math.floor((connectionNow - directSendPhaseStartedAt) / 1_000))
    const isNativeProcessing = isSendingDirect
        || directStatus === 'processing'
        || (directSendPhase !== null && directSendPhase !== 'queued')
    // A runner can briefly report idle between the native turn ending and the
    // queue pump starting its next child. Treat that window as non-idle so
    // Fork cannot race a prompt that is already waiting for delivery.
    const isNativeQueueWaiting = hasNativeQueuedMessages && directStatus === 'idle'
    const isNativeIdle = !isSendingDirect && directStatus === 'idle' && !hasNativeQueuedMessages
    const canFork = Boolean(props.machineId) && !isForking && isNativeIdle
    const composerDisabled = sshControlled
        || !props.machineId
        || statusQuery.isLoading
        || statusQuery.isError
        || directStatus === null
        || directStatus === 'unknown'
    const composerNotice = sshControlled
        ? t('recentCodex.sshControl.detail')
        : nativeWaitingForUserInput
        ? t('recentCodex.status.waitingForLocalInput')
        : isNativeProcessing
        ? nativeNeedsManualRecovery
            ? getNativeRecoveryDetail(
                nativeRecoveryCandidate.reason,
                nativeRecoveryCandidate.uncertain,
                t
            )
            : t('recentCodex.direct.processing')
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
    const externalWriterActive = sshControlled
    const visibleRunnerError = directStatusError === dismissedRunnerError ? null : directStatusError
    const composerSendError = directSendError ?? (!externalWriterActive && visibleRunnerError
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
            : nativeWaitingForUserInput
                ? 'bg-[#FF9500] animate-pulse'
            : nativeNeedsManualRecovery
                ? 'bg-[#FF9500] animate-pulse'
            : isNativeProcessing
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

    const recoverNativeDelivery = useCallback(async () => {
        const candidate = nativeRecoveryCandidate.candidate
        if (!props.machineId || !candidate || !canRecoverNativeDelivery || isRecoveringNativeDelivery || sshControlled) {
            return
        }

        const requestScope = pageScope
        const requestNativeDirectMessageScope = nativeDirectMessageScope
        const phaseStartedAt = Date.now()
        const requestToken = nativeRecoveryRequestTokenRef.current + 1
        const abortController = new AbortController()
        nativeRecoveryRequestTokenRef.current = requestToken
        nativeRecoveryAbortControllerRef.current = abortController
        // A manual recovery must never be followed by an implicit browser
        // re-submit. If it is cancelled, leave the durable receipt for a
        // deliberate retry once the runner state has been refreshed.
        attemptedNativeDirectMessageIdsRef.current.add(candidate.id)
        setIsRecoveringNativeDelivery(true)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
            message.id === candidate.id
                ? {
                    ...message,
                    status: 'sending' as const,
                    deliveryPhase: 'launching' as const,
                    phaseStartedAt,
                    queueId: null
                }
                : message
        )))

        try {
            const response = await props.api.sendCodexSessionMessage(props.sessionId, {
                machineId: props.machineId,
                message: candidate.deliveryText,
                ...(candidate.deliveryText === candidate.text ? {} : { displayMessage: candidate.text }),
                clientMessageId: candidate.id,
                forceRecovery: true
            }, { signal: abortController.signal })
            if (
                abortController.signal.aborted
                || nativeRecoveryRequestTokenRef.current !== requestToken
            ) {
                return
            }
            if (response.success !== true) {
                throw new ApiError(response.error, 409, response.code)
            }
            updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                message.id !== candidate.id
                    ? message
                    : {
                        ...message,
                        status: 'queued' as const,
                        deliveryPhase: response.status === 'queued'
                            ? 'queued' as const
                            : response.progress?.phase ?? 'matching' as const,
                        phaseStartedAt: response.status === 'queued'
                            ? Date.now()
                            : response.progress?.phaseStartedAt ?? Date.now(),
                        queueId: response.queueId ?? null
                    }
            )))
            if (pageScopeRef.current !== requestScope) {
                return
            }
            if (Array.isArray(response.queuedMessages)) {
                setNativeQueuedMessages(response.queuedMessages)
            } else if (response.status === 'processing') {
                setNativeQueuedMessages((messages) => messages.filter((message) => message.id !== candidate.id))
            }
            void refetchNativeSnapshot()
        } catch (error) {
            if (
                abortController.signal.aborted
                || nativeRecoveryRequestTokenRef.current !== requestToken
            ) {
                return
            }
            updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                message.id === candidate.id ? { ...message, status: 'failed' as const } : message
            )))
            if (pageScopeRef.current === requestScope) {
                setDirectSendError({
                    id: Date.now(),
                    text: candidate.text,
                    message: formatDirectSendError(error, t),
                    scheduledAt: null
                })
            }
        } finally {
            if (nativeRecoveryAbortControllerRef.current === abortController) {
                nativeRecoveryAbortControllerRef.current = null
            }
            if (
                pageScopeRef.current === requestScope
                && nativeRecoveryRequestTokenRef.current === requestToken
            ) {
                setIsRecoveringNativeDelivery(false)
            }
        }
    }, [
        canRecoverNativeDelivery,
        isRecoveringNativeDelivery,
        nativeDirectMessageScope,
        nativeRecoveryCandidate.candidate,
        pageScope,
        props.api,
        props.machineId,
        props.sessionId,
        refetchNativeSnapshot,
        sshControlled,
        t,
        updateNativeDirectMessageEchoes
    ])

    const discardNativeRecovery = useCallback(async () => {
        const candidate = nativeRecoveryCandidate.candidate
        if (!props.machineId || !candidate || isDiscardingNativeRecovery) {
            return
        }

        const requestScope = pageScope
        const requestNativeDirectMessageScope = nativeDirectMessageScope
        // A retry still waiting on HTTP must not win the race and put this
        // receipt back after the person explicitly abandons it.
        nativeRecoveryRequestTokenRef.current += 1
        const recoveryAbortController = nativeRecoveryAbortControllerRef.current
        nativeRecoveryAbortControllerRef.current = null
        recoveryAbortController?.abort()
        setIsRecoveringNativeDelivery(false)
        setIsDiscardingNativeRecovery(true)
        setDirectSendError(null)

        try {
            const response = await props.api.discardCodexSessionMessage(props.sessionId, {
                machineId: props.machineId,
                clientMessageId: candidate.id
            })
            if (response.success !== true) {
                throw new ApiError(response.error, 409, response.code)
            }
            updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => (
                current.filter((message) => message.id !== candidate.id)
            ))
            if (pageScopeRef.current !== requestScope) {
                return
            }
            setNativeQueuedMessages(response.queuedMessages)
            if (directStatusError) {
                setDismissedRunnerError(directStatusError)
            }
            void refetchNativeSnapshot()
        } catch (error) {
            if (pageScopeRef.current === requestScope) {
                setDirectSendError({
                    id: Date.now(),
                    text: candidate.text,
                    message: formatDirectSendError(error, t),
                    scheduledAt: null
                })
            }
        } finally {
            if (pageScopeRef.current === requestScope) {
                setIsDiscardingNativeRecovery(false)
            }
        }
    }, [
        directStatusError,
        isDiscardingNativeRecovery,
        nativeDirectMessageScope,
        nativeRecoveryCandidate.candidate,
        pageScope,
        props.api,
        props.machineId,
        props.sessionId,
        refetchNativeSnapshot,
        t,
        updateNativeDirectMessageEchoes
    ])

    const sendDirectMessage = useCallback((text: string) => {
        if (!props.machineId || sshControlled || directStatus === null || directStatus === 'unknown') {
            return
        }
        const deliveryText = expandCodexCustomPrompt(text, nativeComposerCapabilities.commands) ?? text
        const requestScope = pageScope
        const requestNativeDirectMessageScope = nativeDirectMessageScope
        const echoId = makeClientSideId('native')
        const createdAt = Date.now()
        const echo: NativeDirectMessageEcho = {
            id: echoId,
            text,
            ...(deliveryText !== text ? { deliveryText } : {}),
            createdAt,
            status: 'sending',
            deliveryPhase: 'launching',
            phaseStartedAt: createdAt,
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
        attemptedNativeDirectMessageIdsRef.current.add(echoId)
        setPendingDirectSendCount((count) => count + 1)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        void (async () => {
            try {
                const response = await props.api.sendCodexSessionMessage(props.sessionId, {
                    machineId: props.machineId!,
                    message: deliveryText,
                    ...(deliveryText === text ? {} : { displayMessage: text }),
                    clientMessageId: echoId
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
                            deliveryPhase: response.status === 'queued'
                                ? 'queued' as const
                                : response.progress?.phase ?? 'matching' as const,
                            phaseStartedAt: response.status === 'queued'
                                ? Date.now()
                                : response.progress?.phaseStartedAt ?? Date.now(),
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
                const needsVerification = shouldVerifyDirectSendReceipt(error)
                const rejectedByExternalWriter = error instanceof ApiError
                    && error.code === 'external_writer_active'
                // A transport timeout is not proof that Codex rejected the
                // prompt. Retain a pending receipt while the status stream
                // checks it, then expose explicit recovery rather than
                // creating a second prompt with a new client id.
                updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => (
                    rejectedByExternalWriter
                        ? current.filter((message) => message.id !== echoId)
                        : current.map((message) => (
                            message.id !== echoId
                                ? message
                                : needsVerification
                                    ? {
                                        ...message,
                                        status: 'sending' as const,
                                        deliveryPhase: 'matching' as const,
                                        phaseStartedAt: Date.now()
                                    }
                                    : { ...message, status: 'failed' as const }
                        ))
                ))
                if (pageScopeRef.current !== requestScope) {
                    return
                }
                if (!rejectedByExternalWriter) {
                    setDirectSendError({
                        id: Date.now(),
                        text,
                        message: formatDirectSendError(error, t),
                        scheduledAt: null
                    })
                }
                if (needsVerification || rejectedByExternalWriter) {
                    void refetchNativeSnapshot()
                }
            } finally {
                if (pageScopeRef.current === requestScope) {
                    setPendingDirectSendCount((count) => Math.max(0, count - 1))
                }
            }
        })()
    }, [
        directStatus,
        messages,
        nativeComposerCapabilities.commands,
        nativeDirectMessageScope,
        pageScope,
        props.api,
        props.machineId,
        props.sessionId,
        refetchNativeSnapshot,
        sshControlled,
        t,
        updateNativeDirectMessageEchoes
    ])

    // A very recent navigation can interrupt the HTTP response after the
    // browser created its receipt. Re-submit only that short window. Older
    // receipts need an explicit recovery action: after a runner restart the
    // former in-memory dedupe is gone, so silent retry could duplicate work.
    useEffect(() => {
        if (!props.machineId || sshControlled || directStatus === null || directStatus === 'unknown' || nativeStalledSince !== null) {
            return
        }

        const retryable = currentNativeDirectMessageEchoes.filter((echo) => (
            echo.status === 'sending'
            && Date.now() - echo.createdAt < NATIVE_UNCONFIRMED_RECEIPT_GRACE_MS
            && !attemptedNativeDirectMessageIdsRef.current.has(echo.id)
        ))
        for (const echo of retryable) {
            attemptedNativeDirectMessageIdsRef.current.add(echo.id)
            const requestScope = pageScope
            const requestNativeDirectMessageScope = nativeDirectMessageScope
            const deliveryText = echo.deliveryText ?? echo.text
            void (async () => {
                try {
                    const response = await props.api.sendCodexSessionMessage(props.sessionId, {
                        machineId: props.machineId!,
                        message: deliveryText,
                        ...(deliveryText === echo.text ? {} : { displayMessage: echo.text }),
                        clientMessageId: echo.id
                    })
                    if (response.success !== true) {
                        throw new ApiError(response.error, 409, response.code)
                    }
                    updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                        message.id !== echo.id
                            ? message
                            : {
                                ...message,
                                status: 'queued' as const,
                                deliveryPhase: response.status === 'queued'
                                    ? 'queued' as const
                                    : response.progress?.phase ?? 'matching' as const,
                                phaseStartedAt: response.status === 'queued'
                                    ? Date.now()
                                    : response.progress?.phaseStartedAt ?? Date.now(),
                                queueId: response.queueId ?? null
                            }
                    )))
                    if (pageScopeRef.current !== requestScope || !nativeDirectMessagePageMountedRef.current) {
                        return
                    }
                    if (Array.isArray(response.queuedMessages) && response.queuedMessages.length > 0) {
                        setNativeQueuedMessages(response.queuedMessages)
                    } else if (response.status === 'queued' && response.queueId && response.queuedAt !== undefined) {
                        setNativeQueuedMessages((messages) => [
                            ...messages,
                            { id: response.queueId!, text: echo.text, queuedAt: response.queuedAt! }
                        ])
                    }
                    void refetchNativeSnapshot()
                } catch (error) {
                    updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                        message.id === echo.id ? { ...message, status: 'failed' as const } : message
                    )))
                    if (pageScopeRef.current === requestScope && nativeDirectMessagePageMountedRef.current) {
                        setDirectSendError({
                            id: Date.now(),
                            text: echo.text,
                            message: formatDirectSendError(error, t),
                            scheduledAt: null
                        })
                    }
                }
            })()
        }
    }, [
        currentNativeDirectMessageEchoes,
        directStatus,
        nativeStalledSince,
        nativeDirectMessageScope,
        pageScope,
        props.api,
        props.machineId,
        props.sessionId,
        refetchNativeSnapshot,
        sshControlled,
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
                                onClick={handleMenuToggle}
                                onPointerDown={(event) => event.stopPropagation()}
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
                                    className={`h-5 w-5 ${sshControlled ? 'text-[#F5A524]' : ''}`}
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
                            projectPath={context.session.cwd}
                            machineId={props.machineId}
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
                            runState={directStatus}
                            activeTurnId={statusQuery.data?.success === true
                                ? statusQuery.data.activeTurnId ?? null
                                : null}
                            plan={context?.plan ?? null}
                            queuedMessages={nativeQueuedMessages}
                            composerDisabled={composerDisabled}
                            composerLocked={sshControlled}
                            composerNotice={composerNotice}
                            sendError={composerSendError}
                            autocompleteSuggestions={nativeComposerCapabilities.getSuggestions}
                            skills={nativeComposerCapabilities.skills}
                            skillsLoading={nativeComposerCapabilities.isLoading}
                            skillsError={nativeComposerCapabilities.error}
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
                ) : sshControlled ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="warning"
                            title={legacyExternalWriterActive
                                ? t('recentCodex.direct.externalWriter.title')
                                : t('recentCodex.sshControl.title')}
                            detail={legacyExternalWriterActive
                                ? t('recentCodex.direct.externalWriter.detail')
                                : t('recentCodex.sshControl.detail')}
                            testId={legacyExternalWriterActive
                                ? 'codex-native-external-writer'
                                : 'codex-native-ssh-controlled'}
                        />
                    </div>
                ) : nativeWaitingForUserInput ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="warning"
                            title={t('recentCodex.status.waitingForLocalInput')}
                            detail={t('recentCodex.status.waitingForLocalInput.detail')}
                            testId="codex-native-waiting-for-local-input"
                        />
                    </div>
                ) : nativeNeedsManualRecovery ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="warning"
                            title={t('recentCodex.direct.recovery.title')}
                            detail={getNativeRecoveryDetail(
                                nativeRecoveryCandidate.reason,
                                nativeRecoveryCandidate.uncertain,
                                t
                            )}
                            action={canRecoverNativeDelivery ? {
                                label: isRecoveringNativeDelivery
                                    ? t('recentCodex.direct.recovery.pending')
                                    : getNativeRecoveryActionLabel(nativeRecoveryCandidate.reason, t),
                                onClick: () => void recoverNativeDelivery(),
                                busy: isRecoveringNativeDelivery,
                                disabled: isDiscardingNativeRecovery
                            } : undefined}
                            secondaryAction={nativeRecoveryCandidate.candidate ? {
                                label: isDiscardingNativeRecovery
                                    ? t('recentCodex.direct.recovery.discarding')
                                    : t('recentCodex.direct.recovery.discard'),
                                onClick: () => void discardNativeRecovery(),
                                busy: isDiscardingNativeRecovery
                            } : undefined}
                            testId="codex-native-recovery"
                        />
                    </div>
                ) : directSendPhase ? (
                    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.5rem)] z-30 px-3">
                        <SessionDetailStatusNotice
                            tone="processing"
                            title={t(`recentCodex.direct.phase.${directSendPhase}.title`)}
                            detail={[
                                t(`recentCodex.direct.phase.${directSendPhase}.detail`),
                                directSendPhaseElapsedSeconds === null
                                    ? null
                                    : t('recentCodex.direct.phase.elapsed', { seconds: directSendPhaseElapsedSeconds })
                            ].filter(Boolean).join(' · ')}
                            testId={`codex-direct-send-phase-${directSendPhase}`}
                            leadingVisual={<NativeCodexDirectSendPhaseIcon phase={directSendPhase} />}
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
