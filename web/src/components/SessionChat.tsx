import { ChatPreviewProvider, useChatPreview } from '@/components/ChatPreviewContext'
import { ThreadThinkingMessage } from '@/components/ThreadThinkingMessage'
import { getThinkingStartedAt } from '@/lib/thinking-started-at'
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AssistantRuntimeProvider, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import { toSessionSummary } from '@hapi/protocol'
import { DragDropZone } from '@/components/AssistantChat/DragDropZone'
import { ApiError, type ApiClient } from '@/api/client'
import type {
    AttachmentMetadata,
    CodexCollaborationMode,
    DecryptedMessage,
    PermissionMode,
    Session,
    SessionsResponse,
    PiModelSummary,
    SlashCommand,
    SkillSummary
} from '@/types/api'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { getPendingCodexQuickReplyPrompt } from '@/chat/codexQuickReply'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildConversationOutline } from '@/chat/outline'
import { isToolGroupBlock, type ToolGroupBlock } from '@/chat/toolGroups'
import {
    buildIncrementalSessionDetailTimeline,
    hasCurrentTurnProcess,
    type SessionDetailTimelineCache
} from '@/chat/sessionDetailTimeline'
import { isQueuedForInvocation, mergeMessages } from '@/lib/messages'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { codexModelAdvertisesFastTier } from '@/components/AssistantChat/codexFastMode'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { resolvePendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { QueuedMessagesBar, useQueuedMessages } from '@/components/AssistantChat/QueuedMessagesBar'
import { ScratchlistDrawer } from '@/components/AssistantChat/ScratchlistPanel'
import { GitDiffSummary, summarizeGitStatusFiles } from '@/components/AssistantChat/GitDiffSummary'
import {
    PlanStatusSummary,
    extractLatestPlanStatus,
    getRunScopedPlanStatus,
    hasActiveToolBlock,
    removeChatBlockById
} from '@/components/AssistantChat/PlanStatusSummary'
import { useScratchlist } from '@/lib/use-scratchlist'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createAttachmentAdapter } from '@/lib/attachmentAdapter'
import { consumeSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer, getShareTransfer } from '@/lib/shareTransfer'
import { getDraft } from '@/lib/composer-drafts'
import { enqueueQueuedMessageEdit } from '@/lib/queued-message-edits'
import { useTranslation } from '@/lib/use-translation'
import {
    SessionConnectionRecoveryControl,
    SessionHeader,
    type SessionHeaderStatus
} from '@/components/SessionHeader'
import { SESSION_DETAIL_HEADER_HEIGHT_PX } from '@/components/SessionDetailHeader'
import {
    CursorMigrationBanner,
    isCursorMigrationAmbiguous,
    isCursorMigrationInProgress
} from '@/components/CursorMigrationBanner'
import { TeamPanel } from '@/components/TeamPanel'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useCursorModels } from '@/hooks/queries/useCursorModels'
import { useCursorModelsForMachine } from '@/hooks/queries/useCursorModelsForMachine'
import {
    mergeCursorCliModelSkus,
    resolveCursorBaseFromWire
} from '@/lib/cursorPickerState'
import {
    buildSessionCursorPickerState,
    isSessionCursorCatalogAwaitingSkus,
    isSessionCursorCatalogPendingWithTimeout,
    SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS,
    resolveSessionCursorBaseSelectValue,
    resolveSessionCursorModelChange,
    resolveSessionCursorVariantSelectValue
} from '@/lib/sessionChatCursorModel'
import { buildCursorEffortPickerOptions, resolveCursorVariantOptions } from '@/lib/cursorModelOptions'
import { useOpencodeModels } from '@/hooks/queries/useOpencodeModels'
import { usePiModels } from '@/hooks/queries/usePiModels'
import { useOpencodeReasoningEffortOptions } from '@/hooks/queries/useOpencodeReasoningEffortOptions'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { useSessions } from '@/hooks/queries/useSessions'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useVoiceOptional } from '@/lib/voice-context'
import { registerSessionStore } from '@/realtime/realtimeClientTools'
import { registerVoiceHooksStore, voiceHooks } from '@/realtime/hooks/voiceHooks'
import { isRemoteTerminalSupported } from '@/utils/terminalSupport'
import { ArrowRightIcon } from '@/components/icons'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'
import { SessionDetailContent, SessionDetailSurface } from '@/components/SessionDetailSurface'
import { SessionDetailStatusNotice } from '@/components/SessionDetailStatusNotice'
import {
    SessionDetailBottomDock,
    SessionDetailBottomDockComposer
} from '@/components/SessionDetailBottomDock'

const LazyVoiceBackendSession = lazy(() => import('@/realtime/VoiceBackendSession').then((module) => ({
    default: module.VoiceBackendSession
})))

const RUN_SETTLE_DELAY_MS = 1500
const RUN_ACTIVITY_KEY_LOOKBACK = 12
const CODEX_QUICK_REPLY_CONTINUE_TEXT = '继续'
const THREAD_WORK_BUDGET_MS = 12
const THREAD_WORK_METRICS_INTERVAL_MS = 1_000
const HAPI_THREAD_WORK_EVENT = 'hapi:thread-work'
type ThreadWorkStage = 'normalize' | 'reduce' | 'timeline'
type ThreadWorkMetrics = {
    sampleCount: number
    totalMs: number
    maxMs: number
    lastReportAt: number
}
const threadWorkLastWarningAt = new Map<ThreadWorkStage, number>()
const threadWorkMetrics = new Map<ThreadWorkStage, ThreadWorkMetrics>()
export const BOTTOM_FLOATING_CONTROL_GAP_PX = 8
export const BOTTOM_OVERLAY_INSET_PX = 0
// Keep the chat's scroll reservation aligned with every session title bar.
// The device safe area is added independently by HappyThread.
export const FLOATING_SESSION_HEADER_HEIGHT_PX = SESSION_DETAIL_HEADER_HEIGHT_PX

function measureThreadWork<T>(
    sessionId: string,
    stage: ThreadWorkStage,
    messagesVersion: number,
    work: () => T
): T {
    if (!import.meta.env.DEV || typeof performance === 'undefined') {
        return work()
    }

    const startedAt = performance.now()
    const result = work()
    const elapsedMs = performance.now() - startedAt
    const now = Date.now()
    const metrics = threadWorkMetrics.get(stage) ?? {
        sampleCount: 0,
        totalMs: 0,
        maxMs: 0,
        lastReportAt: now
    }
    metrics.sampleCount += 1
    metrics.totalMs += elapsedMs
    metrics.maxMs = Math.max(metrics.maxMs, elapsedMs)
    threadWorkMetrics.set(stage, metrics)

    // DevTools can listen for `hapi:thread-work` and see one compact sample
    // per second instead of a console line for every streaming token.
    if (
        now - metrics.lastReportAt >= THREAD_WORK_METRICS_INTERVAL_MS
        && typeof window !== 'undefined'
        && typeof CustomEvent === 'function'
    ) {
        window.dispatchEvent(new CustomEvent(HAPI_THREAD_WORK_EVENT, {
            detail: {
                sessionId,
                stage,
                messagesVersion,
                samples: metrics.sampleCount,
                averageMs: Number((metrics.totalMs / metrics.sampleCount).toFixed(1)),
                maxMs: Number(metrics.maxMs.toFixed(1))
            }
        }))
        metrics.sampleCount = 0
        metrics.totalMs = 0
        metrics.maxMs = 0
        metrics.lastReportAt = now
    }

    if (elapsedMs < THREAD_WORK_BUDGET_MS) {
        return result
    }

    // A continuous stream can run this path every frame. Keep development
    // diagnostics actionable without flooding the console.
    const lastWarningAt = threadWorkLastWarningAt.get(stage) ?? 0
    if (now - lastWarningAt >= 1_000) {
        threadWorkLastWarningAt.set(stage, now)
        console.warn(`[SessionChat] ${stage} exceeded ${THREAD_WORK_BUDGET_MS}ms`, {
            elapsedMs: Number(elapsedMs.toFixed(1)),
            messagesVersion,
            sessionId,
        })
    }
    return result
}

/**
 * The plan/git pill floats above the stable bottom overlay. When it is visible,
 * align the scroll controls with that pill; otherwise align them with the
 * composer as usual.
 */
export function getScrollButtonBottomInset(
    composerOverlayHeight: number,
    bottomOverlayHeight: number,
    bottomOverlayInset: number = 0,
    bottomAccessoryVisible = false,
): number {
    if (bottomAccessoryVisible) {
        return bottomOverlayHeight + bottomOverlayInset + BOTTOM_FLOATING_CONTROL_GAP_PX
    }

    return composerOverlayHeight > 0
        ? composerOverlayHeight + bottomOverlayInset + BOTTOM_FLOATING_CONTROL_GAP_PX
        : bottomOverlayHeight + bottomOverlayInset
}

/**
 * The status pill is visually above the bottom overlay, but must still be
 * reserved by the message thread. It must never change the composer's anchor.
 */
export function getBottomOverlayThreadInset(
    bottomOverlayHeight: number,
    bottomAccessoryHeight: number,
    bottomAccessoryVisible: boolean,
): number {
    return bottomOverlayHeight + (bottomAccessoryVisible
        ? bottomAccessoryHeight + BOTTOM_FLOATING_CONTROL_GAP_PX
        : 0)
}

export function canCreateSideSessionFromSession(params: {
    agentFlavor: string | null | undefined
    active: boolean
    controlledByUser: boolean
    isSideSession: boolean
}): boolean {
    return params.agentFlavor === 'codex'
        && params.active
        && !params.controlledByUser
        && !params.isSideSession
}

/**
 * Returns whether a PendingSchedule should trigger an auto-clear timer.
 *
 * Only 'absolute' schedules expire (the chosen instant passes).
 * 'preset' schedules are relative to send time and have no fixed expiry.
 *
 * Used both by the auto-clear useEffect and by unit tests, so a future
 * variant of PendingSchedule only needs to update this single helper.
 */
export function shouldAutoClearPendingSchedule(pending: PendingSchedule | null): boolean {
    return pending !== null && pending.type === 'absolute'
}

/**
 * True if the keystroke matches the scratchlist-mode toggle shortcut
 * (Ctrl/Cmd + Shift + S, no Alt). Pure / exported for unit tests.
 *
 * Convention: matches the v1 always-visible panel's shortcut so muscle
 * memory carries over. Sibling globals follow the same modifier shape
 * (Ctrl/Cmd-m cycles agent model in HappyComposer).
 */
export function isScratchlistToggleHotkey(e: {
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    key: string
}): boolean {
    if (!(e.metaKey || e.ctrlKey)) return false
    if (!e.shiftKey) return false
    if (e.altKey) return false
    return e.key === 'S' || e.key === 's'
}

/**
 * True when the global scratchlist hotkey should be SKIPPED for the
 * given event target. Window-level shortcuts that fire regardless of
 * focus can quietly toggle modes "behind" modal dialogs (rename,
 * schedule picker, FUE callout) and that's the kind of UX bug the bot
 * caught on PR #798.
 *
 * Block targets:
 *   - any descendant of an open dialog (Radix UI's DialogContent renders
 *     role="dialog", as do FueCallout / ScheduleTimePicker / ImagePreview)
 *   - HTMLInputElement (single-line inputs)
 *   - HTMLSelectElement
 *   - any contentEditable host
 *
 * NOT blocked:
 *   - HTMLTextAreaElement (the composer textarea is the normal focus
 *     target when the operator presses the hotkey - blocking it would
 *     defeat the shortcut)
 *   - the document body / unfocused targets
 *
 * Pure / exported for unit tests.
 */
export function isScratchlistHotkeyBlockedTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.closest('[role="dialog"]') !== null) return true
    if (target instanceof HTMLInputElement) return true
    if (target instanceof HTMLSelectElement) return true
    // isContentEditable is the authoritative check in real browsers but
    // jsdom doesn't implement it; the attribute fallback covers both.
    if (target.isContentEditable === true) return true
    return target.getAttribute('contenteditable') === 'true'
}

/**
 * Decide whether a submit should be routed to the per-session scratchlist
 * or to the regular chat send. Scratchlist entries are pure text - they
 * don't carry attachments or schedules - so any submit that includes
 * either of those MUST fall through to the normal chat path even if the
 * scratchlist toggle is on. Otherwise the wrapper would silently drop
 * attachments / scheduled-send metadata while telling the composer the
 * submission succeeded (which then clears the composer state, losing
 * the user's data).
 *
 * Per upstream review on PR #798 (github-actions[bot] [Major]).
 *
 * Pure / exported so it can be unit tested without mounting SessionChat.
 */
export function shouldRouteToScratchlist(
    scratchlistMode: boolean,
    attachments: AttachmentMetadata[] | undefined,
    scheduledAt: number | null | undefined,
): boolean {
    if (!scratchlistMode) return false
    if (attachments && attachments.length > 0) return false
    if (scheduledAt != null) return false
    return true
}

function isUninvokedScheduledMessage(message: DecryptedMessage): boolean {
    return message.invokedAt == null && message.scheduledAt != null
}

function getApiErrorPayloadMessage(error: unknown): string | null {
    if (!(error instanceof ApiError) || !error.body) {
        return null
    }
    try {
        const payload = JSON.parse(error.body) as { error?: unknown }
        return typeof payload.error === 'string' && payload.error.trim().length > 0
            ? payload.error
            : null
    } catch {
        return null
    }
}

/**
 * Consumes a pending Web Share Target transfer once the assistant runtime
 * is mounted and the session is active enough to accept attachments.
 *
 * Lifecycle:
 *  - A mount effect reads the transfer id out of sessionStorage *once*
 *    via consumeSharePendingTransfer() (not during render — StrictMode
 *    would consume on the discarded pass). The id is stashed in a ref.
 *  - The actual seed (composer.setText + composer.addAttachment per file)
 *    runs once `props.sessionActive` is true. Inactive sessions disable
 *    the attachmentAdapter, so writing attachments while inactive would
 *    no-op and leak Blobs in IDB. The seed waits in a re-renderable
 *    effect for the active flip.
 *  - `consumedRef` gates the effect to a single seed per component
 *    instance — refs survive a StrictMode mount/cleanup/remount pair, so
 *    the second invoke early-returns and the first invoke's async chain
 *    completes naturally (we deliberately don't cancel on cleanup; the
 *    upload is idempotent and the only side effects on the composer are
 *    no-ops once the runtime is unmounted).
 *  - The IDB row is deleted after the seed completes so a back-button
 *    refresh of /sessions/:id doesn't re-attach the same payload.
 */
function ShareSeedConsumer(props: { sessionId: string; sessionActive: boolean }) {
    const assistantApi = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const composerTextRef = useRef(composerText)
    const initRef = useRef(false)
    const transferIdRef = useRef<string | null>(null)
    const consumedRef = useRef(false)
    const [transferReady, setTransferReady] = useState(false)

    useEffect(() => {
        composerTextRef.current = composerText
    }, [composerText])

    // Consume in an effect, not during render — React.StrictMode double-
    // invokes render functions in dev; a render-time consume deletes the
    // sessionStorage key on the discarded pass and the committed render
    // then sees no transfer.
    useEffect(() => {
        if (initRef.current) return
        initRef.current = true
        transferIdRef.current = consumeSharePendingTransfer()
        setTransferReady(true)
    }, [])

    useEffect(() => {
        if (!transferReady) return
        if (consumedRef.current) return
        const transferId = transferIdRef.current
        if (!transferId) return
        if (!props.sessionActive) return
        consumedRef.current = true

        void (async () => {
            try {
                const payload = await getShareTransfer(transferId)
                if (!payload) return
                const seedText = [payload.title, payload.text, payload.url]
                    .filter((part) => typeof part === 'string' && part.length > 0)
                    .join('\n')
                    .trim()
                if (seedText.length > 0) {
                    const existingText = composerTextRef.current.trim().length > 0
                        ? composerTextRef.current
                        : getDraft(props.sessionId)
                    const nextText = [existingText.trim(), seedText]
                        .filter((part) => part.length > 0)
                        .join('\n\n')
                    if (nextText.length > 0) {
                        assistantApi.composer().setText(nextText)
                    }
                }
                for (const file of payload.files) {
                    const reconstructed = new File([file.blob], file.name, { type: file.type })
                    try {
                        await assistantApi.composer().addAttachment(reconstructed)
                    } catch (err) {
                        console.error('share-seed addAttachment failed', err)
                    }
                }
                await deleteShareTransfer(transferId).catch(() => {})
            } catch (err) {
                console.error('share-seed pull failed', err)
            }
        })()
    }, [transferReady, props.sessionActive, props.sessionId, assistantApi])

    return null
}

/**
 * Mounts the per-session scratchlist DRAWER (composer-controlled).
 *
 * The drawer renders only when the operator toggles into "scratchlist
 * mode" via the notepad icon in the composer toolbar. While in that mode:
 * - drawer (this component) is visible above the composer
 * - composer's send button repaints amber (handled in ComposerButtons)
 * - SessionChat's wrapped onSend routes adds into the scratchlist
 *
 * Entries state is owned by SessionChat's useScratchlist() so the
 * composer-toolbar counter and the drawer share one source of truth.
 */
export function ScratchlistDrawerHost(props: {
    entries: ReturnType<typeof useScratchlist>['entries']
    onMove: ReturnType<typeof useScratchlist>['move']
    onDelete: ReturnType<typeof useScratchlist>['remove']
    onSend: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    /**
     * Called when the operator promotes an entry to the composer.
     *
     * Promoting means "I want to send this for real now" - so the host
     * MUST exit scratchlist mode, otherwise the next composer submit
     * routes back to scratchlist (per the v1.1 modal-mode contract) and
     * the user re-adds the same text instead of sending it to chat.
     * Per upstream review on PR #798 (HAPI Bot, v6 follow-up).
     */
    onExitScratchlistMode: () => void
}) {
    const assistantApi = useAssistantApi()
    const handlePromoteToComposer = useCallback((text: string) => {
        assistantApi.composer().setText(text)
        props.onExitScratchlistMode()
    }, [assistantApi, props.onExitScratchlistMode])
    const handlePromoteToQueue = useCallback(async (text: string) => {
        // Promote-to-queue bypasses the scratchlist-mode wrapper by
        // calling props.onSend directly (the chat send), so the queue
        // entry lands in the conversation regardless of scratchlist
        // mode. Mode itself stays on - the operator may still be
        // capturing related notes.
        return await props.onSend(text)
    }, [props.onSend])
    return (
        <ScratchlistDrawer
            entries={props.entries}
            onMove={props.onMove}
            onDelete={props.onDelete}
            onPromoteToComposer={handlePromoteToComposer}
            onPromoteToQueue={handlePromoteToQueue}
        />
    )
}

export function buildGoalStateMessages(
    messages: DecryptedMessage[],
    pendingMessages: DecryptedMessage[] = []
): DecryptedMessage[] {
    const eligibleMessages = messages.filter((message) => !isUninvokedScheduledMessage(message))
    const eligiblePendingMessages = pendingMessages.filter((message) => !isUninvokedScheduledMessage(message))
    return eligiblePendingMessages.length > 0
        ? mergeMessages(eligibleMessages, eligiblePendingMessages)
        : eligibleMessages
}

/**
 * The normal live-stream path has no queued/scheduled message to merge back
 * into goal state. In that common case the already-normalized timeline is
 * exactly the goal-state source, so doing a second full-window filter and
 * parse on every token is needless work. Keep the conservative fallback for
 * queued and scheduled rows: they are intentionally hidden from the visible
 * timeline but can still clear a completed goal.
 */
export function canReuseTimelineMessagesForGoalState(
    messages: readonly DecryptedMessage[],
    pendingMessages: readonly DecryptedMessage[] = []
): boolean {
    if (pendingMessages.length > 0) {
        return false
    }

    return messages.every((message) => (
        !isQueuedForInvocation(message) && !isUninvokedScheduledMessage(message)
    ))
}

function getOutlineTitle(session: Session): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        return session.metadata.path
    }
    return session.id.slice(0, 8)
}

function isBlockInTurnScope(block: ChatBlock, minCreatedAt: number | null): boolean {
    return minCreatedAt === null || block.createdAt >= minCreatedAt
}

function hasAbortableAgentRun(blocks: readonly ChatBlock[], minCreatedAt: number | null = null): boolean {
    for (const block of blocks) {
        if (block.kind === 'tool-call') {
            if (
                block.tool.name === 'CodexAgent'
                && (block.tool.state === 'running' || block.tool.state === 'pending')
                && isBlockInTurnScope(block, minCreatedAt)
            ) {
                return true
            }
            if (hasAbortableAgentRun(block.children, minCreatedAt)) {
                return true
            }
        }
    }
    return false
}

function appendBlockActivityParts(block: ChatBlock, parts: string[]): void {
    if (block.kind === 'tool-call') {
        parts.push([
            block.id,
            block.kind,
            block.tool.state,
            block.tool.startedAt ?? '',
            block.tool.completedAt ?? '',
            block.tool.permission?.status ?? '',
            block.children.length
        ].join(':'))
        for (const child of block.children) {
            appendBlockActivityParts(child, parts)
        }
        return
    }

    if (block.kind === 'agent-text' || block.kind === 'agent-reasoning' || block.kind === 'cli-output') {
        parts.push([
            block.id,
            block.kind,
            block.text.length,
            block.durationMs ?? '',
        ].join(':'))
        return
    }

    if (block.kind === 'user-text') {
        parts.push([
            block.id,
            block.kind,
            block.status ?? '',
            block.invokedAt ?? '',
            block.text.length,
        ].join(':'))
        return
    }

    parts.push([
        block.id,
        block.kind,
        'durationMs' in block ? block.durationMs ?? '' : '',
        'invokedAt' in block ? block.invokedAt ?? '' : '',
    ].join(':'))
}

export function getChatActivityKey(blocks: readonly ChatBlock[]): string {
    const parts: string[] = []
    const recentBlocks = blocks.slice(-RUN_ACTIVITY_KEY_LOOKBACK)
    for (const block of recentBlocks) {
        appendBlockActivityParts(block, parts)
    }
    return parts.join('|')
}

export function getLatestTurnCompletionKey(messages: readonly NormalizedMessage[]): string | null {
    const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
    if (latestUserIndex === -1) return null

    let completionKey: string | null = null
    for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
        const message = messages[index]
        if (message.role !== 'event') continue
        if (message.content.type !== 'ready' && message.content.type !== 'turn-duration') continue
        completionKey = `${message.id}:${message.createdAt}:${message.content.type}`
    }
    return completionKey
}

export function getLatestUserTurnCreatedAt(messages: readonly NormalizedMessage[]): number | null {
    const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
    return latestUserIndex >= 0 ? messages[latestUserIndex]!.createdAt : null
}

function useSettledRunActive(
    rawRunActive: boolean,
    activityKey: string,
    completionKey: string | null
): boolean {
    const [settledRunActive, setSettledRunActive] = useState(rawRunActive)
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const completionKeyAtActivationRef = useRef<string | null>(completionKey)
    const wasRawActiveRef = useRef(rawRunActive)

    useEffect(() => {
        if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current)
            settleTimerRef.current = null
        }

        if (rawRunActive) {
            if (!wasRawActiveRef.current) {
                completionKeyAtActivationRef.current = completionKey
            }
            wasRawActiveRef.current = true
            setSettledRunActive(true)
            return
        }

        wasRawActiveRef.current = false
        const hasNewCompletion = completionKey !== null && completionKey !== completionKeyAtActivationRef.current
        if (hasNewCompletion) {
            setSettledRunActive(false)
            return
        }

        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null
            setSettledRunActive(false)
        }, RUN_SETTLE_DELAY_MS)

        return () => {
            if (settleTimerRef.current !== null) {
                clearTimeout(settleTimerRef.current)
                settleTimerRef.current = null
            }
        }
    }, [activityKey, completionKey, rawRunActive])

    return rawRunActive || settledRunActive
}

type SessionChatProps = {
    api: ApiClient
    session: Session
    messages: DecryptedMessage[]
    pendingMessages?: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isLoadingMessages: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    pendingCount: number
    messagesVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: () => Promise<unknown>
    // Resolves true when the send was accepted by the underlying mutation, false when
    // pre-mutation guards (no-api / no-session / pending) rejected the call OR async
    // inactive-session resume failed. Composer state that should only be cleared on
    // actual send (pendingSchedule) must await this — see handleSend below.
    onSend: (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => Promise<boolean>
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
    skills?: SkillSummary[]
    skillsLoading?: boolean
    skillsError?: string | null
    // The latest send the hub rejected (4xx/5xx/network).  When set, the
    // composer is asked to restore the typed text and surface an inline
    // error -- see HappyComposer.  Cleared by `onClearSendError` once the
    // user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    initialOutlineOpen?: boolean
    onInitialOutlineConsumed?: () => void
}

type NormalizedMessageCache = Map<string, {
    source: DecryptedMessage
    normalized: NormalizedMessage | null
}>

function normalizeMessagesWithCache(
    messages: readonly DecryptedMessage[],
    cache: NormalizedMessageCache
): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = []
    const seen = new Set<string>()
    for (const message of messages) {
        if (seen.has(message.id)) {
            continue
        }
        seen.add(message.id)
        const cached = cache.get(message.id)
        if (cached && cached.source === message) {
            if (cached.normalized) {
                normalized.push(cached.normalized)
            }
            continue
        }
        const next = normalizeDecryptedMessage(message)
        cache.set(message.id, { source: message, normalized: next })
        if (next) {
            normalized.push(next)
        }
    }
    for (const id of cache.keys()) {
        if (!seen.has(id)) {
            cache.delete(id)
        }
    }
    return normalized
}

type ThreadRenderSnapshot = {
    messages: DecryptedMessage[]
    pendingMessages: DecryptedMessage[]
    messagesVersion: number
}

/**
 * Keep an accepted local send visible while its first deferred render catches
 * up. Without the small hand-off guard, a mutation that flips `isSending`
 * false before the background render commits can briefly make the just-sent
 * row disappear. Server streaming itself remains deferred.
 */
function useDeferredThreadSnapshot(
    snapshot: ThreadRenderSnapshot,
    forceCurrent: boolean
): ThreadRenderSnapshot {
    const deferredSnapshot = useDeferredValue(snapshot)
    const [urgentVersion, setUrgentVersion] = useState<number | null>(null)

    useEffect(() => {
        if (forceCurrent) {
            setUrgentVersion(snapshot.messagesVersion)
        }
    }, [forceCurrent, snapshot.messagesVersion])

    useEffect(() => {
        if (urgentVersion !== null && deferredSnapshot.messagesVersion >= urgentVersion) {
            setUrgentVersion(null)
        }
    }, [deferredSnapshot.messagesVersion, urgentVersion])

    return forceCurrent || urgentVersion !== null ? snapshot : deferredSnapshot
}

/**
 * Public entry point. Thin wrapper around `SessionChatInner` keyed by
 * the session id so that ALL inner state - including the scratchlist
 * (entries + mode) and the assistant-ui runtime - resets atomically
 * when the operator navigates between sessions on the same route
 * (e.g. /sessions/A -> /sessions/B).
 *
 * Without the key, React reuses the same component instance, and
 * effects run AFTER the first paint of the new session. That window
 * briefly renders the new session with the previous session's
 * scratchlist entries / drawer-open state, which is the bot finding
 * on PR #798 (PRRT_kwDOQuQOSc6HHOsa). The keyed wrapper is the
 * canonical React pattern for "fully reset state on prop change"; it
 * supersedes the effect-based mode-reset that previously lived in
 * SessionChatInner.
 */
export function SessionChat(props: SessionChatProps) {
    return <ChatPreviewProvider key={props.session.id}><SessionChatInner key={props.session.id} {...props} /></ChatPreviewProvider>
}

function SessionChatInner(props: SessionChatProps) {
    const { haptic } = usePlatform()
    const { t } = useTranslation()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { sessions: sessionSummaries } = useSessions(props.api, { live: false })
    const sessionInactive = !props.session.active
    const inactiveCanResume = inactiveSessionCanResume(props.session, props.messages.length)
    const terminalSupported = isRemoteTerminalSupported(props.session.metadata)
    const gitSessionId = props.session.metadata?.path ? props.session.id : null
    const {
        status: gitStatus,
        error: gitStatusError,
        isLoading: gitStatusLoading,
        refetch: refetchGitStatus
    } = useGitStatusFiles(props.api, gitSessionId)
    const gitDiffDisplayStatus = gitStatusError ? null : gitStatus
    const gitDiffSummaryVisible = useMemo(
        () => summarizeGitStatusFiles(gitDiffDisplayStatus) !== null,
        [gitDiffDisplayStatus]
    )
    const normalizedCacheRef = useRef<NormalizedMessageCache>(new Map())
    const normalizedGoalStateCacheRef = useRef<NormalizedMessageCache>(new Map())
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const visibleGroupsRef = useRef<ToolGroupBlock[]>([])
    const timelineCacheRef = useRef<SessionDetailTimelineCache | null>(null)
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const [dismissedCodexQuickReplyPromptId, setDismissedCodexQuickReplyPromptId] = useState<string | null>(null)
    const [codexQuickReplySending, setCodexQuickReplySending] = useState(false)
    const [outlineOpen, setOutlineOpen] = useState(props.initialOutlineOpen ?? false)
    const bottomOverlayRef = useRef<HTMLDivElement | null>(null)
    const composerOverlayRef = useRef<HTMLDivElement | null>(null)
    const bottomAccessoryRef = useRef<HTMLDivElement | null>(null)
    const [bottomOverlayHeight, setBottomOverlayHeight] = useState(0)
    const [composerOverlayHeight, setComposerOverlayHeight] = useState(0)
    const [bottomAccessoryHeight, setBottomAccessoryHeight] = useState(0)
    const [statusAccessoryExpanded, setStatusAccessoryExpanded] = useState(false)
    const [queueAccessoryExpanded, setQueueAccessoryExpanded] = useState(false)
    const [clearedPlanSourceBlockId, setClearedPlanSourceBlockId] = useState<string | null>(null)
    const scrollButtonPositionReady = bottomOverlayHeight > 0 && !(gitSessionId && gitStatusLoading)
    useEffect(() => {
        if (!props.initialOutlineOpen) {
            return
        }
        setOutlineOpen(true)
        props.onInitialOutlineConsumed?.()
    }, [props.initialOutlineOpen, props.onInitialOutlineConsumed])

    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    const lastSyncedCursorModelRef = useRef<string | null | undefined>(undefined)
    const scratchlist = useScratchlist(props.session.id)
    const [scratchlistMode, setScratchlistMode] = useState(false)
    // Mode resets across sessions implicitly: SessionChat is keyed by
    // session.id at the public-export boundary, so a session switch
    // remounts SessionChatInner from scratch and `scratchlistMode`
    // initializes to false again. (Previous effect-based reset was
    // racy on first paint - see public-export comment for context.)
    const handleScratchlistToggle = useCallback(() => {
        setScratchlistMode((m) => !m)
    }, [])
    /**
     * Global keyboard shortcut: Ctrl/Cmd + Shift + S toggles scratchlist
     * mode (open/close drawer + flip composer routing).
     *
     * Convention matches the v1 always-visible panel's shortcut so muscle
     * memory carries over. Other composer-adjacent globals in the app use
     * the same modifier shape: Ctrl/Cmd-m cycles agent model in
     * HappyComposer. Ctrl/Cmd-Shift-S is unreserved by Chrome / Firefox /
     * Safari at the app level (browser Save As is Ctrl-S / Cmd-S, no
     * Shift), so requiring Shift keeps the user's save-page muscle memory
     * working. Bound at SessionChat scope (not the drawer) because the
     * drawer is unmounted while mode is off — a drawer-scoped listener
     * couldn't reopen it.
     *
     * Skipped when focus is inside an open dialog or single-line input
     * (see isScratchlistHotkeyBlockedTarget). Otherwise fires for any
     * focus target - composer textarea is the expected case so it's
     * deliberately allowed. Window-level shortcut without target
     * filtering would silently toggle mode "behind" modal dialogs
     * (rename, schedule picker, FUE callout); the bot caught this on
     * PR #798.
     */
    useEffect(() => {
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if (!isScratchlistToggleHotkey(e)) return
            if (isScratchlistHotkeyBlockedTarget(e.target)) return
            e.preventDefault()
            setScratchlistMode((m) => !m)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])
    const followLatestMessage = useCallback(() => {
        setForceScrollToken((token) => token + 1)
    }, [])
    const sendChatMessageAndFollow = useCallback(
        async (
            text: string,
            attachments?: AttachmentMetadata[],
            scheduledAt?: number | null,
        ): Promise<boolean> => {
            const accepted = await props.onSend(text, attachments, scheduledAt)
            if (accepted) {
                followLatestMessage()
            }
            return accepted
        },
        [followLatestMessage, props.onSend],
    )
    /**
     * onSend wrapper: when scratchlist mode is on AND the submission is
     * pure text (no attachments, no scheduledAt), the operator's submit
     * is treated as "add to scratchlist" instead of "send to chat".
     *
     * If the submission carries attachments or a scheduledAt value,
     * scratchlist can't represent it (entries are text-only), so we
     * fall through to the normal chat send. Silently dropping
     * attachments / schedule while reporting success to the composer
     * caused PR #798 review's [Major] data-loss finding.
     *
     * The composer (HappyComposer) uses the boolean return value to
     * decide whether to clear text/attachments/schedule, so we resolve
     * true on a successful add - the operator's text gets cleared and
     * they can keep adding entries while sticky-mode is on. If add()
     * returns false (empty after trim, at-cap), we resolve false so
     * the composer keeps its text and the operator can fix it.
     */
    const onSendForComposer = useCallback(
        async (
            text: string,
            attachments?: AttachmentMetadata[],
            scheduledAt?: number | null,
        ): Promise<boolean> => {
            if (shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)) {
                return scratchlist.add(text)
            }
            return sendChatMessageAndFollow(text, attachments, scheduledAt)
        },
        [scratchlist, scratchlistMode, sendChatMessageAndFollow],
    )
    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const [sideSessionPending, setSideSessionPending] = useState(false)
    const [sideSessionError, setSideSessionError] = useState<string | null>(null)
    const hasCursorMigrationNotice = isCursorMigrationInProgress(props.session.metadata)
        || isCursorMigrationAmbiguous(props.session.metadata)
    const hasFloatingHeaderNotice = hasCursorMigrationNotice
        || sideSessionError !== null
        || Boolean(props.session.teamState)
    const activeSideSessions = useMemo(() => {
        return sessionSummaries
            .filter((session) => session.active && session.metadata?.sideSession?.parentSessionId === props.session.id)
            .map((session) => ({
                id: session.id,
                title: session.metadata?.name
                    ?? session.metadata?.summary?.text
                    ?? session.metadata?.path?.split('/').filter(Boolean).pop()
                    ?? session.id.slice(0, 8)
            }))
    }, [props.session.id, sessionSummaries])
    const handleCreateSideSession = useCallback(async () => {
        if (sideSessionPending) return
        setSideSessionPending(true)
        setSideSessionError(null)
        try {
            const result = await props.api.createSideSession(props.session.id)
            if (result.type === 'error') {
                throw new Error(result.message)
            }
            const sideSession = result.session
            if (sideSession) {
                queryClient.setQueryData(queryKeys.session(result.sessionId), { session: sideSession })
                queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                    if (!previous) return previous
                    return {
                        ...previous,
                        sessions: [
                            toSessionSummary(sideSession),
                            ...previous.sessions.filter((candidate) => candidate.id !== result.sessionId)
                        ]
                    }
                })
            }
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
                queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) })
            ])
            await navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: result.sessionId },
                search: { fromSessionId: props.session.id }
            })
        } catch (error) {
            const message = error instanceof ApiError && error.code === 'fork_unavailable'
                ? t('session.sideSession.unavailable')
                : getApiErrorPayloadMessage(error)
                    ?? (error instanceof Error ? error.message : 'Failed to create side session')
            setSideSessionError(message)
        } finally {
            setSideSessionPending(false)
        }
    }, [navigate, props.api, props.session.id, queryClient, sideSessionPending, t])
    const handleSelectSideSession = useCallback((sessionId: string) => {
        void navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            search: { fromSessionId: props.session.id }
        })
    }, [navigate])
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const codexModelsState = useCodexModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'codex' && props.session.active && !controlledByUser
    })
    const codexModelOptions = useMemo(() => {
        if (agentFlavor !== 'codex') {
            return undefined
        }

        const options: Array<{ value: string | null; label: string }> = []
        for (const codexModel of codexModelsState.models) {
            options.push({
                value: codexModel.id,
                label: codexModel.displayName
            })
        }
        return options
    }, [agentFlavor, codexModelsState.models])
    const codexReasoningEffortOptions = useMemo(() => {
        if (agentFlavor !== 'codex') {
            return undefined
        }

        const selectedModel = props.session.model
            ? codexModelsState.models.find((candidate) => candidate.id === props.session.model)
            : codexModelsState.models.find((candidate) => candidate.isDefault) ?? codexModelsState.models[0]
        return selectedModel?.supportedReasoningEfforts?.map((value) => ({ value }))
    }, [agentFlavor, codexModelsState.models, props.session.model])
    const opencodeModelsState = useOpencodeModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeReasoningEffortState = useOpencodeReasoningEffortOptions({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeModelOptions = useMemo(() => {
        if (agentFlavor !== 'opencode') {
            return undefined
        }

        return opencodeModelsState.availableModels.map((opencodeModel) => ({
            value: opencodeModel.modelId,
            label: opencodeModel.name ?? opencodeModel.modelId
        }))
    }, [agentFlavor, opencodeModelsState.availableModels])
    const cursorModelsState = useCursorModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'cursor' && props.session.active
    })
    const sessionMachineId = props.session.metadata?.machineId ?? null
    const machineCursorModelsState = useCursorModelsForMachine({
        api: props.api,
        machineId: sessionMachineId,
        enabled: agentFlavor === 'cursor' && props.session.active && Boolean(sessionMachineId)
    })
    const sessionCliModelSkus = useMemo(() => (
        mergeCursorCliModelSkus(
            machineCursorModelsState.cliModelSkus,
            cursorModelsState.cliModelSkus
        )
    ), [cursorModelsState.cliModelSkus, machineCursorModelsState.cliModelSkus])
    const cursorPicker = useMemo(() => {
        if (agentFlavor !== 'cursor') {
            return null
        }

        return buildSessionCursorPickerState({
            sessionModels: cursorModelsState.availableModels,
            machineModels: machineCursorModelsState.availableModels,
            cliModelSkus: sessionCliModelSkus,
            sessionModel: props.session.model,
            sessionCurrentModelId: cursorModelsState.currentModelId
        })
    }, [
        agentFlavor,
        cursorModelsState.availableModels,
        cursorModelsState.currentModelId,
        machineCursorModelsState.availableModels,
        sessionCliModelSkus,
        props.session.model
    ])
    const piModelsState = usePiModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'pi' && props.session.active
    })
    // Fallback to cached models from metadata when session is inactive
    const piMetadata = props.session.metadata as Record<string, unknown> | null
    const piCachedModels = piMetadata?.piAvailableModels as PiModelSummary[] | undefined ?? []
    // Provider-qualified selected model — disambiguates when two providers
    // share a modelId (hub persists this alongside the legacy modelId string).
    const piSelectedModel = piMetadata?.piSelectedModel as { provider: string; modelId: string } | null | undefined
    const cursorCatalogReadinessArgs = useMemo(() => ({
        sessionLoading: cursorModelsState.isLoading,
        machineLoading: machineCursorModelsState.isLoading,
        hasMachineId: Boolean(sessionMachineId),
        sessionError: cursorModelsState.error,
        machineError: machineCursorModelsState.error,
        mergedSkus: sessionCliModelSkus,
        picker: cursorPicker
    }), [
        cursorModelsState.isLoading,
        cursorModelsState.error,
        machineCursorModelsState.isLoading,
        machineCursorModelsState.error,
        sessionMachineId,
        sessionCliModelSkus,
        cursorPicker
    ])
    const cursorCatalogAwaitingSkus = useMemo(
        () => isSessionCursorCatalogAwaitingSkus(cursorCatalogReadinessArgs),
        [cursorCatalogReadinessArgs]
    )
    const [cursorSkuAwaitingSince, setCursorSkuAwaitingSince] = useState<number | null>(null)
    const [cursorCatalogNowMs, setCursorCatalogNowMs] = useState(() => Date.now())
    useEffect(() => {
        if (cursorCatalogAwaitingSkus) {
            setCursorSkuAwaitingSince((previous) => previous ?? Date.now())
            const timer = setTimeout(
                () => setCursorCatalogNowMs(Date.now()),
                SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS
            )
            return () => clearTimeout(timer)
        }
        setCursorSkuAwaitingSince(null)
        setCursorCatalogNowMs(Date.now())
        return undefined
    }, [cursorCatalogAwaitingSkus])
    const cursorCatalogPending = isSessionCursorCatalogPendingWithTimeout({
        ...cursorCatalogReadinessArgs,
        awaitingStartedAtMs: cursorSkuAwaitingSince,
        nowMs: cursorCatalogNowMs
    })

    useEffect(() => {
        if (agentFlavor !== 'cursor' || !cursorPicker) {
            lastSyncedCursorModelRef.current = undefined
            return
        }
        const sessionModel = props.session.model ?? null
        const baseFromSession = sessionModel
            ? resolveCursorBaseFromWire(sessionModel, cursorPicker.catalog)
            : 'auto'
        if (lastSyncedCursorModelRef.current === sessionModel) {
            if (!sessionModel) {
                return
            }
            setCursorSelectedBase((prev) => (prev === 'auto' ? baseFromSession : prev))
            return
        }
        lastSyncedCursorModelRef.current = sessionModel
        setCursorSelectedBase(baseFromSession)
    }, [agentFlavor, props.session.model, cursorPicker])

    const cursorSelectedBaseValue = useMemo(() => (
        agentFlavor === 'cursor' && cursorPicker?.mode === 'dual'
            ? resolveSessionCursorBaseSelectValue(cursorPicker, cursorSelectedBase)
            : undefined
    ), [agentFlavor, cursorPicker, cursorSelectedBase])

    const cursorModelEffortOptions = useMemo(() => {
        if (agentFlavor !== 'cursor' || !cursorPicker) {
            return undefined
        }
        if (cursorPicker.mode !== 'dual') {
            return cursorPicker.effortOptions
        }
        const baseKey = cursorSelectedBaseValue && cursorSelectedBaseValue !== 'auto'
            ? cursorSelectedBaseValue
            : cursorPicker.baseKey
        return buildCursorEffortPickerOptions(resolveCursorVariantOptions(baseKey ?? null, cursorPicker.catalog))
    }, [agentFlavor, cursorPicker, cursorSelectedBaseValue])

    const cursorVariantSelectValue = useMemo(() => (
        agentFlavor === 'cursor' && cursorModelEffortOptions
            ? resolveSessionCursorVariantSelectValue(props.session.model, cursorModelEffortOptions)
            : null
    ), [agentFlavor, cursorModelEffortOptions, props.session.model])
    const {
        abortSession,
        switchSession,
        setPermissionMode,
        setCollaborationMode,
        setModel,
        setModelReasoningEffort,
        setEffort,
        setServiceTier
    } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor,
        codexCollaborationModeSupported
    )

    // Voice assistant integration
    const voice = useVoiceOptional()
    const [voiceBackendRequested, setVoiceBackendRequested] = useState(false)
    const [voiceBackendReady, setVoiceBackendReady] = useState(false)
    const [voiceStartRequested, setVoiceStartRequested] = useState(false)

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => {
                void sendChatMessageAndFollow(message)
            },
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onRefresh, sendChatMessageAndFollow])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (sessionId === props.session.id ? props.messages : [])
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevMessagesRef = useRef<DecryptedMessage[]>([])

    useEffect(() => {
        const prevIds = new Set(prevMessagesRef.current.map(m => m.id))
        const newMessages = props.messages.filter(m => !prevIds.has(m.id))

        if (newMessages.length > 0) {
            voiceHooks.onMessages(props.session.id, newMessages)
        }

        prevMessagesRef.current = props.messages
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            setVoiceStartRequested(false)
            await voice.stopVoice()
            return
        }

        setVoiceBackendRequested(true)
        voice.setStatus('connecting')
        if (!voiceBackendReady) {
            setVoiceStartRequested(true)
            return
        }

        await voice.startVoice(props.session.id)
    }, [voice, voiceBackendReady, props.session.id])

    useEffect(() => {
        if (!voice || !voiceBackendReady || !voiceStartRequested || voice.status !== 'connecting') {
            return
        }

        setVoiceStartRequested(false)
        void voice.startVoice(props.session.id)
    }, [voice, voiceBackendReady, voiceStartRequested, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])

    // Track session id to clear caches when it changes
    const prevSessionIdRef = useRef<string | null>(null)

    useEffect(() => {
        normalizedCacheRef.current.clear()
        normalizedGoalStateCacheRef.current.clear()
        blocksByIdRef.current.clear()
        visibleGroupsRef.current = []
        timelineCacheRef.current = null
        setOutlineOpen(false)
    }, [props.session.id])

    const queuedMessages = useQueuedMessages(props.session.id)

    // Message SSE updates are intentionally allowed to settle behind urgent
    // controls. The composer, permission actions, stop button, and session
    // state still receive current props; only the expensive thread reduction
    // (normalization → blocks → assistant-ui runtime) uses this snapshot.
    // Keep a version in the same object so HappyThread never scrolls for a
    // message revision that has not reached its DOM yet.
    const currentThreadSnapshot = useMemo(() => ({
        messages: props.messages,
        pendingMessages: props.pendingMessages ?? [],
        messagesVersion: props.messagesVersion,
    }), [props.messages, props.pendingMessages, props.messagesVersion])
    const threadSnapshot = useDeferredThreadSnapshot(
        currentThreadSnapshot,
        props.isSending || codexQuickReplySending
    )

    // Exclude user messages that haven't been invoked yet — those appear in the
    // queue drawer, not in the thread timeline. The shared predicate keeps the
    // thread, message window, and floating queue entry point in agreement.
    const visibleMessages = useMemo(
        () => threadSnapshot.messages.filter((m) => !isQueuedForInvocation(m)),
        [threadSnapshot.messages]
    )

    const normalizedMessages: NormalizedMessage[] = useMemo(() => {
        // Clear caches immediately when session changes (before useEffect runs)
        if (prevSessionIdRef.current !== null && prevSessionIdRef.current !== props.session.id) {
            normalizedCacheRef.current.clear()
            normalizedGoalStateCacheRef.current.clear()
            blocksByIdRef.current.clear()
            visibleGroupsRef.current = []
            timelineCacheRef.current = null
        }
        prevSessionIdRef.current = props.session.id

        return measureThreadWork(
            props.session.id,
            'normalize',
            threadSnapshot.messagesVersion,
            () => normalizeMessagesWithCache(visibleMessages, normalizedCacheRef.current)
        )
    }, [props.session.id, threadSnapshot.messagesVersion, visibleMessages])
    const canReuseTimelineForGoalState = useMemo(
        () => canReuseTimelineMessagesForGoalState(threadSnapshot.messages, threadSnapshot.pendingMessages),
        [threadSnapshot.messages, threadSnapshot.pendingMessages]
    )

    const goalStateSourceMessages = useMemo(
        () => canReuseTimelineForGoalState
            ? null
            : buildGoalStateMessages(threadSnapshot.messages, threadSnapshot.pendingMessages),
        [canReuseTimelineForGoalState, threadSnapshot.messages, threadSnapshot.pendingMessages]
    )

    const normalizedGoalStateMessages = useMemo(() => {
        if (canReuseTimelineForGoalState) {
            return normalizedMessages
        }

        return measureThreadWork(
            props.session.id,
            'normalize',
            threadSnapshot.messagesVersion,
            () => normalizeMessagesWithCache(goalStateSourceMessages ?? [], normalizedGoalStateCacheRef.current)
        )
    }, [
        canReuseTimelineForGoalState,
        goalStateSourceMessages,
        normalizedMessages,
        props.session.id,
        threadSnapshot.messagesVersion
    ])

    const codexQuickReplyPrompt = useMemo(() => {
        if (agentFlavor !== 'codex') {
            return null
        }
        return getPendingCodexQuickReplyPrompt(normalizedGoalStateMessages)
    }, [agentFlavor, normalizedGoalStateMessages])
    const showCodexQuickReply = codexQuickReplyPrompt !== null
        && codexQuickReplyPrompt.messageId !== dismissedCodexQuickReplyPromptId

    const reduced = useMemo(() => measureThreadWork(
        props.session.id,
        'reduce',
        threadSnapshot.messagesVersion,
        () => reduceChatBlocks(normalizedMessages, props.session.agentState, {
            goalStateMessages: normalizedGoalStateMessages
        })
    ), [
        normalizedMessages,
        normalizedGoalStateMessages,
        props.session.agentState,
        props.session.id,
        threadSnapshot.messagesVersion
    ])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks]
    )
    const latestUserTurnCreatedAt = useMemo(
        () => getLatestUserTurnCreatedAt(normalizedMessages),
        [normalizedMessages]
    )
    const thinkingStartedAt = useMemo(() => getThinkingStartedAt(normalizedMessages), [normalizedMessages])
    const turnCompletionKey = useMemo(
        () => getLatestTurnCompletionKey(normalizedMessages),
        [normalizedMessages]
    )
    const hasRunningChildAgent = useMemo(
        () => turnCompletionKey === null && hasAbortableAgentRun(reduced.blocks, latestUserTurnCreatedAt),
        [latestUserTurnCreatedAt, reduced.blocks, turnCompletionKey]
    )
    const hasThinkingChildAgent = useMemo(
        () => hasAbortableAgentRun(reduced.blocks, latestUserTurnCreatedAt),
        [latestUserTurnCreatedAt, reduced.blocks]
    )
    const latestPlanStatus = useMemo(
        () => extractLatestPlanStatus(reconciled.blocks, { minCreatedAt: latestUserTurnCreatedAt }),
        [latestUserTurnCreatedAt, reconciled.blocks]
    )
    const hasActiveTool = useMemo(
        () => turnCompletionKey === null && hasActiveToolBlock(reconciled.blocks, { minCreatedAt: latestUserTurnCreatedAt }),
        [latestUserTurnCreatedAt, reconciled.blocks, turnCompletionKey]
    )
    const rawRunActive = props.isSending || props.session.thinking || hasRunningChildAgent || hasActiveTool
    const runActivityKey = useMemo(
        () => getChatActivityKey(reconciled.blocks),
        [reconciled.blocks]
    )
    const runActive = useSettledRunActive(rawRunActive, runActivityKey, turnCompletionKey)
    const previousGitRunActiveRef = useRef(runActive)
    const activePlanStatus = getRunScopedPlanStatus(latestPlanStatus, {
        runActive,
        clearedSourceBlockId: clearedPlanSourceBlockId
    })
    const planStatusVisible = activePlanStatus !== null
    const gitDiffAccessoryVisible = !runActive && gitDiffSummaryVisible
    const queueAccessoryVisible = queuedMessages.length > 0
    const bottomAccessoryVisible = queueAccessoryVisible || planStatusVisible || gitDiffAccessoryVisible
    const bottomAccessoryExpanded = statusAccessoryExpanded || queueAccessoryExpanded
    const threadBottomInset = getBottomOverlayThreadInset(
        bottomOverlayHeight,
        bottomAccessoryHeight,
        bottomAccessoryVisible,
    )
    const scrollButtonBottomInset = getScrollButtonBottomInset(
        composerOverlayHeight,
        bottomOverlayHeight,
        BOTTOM_OVERLAY_INSET_PX,
        bottomAccessoryVisible,
    )
    const displayBlocks = useMemo(
        () => (
            activePlanStatus
                ? removeChatBlockById(reconciled.blocks, activePlanStatus.sourceBlockId)
                : reconciled.blocks
        ),
        [activePlanStatus, reconciled.blocks]
    )

    useEffect(() => {
        if (runActive) return
        setClearedPlanSourceBlockId(latestPlanStatus?.sourceBlockId ?? null)
    }, [latestPlanStatus?.sourceBlockId, runActive])

    useEffect(() => {
        blocksByIdRef.current = reconciled.byId
    }, [reconciled.byId])

    const timelineResult = useMemo(
        () => measureThreadWork(
            props.session.id,
            'timeline',
            threadSnapshot.messagesVersion,
            () => buildIncrementalSessionDetailTimeline(displayBlocks, {
                hasMoreMessages: props.hasMoreMessages,
                previousGroups: visibleGroupsRef.current,
                terminalToolDisplayMode,
                runActive
            }, timelineCacheRef.current)
        ),
        [
            displayBlocks,
            props.hasMoreMessages,
            props.session.id,
            runActive,
            terminalToolDisplayMode,
            threadSnapshot.messagesVersion
        ]
    )
    const timeline = timelineResult.timeline
    const groupedVisibleBlocks = timeline.grouped
    const visibleBlocks = timeline.visible
    const currentTurnProcessVisible = useMemo(
        () => hasCurrentTurnProcess(groupedVisibleBlocks, { minCreatedAt: latestUserTurnCreatedAt }),
        [groupedVisibleBlocks, latestUserTurnCreatedAt]
    )
    useEffect(() => {
        timelineCacheRef.current = timelineResult.cache
    }, [timelineResult.cache])
    useEffect(() => {
        visibleGroupsRef.current = groupedVisibleBlocks.filter(isToolGroupBlock)
    }, [groupedVisibleBlocks])

    // The outline is a demand-driven drawer. Avoid another complete timeline
    // walk during a stream until the operator actually opens it.
    const outlineItems = useMemo(
        () => outlineOpen ? buildConversationOutline(reconciled.blocks) : [],
        [outlineOpen, reconciled.blocks]
    )

    const outlineTitle = useMemo(
        () => getOutlineTitle(props.session),
        [props.session]
    )

    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    const handleCollaborationModeChange = useCallback(async (mode: CodexCollaborationMode) => {
        try {
            await setCollaborationMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set collaboration mode:', e)
        }
    }, [setCollaborationMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelChange = useCallback(async (model: { provider: string; modelId: string } | string | null) => {
        try {
            await setModel(model)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model:', e)
        }
    }, [setModel, props.onRefresh, haptic])

    const handleCursorBaseModelChange = useCallback(async (baseKey: string | null) => {
        if (!cursorPicker) {
            await handleModelChange(baseKey)
            return
        }
        const plan = resolveSessionCursorModelChange({
            picker: cursorPicker,
            sessionModel: props.session.model,
            cursorSelectedBase,
            kind: cursorPicker.mode === 'flat' ? 'flat' : 'base',
            value: baseKey
        })
        if (!plan.ok) {
            return
        }
        setCursorSelectedBase(plan.nextSelectedBase)
        if (plan.shouldApply) {
            await handleModelChange(plan.wireId)
        }
    }, [cursorPicker, cursorSelectedBase, handleModelChange, props.session.model])

    const handleCursorEffortChange = useCallback(async (wireId: string | null) => {
        if (!cursorPicker) {
            await handleModelChange(wireId)
            return
        }
        const plan = resolveSessionCursorModelChange({
            picker: cursorPicker,
            sessionModel: props.session.model,
            cursorSelectedBase,
            kind: 'effort',
            value: wireId
        })
        if (!plan.ok) {
            console.error(plan.reason)
            return
        }
        setCursorSelectedBase(plan.nextSelectedBase)
        await handleModelChange(plan.wireId)
    }, [cursorPicker, cursorSelectedBase, handleModelChange, props.session.model])

    const handleModelReasoningEffortChange = useCallback(async (modelReasoningEffort: string | null) => {
        try {
            await setModelReasoningEffort(modelReasoningEffort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model reasoning effort:', e)
        }
    }, [setModelReasoningEffort, props.onRefresh, haptic])

    const handleEffortChange = useCallback(async (effort: string | null) => {
        try {
            await setEffort(effort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set effort:', e)
        }
    }, [setEffort, props.onRefresh, haptic])

    const handleServiceTierChange = useCallback(async (serviceTier: string | null) => {
        try {
            await setServiceTier(serviceTier)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set service tier:', e)
        }
    }, [setServiceTier, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])

    const handleToggleFiles = useCallback(() => {
        setOutlineOpen(false)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    const handleViewDiff = useCallback(() => {
        setOutlineOpen(false)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id },
            search: { tab: 'changes' }
        })
    }, [navigate, props.session.id])

    const openPreview = useChatPreview()
    const handleViewFileDiff = useCallback((file: { path: string; staged: boolean; unstaged: boolean; status?: string }) => {
        setOutlineOpen(false)
        if (openPreview?.({ type: 'file', api: props.api, source: { type: 'session', sessionId: props.session.id }, workspacePath: props.session.metadata?.path, path: file.path, staged: file.staged && !file.unstaged, diff: file.status !== 'untracked' })) return
        navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId: props.session.id },
            search: {
                path: encodeBase64(file.path),
                staged: file.staged && !file.unstaged ? true : false,
                from: 'session'
            }
        })
    }, [navigate, props.session.id, props.session.metadata?.path, props.api, openPreview])

    const handleToggleOutline = useCallback(() => {
        setOutlineOpen((open) => !open)
    }, [])

    const handleSessionReopened = useCallback((newSessionId: string) => {
        void navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: newSessionId },
            replace: true
        })
    }, [navigate])

    const handleBottomAccessoryExpandedChange = useCallback((expanded: boolean) => {
        setStatusAccessoryExpanded(expanded)
    }, [])

    const handleQueueAccessoryExpandedChange = useCallback((expanded: boolean) => {
        setQueueAccessoryExpanded(expanded)
    }, [])

    const handleViewTerminal = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId: props.session.id }
        })
    }, [navigate, props.session.id])

    useEffect(() => {
        const wasRunActive = previousGitRunActiveRef.current
        previousGitRunActiveRef.current = runActive
        if (!gitSessionId || !wasRunActive || runActive) return
        void refetchGitStatus()
    }, [gitSessionId, refetchGitStatus, runActive])

    useEffect(() => {
        if (!planStatusVisible && !gitDiffAccessoryVisible) {
            setStatusAccessoryExpanded(false)
        }
    }, [gitDiffAccessoryVisible, planStatusVisible])

    useEffect(() => {
        if (!queueAccessoryVisible) {
            setQueueAccessoryExpanded(false)
        }
    }, [queueAccessoryVisible])

    useLayoutEffect(() => {
        const bottomNode = bottomOverlayRef.current
        const composerNode = composerOverlayRef.current
        const bottomAccessoryNode = bottomAccessoryRef.current
        if (!bottomNode) return

        const measure = () => {
            const bottomHeight = Math.ceil(bottomNode.getBoundingClientRect().height)
            setBottomOverlayHeight((current) => current === bottomHeight ? current : bottomHeight)

            const composerHeight = Math.ceil(composerNode?.getBoundingClientRect().height ?? 0)
            setComposerOverlayHeight((current) => current === composerHeight ? current : composerHeight)

            const accessoryHeight = bottomAccessoryVisible
                ? Math.ceil(bottomAccessoryNode?.getBoundingClientRect().height ?? 0)
                : 0
            setBottomAccessoryHeight((current) => current === accessoryHeight ? current : accessoryHeight)
        }

        measure()
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure)
            return () => window.removeEventListener('resize', measure)
        }

        const observer = new ResizeObserver(measure)
        observer.observe(bottomNode)
        if (composerNode) {
            observer.observe(composerNode)
        }
        if (bottomAccessoryNode) {
            observer.observe(bottomAccessoryNode)
        }
        window.addEventListener('resize', measure)
        return () => {
            observer.disconnect()
            window.removeEventListener('resize', measure)
        }
    }, [bottomAccessoryVisible])

    // Scheduled message state — lifted here so useHappyRuntime can read the ref.
    //
    // pendingSchedule holds what the user selected (preset or absolute ms).
    // The ref is read at send time; resolvePendingSchedule converts it to an
    // absolute epoch-ms using Date.now() at that moment (send-time base for presets).
    const [pendingSchedule, setPendingSchedule] = useState<PendingSchedule | null>(null)
    const pendingScheduleRef = useRef<PendingSchedule | null>(null)
    // Keep render ref in sync so onNew can snapshot at send time
    pendingScheduleRef.current = pendingSchedule

    // Auto-clear absolute-type pendingSchedule when the chosen time expires so
    // the composer clock button doesn't stay active past the scheduled instant.
    // Preset-type schedules are relative so they don't expire until send — the
    // shouldAutoClearPendingSchedule predicate is the single source of truth so
    // adding a new PendingSchedule variant only needs to update that helper.
    useEffect(() => {
        if (!shouldAutoClearPendingSchedule(pendingSchedule)) return
        // Narrowed to 'absolute' by the predicate above.
        const ms = (pendingSchedule as Extract<PendingSchedule, { type: 'absolute' }>).ms
        const remaining = ms - Date.now()
        if (remaining <= 0) {
            setPendingSchedule(null)
            return
        }
        const timer = setTimeout(() => setPendingSchedule(null), remaining)
        return () => clearTimeout(timer)
    }, [pendingSchedule])

    useEffect(() => {
        if (
            dismissedCodexQuickReplyPromptId === null
            || props.sendError?.text !== CODEX_QUICK_REPLY_CONTINUE_TEXT
        ) {
            return
        }
        setDismissedCodexQuickReplyPromptId(null)
    }, [dismissedCodexQuickReplyPromptId, props.sendError?.id, props.sendError?.text])

    const handleSend = useCallback(async (text: string, attachments?: AttachmentMetadata[], scheduledAt?: number | null) => {
        // Route through the scratchlist-aware wrapper. When scratchlistMode
        // is on AND the payload is pure text, this turns into
        // addScratchlistEntry; otherwise it goes to the chat-send wrapper
        // send path). The wrapper resolves true on success either way so
        // the composer-clear is shared, but the schedule-clear / scroll
        // dance below must gate on the actual route taken (not just
        // scratchlistMode), or a scheduled chat send made while the
        // scratchlist toggle is on will leave pendingSchedule sticky and
        // the next normal send would reuse the same schedule. (Per
        // upstream review on PR #798: [Major] "Clear accepted scheduled
        // chat sends after scratchlist fallback".)
        const routedToScratchlist = shouldRouteToScratchlist(scratchlistMode, attachments, scheduledAt)
        const accepted = await onSendForComposer(text, attachments, scheduledAt)
        if (!accepted) return
        if (!routedToScratchlist) {
            // Clear pendingSchedule only after the mutation is actually
            // accepted - covers both pre-mutation guards AND async
            // inactive-session resume failure. SessionChat is the single
            // owner of schedule clear (HappyComposer no longer clears on
            // its own send path). Chat sends already enable latest-message
            // follow through sendChatMessageAndFollow; scratchlist adds do
            // not touch the conversation viewport.
            setPendingSchedule(null)
        }
    }, [onSendForComposer, scratchlistMode])

    const handleCodexQuickReplyContinue = useCallback(async () => {
        const prompt = codexQuickReplyPrompt
        if (!prompt || codexQuickReplySending || prompt.messageId === dismissedCodexQuickReplyPromptId) {
            return
        }

        setCodexQuickReplySending(true)
        try {
            // This deliberately bypasses scratchlist mode: a response to a
            // Codex confirmation question must go back to the Codex chat.
            const accepted = await sendChatMessageAndFollow(CODEX_QUICK_REPLY_CONTINUE_TEXT)
            if (!accepted) {
                return
            }
            setDismissedCodexQuickReplyPromptId(prompt.messageId)
        } finally {
            setCodexQuickReplySending(false)
        }
    }, [codexQuickReplyPrompt, codexQuickReplySending, dismissedCodexQuickReplyPromptId, sendChatMessageAndFollow])

    const attachmentAdapter = useMemo(() => {
        if (!props.session.active) {
            return undefined
        }
        return createAttachmentAdapter(props.api, props.session.id)
    }, [props.api, props.session.id, props.session.active])

    const runtime = useHappyRuntime({
        session: props.session,
        blocks: visibleBlocks,
        isSending: props.isSending,
        isRunning: props.session.thinking || hasRunningChildAgent,
        onSendMessage: handleSend,
        onAbort: handleAbort,
        attachmentAdapter,
        allowSendWhenInactive: true,
        pendingScheduleRef
    })

    // Keep the memoized header independent from message-derived state (usage,
    // goals, etc.). Those values change on nearly every stream event but are
    // not rendered in the header, so passing them through made title actions
    // needlessly compete with timeline rendering.
    const sessionHeaderStatus = useMemo<SessionHeaderStatus>(() => ({
        active: props.session.active,
        thinking: props.session.thinking,
        agentState: props.session.agentState,
        backgroundTaskCount: props.session.backgroundTaskCount,
        voiceStatus: voice?.status
    }), [
        props.session.active,
        props.session.agentState,
        props.session.backgroundTaskCount,
        props.session.thinking,
        voice?.status
    ])

    return (
        <SessionDetailSurface source="hapi" testId="session-chat-surface">
            <SessionHeader
                session={props.session}
                onBack={props.onBack}
                onRefresh={props.onRefresh}
                onToggleFiles={props.session.metadata?.path ? handleToggleFiles : undefined}
                filesActive={false}
                onToggleOutline={handleToggleOutline}
                outlineActive={outlineOpen}
                api={props.api}
                onSessionDeleted={props.onBack}
                onSessionReopened={handleSessionReopened}
                onCreateSideSession={
                    canCreateSideSessionFromSession({
                        agentFlavor,
                        active: props.session.active,
                        controlledByUser,
                        isSideSession: Boolean(props.session.metadata?.sideSession)
                    })
                        ? handleCreateSideSession
                        : undefined
                }
                sideSessionPending={sideSessionPending}
                status={sessionHeaderStatus}
                floating
            />
            <SessionConnectionRecoveryControl />

            {hasFloatingHeaderNotice ? (
                <div
                    className="pointer-events-none absolute inset-x-0 z-10"
                    style={{
                        top: `calc(max(var(--app-safe-area-top), 0.75rem) + ${FLOATING_SESSION_HEADER_HEIGHT_PX}px)`
                    }}
                >
                    <div className="pointer-events-auto">
                        <CursorMigrationBanner metadata={props.session.metadata} />

                        {sideSessionError ? (
                            <div className="px-3 pt-3">
                                <SessionDetailStatusNotice
                                    tone="error"
                                    title={t('session.action.sideSession')}
                                    detail={sideSessionError}
                                    action={{
                                        label: t('button.close'),
                                        onClick: () => setSideSessionError(null)
                                    }}
                                    testId="session-side-session-error"
                                />
                            </div>
                        ) : null}

                        {props.session.teamState ? (
                            <TeamPanel teamState={props.session.teamState} />
                        ) : null}
                    </div>
                </div>
            ) : null}

            <SessionDetailContent ariaLabel={t('settings.chat.title')}>
                <AssistantRuntimeProvider runtime={runtime}>
                    <ShareSeedConsumer sessionId={props.session.id} sessionActive={props.session.active} />
                    <DragDropZone disabled={sessionInactive || props.isSending || pendingSchedule != null}>

                    <HappyThread
                        // Key with prefix: different components under the same session
                        // (thread, scratchlist, composer) must have distinct keys to avoid
                        // React reconciliation issues when switching sessions rapidly.
                        // Without prefixes, React may reuse the wrong component's DOM/localStorage.
                        key={`thread-${props.session.id}`}
                        api={props.api}
                        sessionId={props.session.id}
                        metadata={props.session.metadata}
                        disabled={sessionInactive}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        onFlushPending={props.onFlushPending}
                        onAtBottomChange={props.onAtBottomChange}
                        isLoadingMessages={props.isLoadingMessages}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onLoadMore={props.onLoadMore}
                        pendingCount={props.pendingCount}
                        rawMessagesCount={visibleMessages.length}
                        normalizedMessagesCount={normalizedMessages.length}
                        messagesVersion={threadSnapshot.messagesVersion}
                        toolGroupRunActive={runActive}
                        toolGroupCompletionKey={turnCompletionKey}
                        forceScrollToken={forceScrollToken}
                        outlineOpen={outlineOpen}
                        outlineTitle={outlineTitle}
                        outlineItems={outlineItems}
                        // Keep the first message clear of the title controls,
                        // but let later scrolling content pass under the fully
                        // transparent title shell.
                        topInset={FLOATING_SESSION_HEADER_HEIGHT_PX}
                        // The measured bottom overlay includes the composer
                        // and its iOS home-indicator padding. Reserving that
                        // measured height keeps the latest message visible
                        // without adding a second safe-area strip.
                        bottomInset={threadBottomInset || undefined}
                        scrollButtonBottomInset={scrollButtonBottomInset}
                        bottomAccessoryVisible={bottomAccessoryVisible}
                        bottomAccessoryExpanded={bottomAccessoryExpanded}
                        scrollButtonPositionReady={scrollButtonPositionReady}
                        onOutlineOpenChange={setOutlineOpen}
                        trailingMessage={
                            <ThreadThinkingMessage
                                startedAt={thinkingStartedAt}
                                running={props.session.active && (props.session.thinking || hasThinkingChildAgent || props.isSending)}
                                waitingForUser={Object.keys(props.session.agentState?.requests ?? {}).length > 0 || voice?.status === 'connecting'}
                                hasProcess={currentTurnProcessVisible}
                            />
                        }
                    />

                    {showCodexQuickReply ? (
                        <button
                            type="button"
                            data-testid="codex-quick-reply-continue"
                            aria-label="继续并发送"
                            title="继续"
                            disabled={codexQuickReplySending}
                            aria-busy={codexQuickReplySending}
                            onClick={() => { void handleCodexQuickReplyContinue() }}
                            className="absolute right-3 top-1/2 z-20 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-button)] text-[var(--app-button-text)] shadow-[0_12px_28px_rgba(37,99,235,0.24)] transition-[transform,box-shadow,opacity] duration-150 hover:-translate-y-[55%] hover:shadow-[0_16px_32px_rgba(37,99,235,0.3)] active:-translate-y-1/2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none"
                        >
                            <span aria-hidden="true">
                                <ArrowRightIcon className="h-5 w-5" />
                            </span>
                        </button>
                    ) : null}

                    <SessionDetailBottomDock
                        ref={bottomOverlayRef}
                        bottom={BOTTOM_OVERLAY_INSET_PX}
                    >
                        <div className="pointer-events-auto px-3">
                            {/*
                             * Scratchlist drawer - composer-controlled. Only
                             * mounted when the operator clicks the notepad icon
                             * in the composer toolbar. State lives in the
                             * useScratchlist hook above (so the toolbar counter
                             * and the drawer share one source of truth).
                             */}
                            {scratchlistMode ? (
                                <ScratchlistDrawerHost
                                    entries={scratchlist.entries}
                                    onMove={scratchlist.move}
                                    onDelete={scratchlist.remove}
                                    onSend={sendChatMessageAndFollow}
                                    onExitScratchlistMode={() => setScratchlistMode(false)}
                                />
                            ) : null}
                        </div>

                        <SessionDetailBottomDockComposer
                            ref={composerOverlayRef}
                            testId="session-chat-composer-overlay"
                        >
                            <div className="relative">
                                <HappyComposer
                                key={`composer-${props.session.id}`}
                                sessionId={props.session.id}
                                projectPath={props.session.metadata?.path}
                                disabled={props.isSending}
                                pendingSchedule={pendingSchedule}
                                onSchedule={setPendingSchedule}
                                onClearSchedule={() => setPendingSchedule(null)}
                                showStatusBar={false}
                                permissionMode={props.session.permissionMode}
                                collaborationMode={codexCollaborationModeSupported ? props.session.collaborationMode : undefined}
                                threadGoal={reduced.latestGoal}
                                model={props.session.model}
                                modelReasoningEffort={agentFlavor === 'codex' || agentFlavor === 'opencode' ? props.session.modelReasoningEffort : undefined}
                                effort={props.session.effort}
                                agentFlavor={agentFlavor}
                                availableModelOptions={
                                    agentFlavor === 'codex'
                                        ? codexModelOptions
                                        : agentFlavor === 'cursor'
                                            ? (
                                                cursorCatalogPending
                                                || !cursorPicker
                                                || cursorPicker.modelOptions.length === 0
                                                    ? undefined
                                                    : cursorPicker.modelOptions
                                            )
                                            : agentFlavor === 'opencode'
                                                ? opencodeModelOptions
                                                // Pi uses its own provider-qualified picker (piModels prop).
                                                // Feeding piModelOptions here would make the generic Ctrl/Cmd+M
                                                // cycler (getNextModelForFlavor) post a bare modelId string,
                                                // which loses the provider and can pick the wrong cached
                                                // match or throw in runPi. undefined makes the shortcut a no-op
                                                // so Pi model changes go through the dedicated picker only.
                                                : undefined
                                }
                                piModels={agentFlavor === 'pi' ? (piModelsState.availableModels.length > 0 ? piModelsState.availableModels : piCachedModels) : undefined}
                                piSelectedModel={agentFlavor === 'pi' ? piSelectedModel : undefined}
                                availableModelReasoningEffortOptions={
                                    agentFlavor === 'codex'
                                        ? codexReasoningEffortOptions
                                        : agentFlavor === 'opencode' && opencodeReasoningEffortState.options.length > 0
                                            ? opencodeReasoningEffortState.options
                                            : undefined
                                }
                                active={props.session.active}
                                allowSendWhenInactive
                                inactiveNotice={sessionInactive
                                    ? inactiveCanResume
                                        ? t('session.inactive.composerAutoResume')
                                        : t('session.inactive.composerCannotResume')
                                    : null}
                                thinking={props.session.thinking}
                                agentState={props.session.agentState}
                                backgroundTaskCount={props.session.backgroundTaskCount}
                                contextSize={reduced.latestUsage?.contextSize}
                                contextCacheRead={reduced.latestUsage?.cacheRead}
                                contextWindow={reduced.latestUsage?.contextWindow}
                                controlledByUser={controlledByUser}
                                onCollaborationModeChange={
                                    codexCollaborationModeSupported && props.session.active && !controlledByUser
                                        ? handleCollaborationModeChange
                                        : undefined
                                }
                                onPermissionModeChange={handlePermissionModeChange}
                                selectedModelBase={
                                    agentFlavor === 'cursor' && cursorPicker?.mode === 'dual'
                                        ? cursorSelectedBaseValue
                                        : undefined
                                }
                                selectedModelVariant={
                                    agentFlavor === 'cursor' && !cursorCatalogPending
                                        ? cursorVariantSelectValue
                                        : undefined
                                }
                                modelEffortOptions={
                                    agentFlavor === 'cursor'
                                        && !cursorCatalogPending
                                        && cursorPicker?.mode === 'dual'
                                        && cursorModelEffortOptions
                                        && cursorModelEffortOptions.length > 1
                                        ? cursorModelEffortOptions
                                        : undefined
                                }
                                onModelChange={
                                    agentFlavor === 'codex'
                                        ? (props.session.active && !controlledByUser && !codexModelsState.error ? handleModelChange : undefined)
                                        : agentFlavor === 'cursor'
                                            ? (props.session.active
                                                && !controlledByUser
                                                && !cursorCatalogPending
                                                && !cursorModelsState.error
                                                && cursorPicker
                                                && cursorPicker.modelOptions.length > 0
                                                    ? ((model) => handleCursorBaseModelChange(typeof model === 'string' ? model : model?.modelId ?? null))
                                                    : undefined)
                                            : agentFlavor === 'pi'
                                                ? (props.session.active && !piModelsState.error ? handleModelChange : undefined)
                                                : handleModelChange
                                }
                                onModelEffortChange={
                                    agentFlavor === 'cursor'
                                        && props.session.active
                                        && !controlledByUser
                                        && !cursorCatalogPending
                                        && !cursorModelsState.error
                                        ? handleCursorEffortChange
                                        : undefined
                                }
                                onModelReasoningEffortChange={
                                    (agentFlavor === 'codex' || agentFlavor === 'opencode')
                                        && props.session.active
                                        && !controlledByUser
                                        && (agentFlavor !== 'opencode' || opencodeReasoningEffortState.options.length > 0)
                                        ? handleModelReasoningEffortChange
                                        : undefined
                                }
                                onEffortChange={handleEffortChange}
                                serviceTier={agentFlavor === 'codex' ? props.session.serviceTier : undefined}
                                onServiceTierChange={
                                    agentFlavor === 'codex'
                                        && props.session.active
                                        && !controlledByUser
                                        && !codexModelsState.error
                                        && codexModelAdvertisesFastTier(props.session.model, codexModelsState.models)
                                        ? handleServiceTierChange
                                        : undefined
                                }
                                onSwitchToRemote={handleSwitchToRemote}
                                onTerminal={props.session.active && terminalSupported ? handleViewTerminal : undefined}
                                terminalUnsupported={props.session.active && !terminalSupported}
                                autocompleteSuggestions={props.autocompleteSuggestions}
                                skills={props.skills}
                                skillsLoading={props.skillsLoading}
                                skillsError={props.skillsError}
                                voiceStatus={voice?.status}
                                voiceMicMuted={voice?.micMuted}
                                onVoiceToggle={voice ? handleVoiceToggle : undefined}
                                onVoiceMicToggle={voice && voiceBackendReady ? handleVoiceMicToggle : undefined}
                                scratchlistMode={scratchlistMode}
                                scratchlistCount={scratchlist.entries.length}
                                onScratchlistToggle={handleScratchlistToggle}
                                activeSideSessions={activeSideSessions}
                                onSelectSideSession={handleSelectSideSession}
                                sendError={props.sendError ?? null}
                                onClearSendError={props.onClearSendError}
                            />
                            </div>
                        </SessionDetailBottomDockComposer>

                        {bottomAccessoryVisible ? (
                            <div
                                ref={bottomAccessoryRef}
                                className="pointer-events-none absolute inset-x-0"
                                style={{ bottom: `calc(100% + ${BOTTOM_FLOATING_CONTROL_GAP_PX}px)` }}
                                data-testid={MOBILE_LAYOUT_CONTRACT.bottomAccessory.testId}
                                data-mobile-layout-contract={MOBILE_LAYOUT_CONTRACT.bottomAccessory.state}
                            >
                                <div className="mx-auto flex w-full max-w-content flex-col items-center gap-2">
                                    {planStatusVisible ? (
                                        <PlanStatusSummary
                                            plan={activePlanStatus}
                                            onExpandedChange={handleBottomAccessoryExpandedChange}
                                        />
                                    ) : gitDiffAccessoryVisible ? (
                                        <GitDiffSummary
                                            status={gitDiffDisplayStatus}
                                            onViewDiff={handleViewDiff}
                                            onViewFileDiff={handleViewFileDiff}
                                            onExpandedChange={handleBottomAccessoryExpandedChange}
                                        />
                                    ) : null}

                                    {queueAccessoryVisible ? (
                                        <QueuedMessagesBar
                                            sessionId={props.session.id}
                                            api={props.api}
                                            queuedMessages={queuedMessages}
                                            onExpandedChange={handleQueueAccessoryExpandedChange}
                                            onEdit={(edit) => enqueueQueuedMessageEdit(props.session.id, edit)}
                                        />
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </SessionDetailBottomDock>
                    </DragDropZone>
                </AssistantRuntimeProvider>
            </SessionDetailContent>

            {/* Voice backend is loaded only after the user asks to start voice. */}
            {voice && voiceBackendRequested ? (
                <Suspense fallback={null}>
                    <LazyVoiceBackendSession
                        api={props.api}
                        micMuted={voice.micMuted}
                        onStatusChange={voice.setStatus}
                        onReadyChange={setVoiceBackendReady}
                    />
                </Suspense>
            ) : null}
        </SessionDetailSurface>
    )
}
