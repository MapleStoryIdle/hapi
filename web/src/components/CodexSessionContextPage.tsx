import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useDrawerExitPresence } from '@/hooks/useDrawerExitPresence'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
    CodexLocalSessionSubagent,
    DecryptedMessage,
    AttachmentMetadata,
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
import { SessionGroupDrawer } from '@/components/SessionGroupDrawer'
import { SessionLabelDialog } from '@/components/SessionLabelDialog'
import { resolveSessionGroup, useSessionGroups } from '@/hooks/useSessionGroups'
import { resolveSessionLabel, useSessionLabels } from '@/hooks/useSessionLabels'
import { SessionFilesDrawer } from '@/components/SessionFiles/SessionFilesDrawer'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { GitBranchesDrawer } from '@/components/GitBranchesDrawer'
import { SESSION_DETAIL_HEADER_HEIGHT_PX } from '@/components/SessionDetailHeader'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { HappyComposer, type ComposerSendError } from '@/components/AssistantChat/HappyComposer'
import { PlanStatusSummary, type PlanStatusSummaryData } from '@/components/AssistantChat/PlanStatusSummary'
import { NativeQueuedMessagesBar } from '@/components/NativeQueuedMessagesBar'
import { NativeCodexUserInput } from '@/components/NativeCodexUserInput'
import { NativeAsyncUserInput } from '@/components/NativeAsyncUserInput'
import { getNativeAsyncInputs, getPendingNativeAsyncInput } from '@/chat/nativeAsyncInput'
import { NativeQuestionCards, NativeQuestionSummary } from '@/components/NativeQuestionCards'
import { parseRequestUserInputInput } from '@/components/ToolCard/requestUserInput'
import { buildConversationOutline } from '@/chat/outline'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildSessionDetailTimeline, hasCurrentTurnProcess } from '@/chat/sessionDetailTimeline'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { createNativeCodexAttachmentAdapter } from '@/lib/nativeCodexAttachmentAdapter'
import { makeClientSideId } from '@/lib/messages'
import {
    getNativeCodexDirectMessageScopeKey,
    readNativeCodexDirectMessageEchoes,
    updateNativeCodexDirectMessageEchoes,
    type NativeCodexDirectMessageEcho,
    type NativeCodexDirectMessageScope
} from '@/lib/native-codex-direct-messages'
import { queryKeys } from '@/lib/query-keys'
import { isConfirmedNativeSendRejection, isConfirmedNativeSendRejectionCode } from '@/lib/native-send-outcome'
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
import { NATIVE_FEEDBACK_SILENCE_MS, useNativeFeedbackSilence } from '@/hooks/useNativeFeedbackSilence'
import { useCodexSubscriptionLimits } from '@/hooks/queries/useCodexSubscriptionLimits'
import { useNativeCodexSessionComposerCapabilities } from '@/hooks/queries/useNativeCodexSessionComposerCapabilities'
import { useNativeCodexSessionControls } from '@/hooks/useNativeCodexSessionControls'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useMachineGitBranch } from '@/hooks/queries/useGitBranch'
import { codexModelAdvertisesFastTier } from '@/components/AssistantChat/codexFastMode'
import type { NativeCodexSessionConfiguration, NativeCodexSessionControls, NativeCodexUserInput as PendingNativeInput } from '@hapi/protocol/codexSessionControl'
import {
    parseNativeCodexAttachmentPrompt,
    type NativeCodexAttachment
} from '@hapi/protocol/nativeCodexAttachments'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { SessionDetailContent, SessionDetailSurface } from '@/components/SessionDetailSurface'
import { SessionDetailStatusNotice } from '@/components/SessionDetailStatusNotice'
import { NativeCodexFloatingStatusNotice } from '@/components/NativeCodexFloatingStatusNotice'
import { SessionConversationLoading } from '@/components/SessionEntryLoading'
import { type NativeSendConnectionPhase } from '@/components/NativeSendStatusMessage'
import { ThreadThinkingMessage } from '@/components/ThreadThinkingMessage'
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
const NATIVE_ORPHANED_RECEIPT_GRACE_MS = NATIVE_FEEDBACK_SILENCE_MS
const NATIVE_UNCONFIRMED_RECEIPT_GRACE_MS = 15_000

function areNativeQueueRefsCurrent(
    messages: readonly CodexLocalSessionQueuedMessage[],
    refs: ReadonlyArray<Pick<CodexLocalSessionQueuedMessage, 'id' | 'recoveryRequired' | 'recoveryReason' | 'cancelBlocked'>>
): boolean {
    return messages.length === refs.length && messages.every((message, index) => {
        const ref = refs[index]
        return ref?.id === message.id
            && Boolean(ref.recoveryRequired) === Boolean(message.recoveryRequired)
            && Boolean(ref.cancelBlocked) === Boolean(message.cancelBlocked)
            && ref.recoveryReason === message.recoveryReason
    })
}

export type NativeCodexDirectSendPhase = CodexLocalSessionDirectSendProgress['phase'] | 'queued'

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
    const activeEchoes = input.directMessageEchoes.filter((echo) => echo.status !== 'failed' && !echo.deliveryState)
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

export function hasNativeCodexOutputSince(messages: readonly CodexLocalSessionContextMessage[], startedAt: number): boolean {
    return messages.some((message) => {
        if (message.createdAt < startedAt || message.content.role !== 'agent') return false
        const content = message.content.content as { type?: unknown; data?: { type?: unknown; message?: unknown } }
        if (content?.type !== 'codex') return false
        const data = content.data
        return data?.type === 'tool-call' || data?.type === 'tool-call-result'
            || ((data?.type === 'message' || data?.type === 'message-snapshot' || data?.type === 'reasoning')
                && typeof data.message === 'string' && data.message.trim().length > 0)
    })
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
    return status?.success === true && status.status === 'processing'
        ? NATIVE_CONTEXT_ACTIVE_REFRESH_INTERVAL_MS
        : NATIVE_CONTEXT_REFRESH_INTERVAL_MS
}

function hasActiveNativeCodexSubagent(
    subagents: readonly CodexLocalSessionSubagent[] | undefined
): boolean {
    return subagents?.some((subagent) => (
        subagent.status === 'running' || subagent.status === 'unknown'
    )) ?? false
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
            case 'launch_failed':
                return t('recentCodex.direct.recovery.launchFailedTitle')
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

type NativeCodexUserTextContent = {
    type: 'text'
    text: string
    attachments?: NativeCodexAttachment[]
}

function getNativeCodexUserTextContent(
    message: CodexLocalSessionContextMessage
): NativeCodexUserTextContent | null {
    if (message.content.role !== 'user') return null
    const content = message.content.content
    if (
        !content
        || typeof content !== 'object'
        || !('type' in content)
        || !('text' in content)
        || (content as { type?: unknown }).type !== 'text'
        || typeof (content as { text?: unknown }).text !== 'string'
    ) return null
    return content as NativeCodexUserTextContent
}

function buildReadOnlyCodexMessages(
    messages: readonly CodexLocalSessionContextMessage[]
): DecryptedMessage[] {
    return messages.map((message) => {
        const userTextContent = getNativeCodexUserTextContent(message)
        const content = userTextContent
            ? (() => {
                const parsed = parseNativeCodexAttachmentPrompt(userTextContent.text)
                const nativeAttachments = parsed?.attachments ?? userTextContent.attachments ?? []
                if (!parsed && nativeAttachments.length === 0) return message.content
                const attachments: AttachmentMetadata[] = nativeAttachments.map((attachment) => ({
                    id: attachment.id,
                    filename: attachment.filename,
                    mimeType: attachment.mimeType,
                    size: attachment.size,
                    // A browser display handle only. The local Runner path is
                    // intentionally not present in the native transcript UI.
                    path: `native-codex:${attachment.id}`
                }))
                return {
                    ...message.content,
                    content: {
                        ...userTextContent,
                        text: parsed?.text ?? userTextContent.text,
                        ...(attachments.length > 0 ? { attachments } : {})
                    }
                }
            })()
            : message.content
        return {
            id: message.id,
            seq: (message.position ?? message.createdAt) + 1,
            localId: null,
            content,
            createdAt: message.createdAt
        }
    })
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

function getNativeCodexAttachments(attachments: readonly AttachmentMetadata[] | undefined): AttachmentMetadata[] {
    if (!attachments) return []
    return attachments.filter((attachment) => (
        /^[a-f0-9]{32}$/.test(attachment.id)
        && attachment.path === `native-codex:${attachment.id}`
    ))
}

function nativeAttachmentFallbackText(attachments: readonly AttachmentMetadata[]): string {
    if (attachments.length === 1) return `Attached: ${attachments[0]!.filename}`
    return `Attached ${attachments.length} files`
}

function getNativeUserMessageText(message: CodexLocalSessionContextMessage): string | null {
    const content = getNativeCodexUserTextContent(message)
    if (!content) return null
    return (parseNativeCodexAttachmentPrompt(content.text)?.text ?? content.text).trim()
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
    // Browser/Runner acceptance is only a queue receipt, not a sent message.
    // Keep the receipt for reconciliation; render only Codex acknowledgements.
    return echoes.filter((echo) => echo.deliveryState).map((echo) => ({
        id: echo.id,
        seq: null,
        localId: echo.id,
        content: {
            role: 'user',
            content: {
                type: 'text',
                text: echo.text,
                ...(echo.attachments?.length ? { attachments: echo.attachments } : {})
            }
        },
        createdAt: echo.createdAt,
        status: echo.deliveryState ? 'sent' : echo.status,
        originalText: echo.text
    }))
}

function getNativeCodexSubagentDisplayName(subagent: CodexLocalSessionSubagent): string | null {
    const name = subagent.name?.trim()
    return name || null
}

function buildNativeCodexSubagentInput(subagent: CodexLocalSessionSubagent): Record<string, unknown> {
    const displayName = getNativeCodexSubagentDisplayName(subagent)
    const role = subagent.role?.trim()
    const agentPath = subagent.agentPath?.trim()
    const model = subagent.model?.trim()
    const reasoningEffort = subagent.modelReasoningEffort?.trim()
    return {
        agentId: subagent.id,
        ...(displayName ? { displayName } : {}),
        ...(role ? { agent_type: role } : {}),
        ...(agentPath ? { agent_path: agentPath } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {})
    }
}

/**
 * Translate native child transcript snapshots to the exact `agent-run-*`
 * events consumed by the existing SHAPI CodexAgent reducer. Start timestamps
 * anchor each card to its parent conversation round; later trace/status events
 * update that card without moving it across a user-message boundary.
 */
function buildNativeCodexSubagentMessages(
    subagents: readonly CodexLocalSessionSubagent[]
): DecryptedMessage[] {
    const messages: DecryptedMessage[] = []
    for (const subagent of subagents) {
        const cardId = `native-codex-agent:${subagent.id}`
        const startedAt = subagent.startedAt
        const updateAt = Math.max(startedAt, subagent.completedAt ?? subagent.updatedAt)
        const input = buildNativeCodexSubagentInput(subagent)
        messages.push({
            id: `${cardId}:start`,
            seq: null,
            localId: null,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'agent-run-start',
                        agentId: subagent.id,
                        cardId,
                        input,
                        startedAt,
                        status: 'running',
                        statusText: 'Working',
                        activity: 'Working',
                        activityKind: 'starting'
                    }
                }
            },
            createdAt: startedAt
        })

        for (const [index, trace] of (subagent.traceMessages ?? []).entries()) {
            messages.push({
                id: `${cardId}:trace:${index}`,
                seq: null,
                localId: null,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'agent-run-trace',
                            agentId: subagent.id,
                            cardId,
                            startedAt,
                            message: trace.content.data
                        }
                    }
                },
                createdAt: Math.max(startedAt, trace.createdAt ?? updateAt)
            })
        }

        messages.push({
            id: `${cardId}:update`,
            seq: null,
            localId: null,
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'agent-run-update',
                        agentId: subagent.id,
                        cardId,
                        startedAt,
                        ...(subagent.completedAt === undefined ? {} : { completedAt: subagent.completedAt }),
                        status: subagent.status,
                        statusText: subagent.statusText ?? subagent.status,
                        activity: subagent.statusText ?? subagent.status,
                        activityKind: subagent.status
                    }
                }
            },
            createdAt: updateAt
        })
    }
    return messages
}

function buildCodexBlocksFromDecryptedMessages(messages: readonly DecryptedMessage[]): ChatBlock[] {
    const normalizedMessages: NormalizedMessage[] = []
    for (const message of messages) {
        const normalized = normalizeDecryptedMessage(message)
        if (normalized) normalizedMessages.push(normalized)
    }
    return reduceChatBlocks(normalizedMessages, null).blocks
}

/** Build the transcript plus acknowledged sends awaiting their transcript row. */
export function buildNativeCodexBlocks(
    messages: readonly CodexLocalSessionContextMessage[],
    echoes: readonly NativeDirectMessageEcho[] = [],
    subagents: readonly CodexLocalSessionSubagent[] = [],
    options: { hasMoreMessages?: boolean } = {}
): ChatBlock[] {
    // Snapshots include ALL children, but parent messages are paginated. Without
    // their user-message boundaries, historical cards collapse into one giant
    // orphan group above the loaded conversation. Reveal them with their parent
    // history, using start time (never a late result/update or a local echo).
    const firstLoadedAt = messages.reduce((earliest, message) => Math.min(earliest, message.createdAt), Infinity)
    const visibleSubagents = options.hasMoreMessages
        ? subagents.filter((subagent) => subagent.startedAt >= firstLoadedAt)
        : subagents
    const orderedMessages = [
        ...buildReadOnlyCodexMessages(messages).map((message, index) => ({ message, source: 0, index })),
        ...buildNativeDirectEchoMessages(echoes).map((message, index) => ({ message, source: 1, index })),
        ...buildNativeCodexSubagentMessages(visibleSubagents).map((message, index) => ({ message, source: 2, index }))
    ].sort((left, right) => (
        left.message.createdAt - right.message.createdAt
        || left.source - right.source
        || left.index - right.index
    ))
    return buildCodexBlocksFromDecryptedMessages(orderedMessages.map(({ message }) => message))
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
    model?: string | null
    modelReasoningEffort?: string | null
    tokenUsage?: CodexLocalSessionSnapshotResponse['tokenUsage']
    controls?: NativeCodexSessionControls
    controlPending: 'stop' | 'configure' | 'resumeQueue' | null
    onStop: () => Promise<void>
    onConfigure: (configuration: NativeCodexSessionConfiguration) => void
    onResumeQueue: () => void
    onCancelQueuedMessage?: (message: CodexLocalSessionQueuedMessage) => void
    cancellingQueuedMessage?: boolean
    onRetryQueuedMessage?: () => void
    retryQueuedMessageId?: string
    retryQueuedMessageDisabled?: boolean
    retryingQueuedMessage?: boolean
    onReadOnlyModelInfo?: () => void
    machineId?: string
    title: string
    metadata: SessionMetadataSummary
    messages: readonly CodexLocalSessionContextMessage[]
    directMessageEchoes: readonly NativeDirectMessageEcho[]
    subagents: readonly CodexLocalSessionSubagent[]
    version: number
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => Promise<unknown>
    outlineOpen: boolean
    onOutlineOpenChange: (open: boolean) => void
    isProcessing: boolean
    waitingForUserInput: boolean
    runState: CodexLocalSessionRunState | null
    activeTurnId?: string | null
    plan?: CodexLocalSessionPlan | null
    queuedMessages: readonly CodexLocalSessionQueuedMessage[]
    composerDisabled: boolean
    composerNotice: string | null
    sendError: ComposerSendError | null
    autocompleteSuggestions: (query: string) => Promise<Suggestion[]>
    skills: SkillSummary[]
    skillsLoading: boolean
    skillsError: string | null
    onClearSendError: () => void
    onSendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
    onRefresh: () => void
    forceScrollToken: number
    connectionPhase: NativeSendConnectionPhase | null
    connectionPhaseStartedAt: number | null
    connectionStartedAt?: number
    thinkingStartedAt?: number
    deliveryReceipt?: ReactNode
    pendingInput?: PendingNativeInput | null
    savedAnswerIds: readonly string[]
}) {
    const { t } = useTranslation()
    const asyncInputs = useMemo(() => getNativeAsyncInputs(
        buildReadOnlyCodexMessages(props.messages).map(normalizeDecryptedMessage)
            .filter((message): message is NormalizedMessage => message !== null)
    ), [props.messages])
    const [observedInputs, setObservedInputs] = useState<PendingNativeInput[]>([])
    useEffect(() => {
        if (!props.pendingInput) return
        const input = props.pendingInput
        setObservedInputs((current) => current.some((item) => item.itemId === input.itemId && item.turnId === input.turnId)
            ? current : [...current, input])
    }, [props.pendingInput])
    const questionCards = new Map<string, ReactNode>()
    if (props.machineId) {
        for (const input of asyncInputs) questionCards.set(input.callId, <NativeAsyncUserInput
            key={input.callId} api={props.api} machineId={props.machineId} sessionId={props.sessionId}
            input={input} alreadySaved={props.savedAnswerIds.includes(`native-answer:${input.callId}`)} onRefresh={props.onRefresh}
            autoOpen={!props.pendingInput && input.callId === asyncInputs.at(-1)?.callId}
            queuedReply={props.queuedMessages.find((message) => message.id === `native-answer:${input.callId}`)?.text}
        />)
        for (const input of observedInputs) questionCards.set(input.itemId, <NativeCodexUserInput
            key={`${input.turnId}:${input.itemId}`} api={props.api} machineId={props.machineId} sessionId={props.sessionId}
            input={input} resolved={props.pendingInput === null || Boolean(props.pendingInput && props.pendingInput.itemId !== input.itemId)} onRefresh={props.onRefresh}
        />)
    }
    const modelsState = useCodexModels({ api: props.api, machineId: props.machineId, enabled: props.controls?.canConfigure === true })
    const configurable = props.controls?.canConfigure === true && !modelsState.error && modelsState.models.length > 0
    const configuration = props.controls?.canConfigure ? props.controls.configuration : undefined
    const selectedModel = configuration?.model ?? props.model
    const modelOptions = useMemo(() => modelsState.models.map((model) => ({ value: model.id, label: model.displayName })), [modelsState.models])
    const modelEntry = modelsState.models.find((model) => model.id === selectedModel)
        ?? (!selectedModel ? modelsState.models.find((model) => model.isDefault) : undefined)
    const selectedEffort = configuration?.modelReasoningEffort
        ?? (configuration?.model && configuration.model !== props.model ? modelEntry?.defaultReasoningEffort : props.modelReasoningEffort)
    const effortOptions = modelEntry?.supportedReasoningEfforts?.map((value) => ({ value }))
    const nativeContextSize = props.tokenUsage?.contextTokens
        ?? props.tokenUsage?.lastTurn?.input
        ?? (props.tokenUsage?.scope === 'lastTurn' ? props.tokenUsage.input : undefined)
    const nativeContextCacheRead = props.tokenUsage?.lastTurn?.cachedInput
        ?? (props.tokenUsage?.scope === 'lastTurn' ? props.tokenUsage.cachedInput : undefined)
    const attachmentAdapter = useMemo(
        () => props.machineId
            ? createNativeCodexAttachmentAdapter(props.api, props.sessionId, props.machineId)
            : undefined,
        [props.api, props.machineId, props.sessionId]
    )
    const composerOverlayRef = useRef<HTMLDivElement | null>(null)
    const accessoryOverlayRef = useRef<HTMLDivElement | null>(null)
    const [composerHeight, setComposerHeight] = useState(0)
    const [accessoryHeight, setAccessoryHeight] = useState(0)
    const [queueAccessoryExpanded, setQueueAccessoryExpanded] = useState(false)
    const [planAccessoryExpanded, setPlanAccessoryExpanded] = useState(false)
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const nativeSession = useMemo(() => ({ active: true, thinking: props.isProcessing }), [props.isProcessing])
    const latestTranscriptUserAt = props.messages.findLast((message) => message.content.role === 'user')?.createdAt
    const hasRunningSubagent = props.subagents.some((agent) => agent.status === 'running'
        && (latestTranscriptUserAt === undefined || agent.startedAt >= latestTranscriptUserAt))
    const transcriptBlocks = useMemo(
        () => buildReadOnlyCodexBlocks(props.messages),
        [props.messages]
    )
    const ungroupedBlocks = useMemo(
        () => buildNativeCodexBlocks(props.messages, props.directMessageEchoes, props.subagents, {
            hasMoreMessages: props.hasMoreMessages
        }),
        [props.directMessageEchoes, props.hasMoreMessages, props.messages, props.subagents]
    )
    // Transcript-only questions are read-only. Never create a second native
    // request/approval merely because a historical tool call is visible.
    for (const block of ungroupedBlocks) {
        if (block.kind !== 'tool-call' || block.tool.name !== 'request_user_input' || questionCards.has(block.tool.id)) continue
        const questions = parseRequestUserInputInput(block.tool.input).questions
        if (questions.length) questionCards.set(block.tool.id, <NativeQuestionSummary questions={questions}
            status={t(block.tool.state === 'completed' || block.tool.state === 'error' ? 'recentCodex.input.resolved' : 'recentCodex.status.waitingForLocalInput')} />)
    }
    const latestUserAt = ungroupedBlocks.findLast((block) => block.kind === 'user-text')?.createdAt
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
            aggregateActiveProcess: true,
            activeTurnStartedAt: props.connectionStartedAt ?? props.thinkingStartedAt
        }),
        [props.connectionStartedAt, props.hasMoreMessages, props.isProcessing, props.thinkingStartedAt,
            terminalToolDisplayMode, ungroupedBlocks]
    )
    const blocks = timeline.visible
    const currentTurnStartedAt = Math.max(latestUserAt ?? 0, props.connectionStartedAt ?? props.thinkingStartedAt ?? 0)
    const currentTurnProcessVisible = useMemo(
        () => hasCurrentTurnProcess(timeline.grouped, { minCreatedAt: currentTurnStartedAt || null }),
        [currentTurnStartedAt, timeline.grouped]
    )
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
        // Activity and control capability are separate: unsupported external
        // owners still stream normally, without an actionable stop button.
        isRunning: props.isProcessing,
        onSendMessage: props.onSendMessage,
        onAbort: props.onStop,
        attachmentAdapter
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

    const queueAccessoryVisible = useDrawerExitPresence(props.queuedMessages.length > 0 || props.controls?.queuePaused === true)
    const accessoryVisible = queueAccessoryVisible || nativePlan !== null
    const totalBottomInset = composerHeight + (accessoryHeight > 0 ? accessoryHeight + NATIVE_QUEUE_FLOATING_GAP_PX : 0)

    return (
        <NativeQuestionCards.Provider value={questionCards}>
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
                    trailingMessage={
                        <>
                        {observedInputs.filter((input) => !ungroupedBlocks.some((block) => block.kind === 'tool-call' && block.tool.id === input.itemId))
                            .map((input) => <div key={input.itemId} className="my-3">{questionCards.get(input.itemId)}</div>)}
                        <ThreadThinkingMessage
                            key={props.sessionId}
                            running={props.isProcessing || hasRunningSubagent}
                            waitingForUser={props.waitingForUserInput}
                            hasProcess={currentTurnProcessVisible}
                            // Transport phases still drive queue/recovery logic, but
                            // they are not useful chat content. Show one ordinary
                            // thinking row until the real Process row arrives.
                            phase={props.connectionPhase !== 'connected' ? props.connectionPhase : null}
                            startedAt={props.thinkingStartedAt}
                        />
                        {props.deliveryReceipt}
                        </>
                    }
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
                                disabled={props.composerDisabled || props.controlPending === 'configure'}
                                active
                                agentFlavor="codex"
                                allowGoals={false}
                                showStatusBar={false}
                                readOnlyModelInfo={!configurable}
                                onReadOnlyModelInfo={!configurable ? props.onReadOnlyModelInfo : undefined}
                                canAbort={props.controls?.canStop === true}
                                abortPending={props.controlPending === 'stop' || Boolean(props.controls?.stoppingTurnId)}
                                onAbort={props.onStop}
                                thinking={props.runState === 'processing' && !props.waitingForUserInput && props.connectionPhase === null}
                                model={selectedModel}
                                modelReasoningEffort={selectedEffort}
                                contextSize={nativeContextSize ?? undefined}
                                contextCacheRead={nativeContextCacheRead ?? undefined}
                                contextWindow={props.tokenUsage?.contextWindow ?? null}
                                availableModelOptions={modelOptions}
                                availableModelReasoningEffortOptions={effortOptions}
                                onModelChange={configurable ? (model) => {
                                    const modelId = typeof model === 'string' ? model : model?.modelId ?? null
                                    const nextModel = modelsState.models.find((entry) => modelId ? entry.id === modelId : entry.isDefault)
                                    props.onConfigure({
                                        model: modelId,
                                        // Send the displayed default explicitly: Codex otherwise
                                        // retains the previous turn's reasoning effort.
                                        modelReasoningEffort: nextModel?.defaultReasoningEffort ?? null,
                                        serviceTier: configuration?.serviceTier === 'fast' && codexModelAdvertisesFastTier(modelId, modelsState.models)
                                            ? 'fast' : 'standard'
                                    })
                                } : undefined}
                                onModelReasoningEffortChange={configurable && effortOptions?.length
                                    ? (modelReasoningEffort) => props.onConfigure({ modelReasoningEffort }) : undefined}
                                serviceTier={configuration?.serviceTier}
                                onServiceTierChange={configurable && codexModelAdvertisesFastTier(selectedModel, modelsState.models)
                                    ? (serviceTier) => props.onConfigure({ serviceTier: serviceTier === 'fast' ? 'fast' : 'standard' }) : undefined}
                                allowAttachments={Boolean(attachmentAdapter)}
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
                                        paused={props.controls?.queuePaused}
                                        resuming={props.controlPending === 'resumeQueue'}
                                        resumeDisabled={Boolean(props.controls?.stoppingTurnId) || props.controlPending !== null}
                                        onResume={props.onResumeQueue}
                                        onCancel={props.onCancelQueuedMessage}
                                        cancelling={props.cancellingQueuedMessage}
                                        onRetry={props.onRetryQueuedMessage}
                                        retryMessageId={props.retryQueuedMessageId}
                                        retryDisabled={props.retryQueuedMessageDisabled}
                                        retrying={props.retryingQueuedMessage}
                                    />
                                ) : null}
                            </div>
                        </SessionDetailBottomDockAccessory>
                    ) : null}
                </SessionDetailBottomDock>
            </div>
        </AssistantRuntimeProvider>
        </NativeQuestionCards.Provider>
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
    onRecovered?: (sessionId: string) => void
    onCreateMonitor?: () => void
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
    const [renameOpen, setRenameOpen] = useState(false)
    const renameMutation = useMutation({
        mutationFn: async (request: { sessionId: string; machineId: string; name: string }) => {
            const result = await props.api.renameCodexSession(request.sessionId, request.machineId, request.name)
            if (!result.success) throw new Error(result.error)
            return result
        },
        onSuccess: async (result, request) => {
            const key = queryKeys.codexSessionSnapshot(request.machineId, request.sessionId)
            await queryClient.cancelQueries({ queryKey: key })
            queryClient.setQueryData<CodexLocalSessionSnapshotResponse>(key, (current) => current
                ? { ...current, session: { ...current.session, title: result.name } }
                : current)
        }
    })
    const [forkError, setForkError] = useState<string | null>(null)
    const [isRecoveringControl, setIsRecoveringControl] = useState(false)
    const [recoverControlError, setRecoverControlError] = useState<string | null>(null)
    const [recoveryControlRequestId, setRecoveryControlRequestId] = useState<string | null>(null)
    const recoveryControlAttemptIdRef = useRef<string | null>(null)
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
        // A native realtime payload updates this cache directly. A thread
        // merely being loaded by Desktop SSH is not activity and must not
        // force a full snapshot every second. A processing parent, however,
        // can spawn a child which then writes only its own rollout file; keep
        // the conditional snapshot alive to discover and refresh those cards.
        refetchInterval: (query) => {
            const snapshot = query.state.data as CodexLocalSessionSnapshotResponse | undefined
            const status = snapshot?.status
            if (hasActiveNativeCodexSubagent(snapshot?.subagents)) {
                return NATIVE_CONTEXT_ACTIVE_REFRESH_INTERVAL_MS
            }
            if (hasRealtimeUpdates) {
                return status?.success === true && status.status === 'processing'
                    ? NATIVE_CONTEXT_ACTIVE_REFRESH_INTERVAL_MS
                    : false
            }
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
    const nativeControls = useNativeCodexSessionControls({
        api: props.api, sessionId: props.sessionId, machineId: props.machineId, status: statusQuery.data
    })
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
    const [directSendError, setDirectSendError] = useState<(ComposerSendError & { clientMessageId?: string }) | null>(null)
    const [dismissedRunnerError, setDismissedRunnerError] = useState<string | null>(null)
    const [connectionNow, setConnectionNow] = useState(() => Date.now())
    const [outlineOpen, setOutlineOpen] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const [gitBranchesOpen, setGitBranchesOpen] = useState(false)
    const [filesOpen, setFilesOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState({ x: 0, y: 0 })
    const pageScopeRef = useRef(pageScope)
    const nativeDirectMessageScopeKeyRef = useRef(nativeDirectMessageScopeKey)
    const nativeDirectMessagePageMountedRef = useRef(true)
    // A successful discard is authoritative even if an older status response
    // arrives after it. Keep its receipt hidden until the next page scope.
    const discardedNativeRecoveryIdsRef = useRef(new Set<string>())
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
        discardedNativeRecoveryIdsRef.current.clear()
        setOutlineOpen(false)
        setMenuOpen(false)
        setRenameOpen(false)
        connectionRecoveryTokenRef.current += 1
    }, [nativeDirectMessageScope, nativeDirectMessageScopeKey, props.machineId, props.sessionId])

    useEffect(() => {
        const response = statusQuery.data
        if (response?.success === true) {
            const queuedMessages = Array.isArray(response.queuedMessages)
                ? response.queuedMessages.filter((message) => !discardedNativeRecoveryIdsRef.current.has(message.id))
                : null
            // Do not clear a locally confirmed queue from a response produced
            // by an older runner (or from the short processing window before
            // the runner has published its queue). Once the native turn is
            // idle, an explicit empty array is authoritative and clears it.
            if (queuedMessages) {
                setNativeQueuedMessages((current) => {
                    const visibleCurrent = current.filter(
                        (message) => !discardedNativeRecoveryIdsRef.current.has(message.id)
                            && message.id !== response.activeClientMessageId
                    )
                    return queuedMessages.length === 0
                        && visibleCurrent.length > 0
                        && response.status !== 'idle'
                        ? visibleCurrent
                        : queuedMessages
                })
            }
            const queuedMessageIds = new Set(queuedMessages?.map((message) => message.id) ?? [])
            const deliveryReceipts = new Map(response.deliveryReceipts?.map((receipt) => [receipt.id, receipt.state]))
            const discardedExternalWriterEchoId = response.lastErrorCode === 'external_writer_active'
                ? response.lastErrorClientMessageId ?? null
                : null
            updateNativeDirectMessageEchoes(nativeDirectMessageScope, (current) => {
                if (discardedExternalWriterEchoId && current.some((echo) => echo.id === discardedExternalWriterEchoId
                    && !echo.deliveryState && !deliveryReceipts.has(echo.id))) {
                    // A writer conflict is reported before turn/start, so the
                    // optimistic bubble is known not to exist in Codex.
                    return current.filter((echo) => echo.id !== discardedExternalWriterEchoId)
                }
                let changed = false
                const failedEchoIndex = response.lastError
                    && isConfirmedNativeSendRejectionCode(response.lastErrorCode)
                    && response.lastErrorClientMessageId
                    ? current.reduce((latest, echo, index) => (
                        echo.id === response.lastErrorClientMessageId
                        && !queuedMessageIds.has(echo.queueId ?? echo.id)
                        && response.activeClientMessageId !== echo.id
                        && echo.status !== 'failed'
                            ? index
                            : latest
                    ), -1)
                    : -1
                const activeEchoIndex = response.activeClientMessageId
                    ? current.findIndex((echo) => echo.id === response.activeClientMessageId)
                    : -1
                const next = current.map((echo, index) => {
                    const receipt = deliveryReceipts.get(echo.id)
                    if (receipt || echo.deliveryState) {
                        const deliveryState = echo.deliveryState === 'delivered' ? 'delivered' : receipt ?? echo.deliveryState
                        const deliveryPhase = response.activeClientMessageId === echo.id && response.progress
                            ? response.progress.phase : echo.deliveryPhase
                        const phaseStartedAt = response.activeClientMessageId === echo.id && response.progress
                            ? response.progress.phaseStartedAt : echo.phaseStartedAt
                        if (echo.deliveryState === deliveryState && echo.status === 'queued'
                            && echo.deliveryPhase === deliveryPhase && echo.phaseStartedAt === phaseStartedAt) return echo
                        changed = true
                        return { ...echo, status: 'queued' as const, deliveryState, deliveryPhase, phaseStartedAt }
                    }
                    if (queuedMessageIds.has(echo.queueId ?? echo.id)) {
                        if (echo.status === 'queued' && echo.deliveryPhase === 'queued') return echo
                        changed = true
                        return { ...echo, status: 'queued' as const, deliveryPhase: 'queued' as const, queueId: echo.queueId ?? echo.id }
                    }
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
                        && response.activeClientMessageId === echo.id
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
                            status: 'queued' as const,
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
    const pendingAsyncInput = useMemo(() => getPendingNativeAsyncInput(
        buildReadOnlyCodexMessages(messages).map(normalizeDecryptedMessage)
            .filter((message): message is NormalizedMessage => message !== null)
    ), [messages])
    const visibleNativeDirectMessageEchoes = useMemo(
        () => getVisibleNativeDirectMessageEchoes(currentNativeDirectMessageEchoes, messages),
        [currentNativeDirectMessageEchoes, messages]
    )
    const transcriptConfirmedNativeDirectMessageIds = useMemo(() => {
        const visibleIds = new Set(visibleNativeDirectMessageEchoes.map((echo) => echo.id))
        return new Set(currentNativeDirectMessageEchoes
            .filter((echo) => !visibleIds.has(echo.id))
            .map((echo) => echo.id))
    }, [currentNativeDirectMessageEchoes, visibleNativeDirectMessageEchoes])
    // Once a local echo has been reconciled, actually remove it from state.
    // Otherwise it could reappear after its transcript row eventually rolls
    // out of the latest 50-message context page.
    useEffect(() => {
        updateNativeDirectMessageEchoes(nativeDirectMessageScope, (current) => {
            const next = getVisibleNativeDirectMessageEchoes(current, messages)
            return next.length === current.length ? current : next
        })
    }, [messages, nativeDirectMessageScope, updateNativeDirectMessageEchoes])
    useEffect(() => {
        const status = statusQuery.data?.success === true ? statusQuery.data : null
        setDirectSendError((current) => {
            if (!current?.clientMessageId) return current
            const id = current.clientMessageId
            const confirmed = transcriptConfirmedNativeDirectMessageIds.has(id)
                || status?.deliveryReceipts?.some((receipt) => receipt.id === id)
                || currentNativeDirectMessageEchoes.some((echo) => echo.id === id && echo.deliveryState)
                || status?.activeClientMessageId === id
                || status?.queuedMessages?.some((message) => message.id === id && !message.recoveryRequired)
            return confirmed ? null : current
        })
    }, [currentNativeDirectMessageEchoes, statusQuery.data, transcriptConfirmedNativeDirectMessageIds])
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
    // `controlledByCodexSsh` means the same Desktop SSH app-server has this
    // thread loaded. It is now a shared transport, not an input lock: SHAPI
    // can enqueue while that Codex turn is busy and send on the same channel
    // once it becomes idle.
    const sshControlled = controlledByCodexSsh === true
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
        ? statusQuery.data.queuedMessages.filter((message) => !discardedNativeRecoveryIdsRef.current.has(message.id))
        : null
    const activeNativeClientMessageId = statusQuery.data?.success === true ? statusQuery.data.activeClientMessageId : undefined
    const canRecoverControl = Boolean(
        props.machineId
        && contextQuery.data?.version
        && directStatus === 'unknown'
        && nativeStalledSince !== null
        && statusQuery.data?.success === true
        && statusQuery.data.waitingForUserInput !== true
        && !statusQuery.data.activeTurnId
        && statusQuery.data.controlledByCodexSsh === false
        && (statusQuery.data.queuedMessages?.length ?? 0) === 0
        && statusQuery.data.controls?.queuePaused !== true
        && !statusQuery.data.controls?.stoppingTurnId
        && nativeControls.pendingAction === null
    )
    const acknowledgedNativeMessageIds = useMemo(() => new Set([
        ...currentNativeDirectMessageEchoes.filter((echo) => echo.deliveryState).map((echo) => echo.id),
        ...(statusQuery.data?.success === true ? statusQuery.data.deliveryReceipts?.map((receipt) => receipt.id) ?? [] : [])
    ]), [currentNativeDirectMessageEchoes, statusQuery.data])
    const reconciledNativeQueuedMessages = useMemo(() => {
        const runnerQueueIds = new Set(runnerQueuedMessages?.map((message) => message.id) ?? [])
        return nativeQueuedMessages.filter((message) => (
            message.id !== activeNativeClientMessageId
            && (!acknowledgedNativeMessageIds.has(message.id) || runnerQueueIds.has(message.id))
            && (!transcriptConfirmedNativeDirectMessageIds.has(message.id) || runnerQueueIds.has(message.id))
        ))
    }, [acknowledgedNativeMessageIds, activeNativeClientMessageId, nativeQueuedMessages, runnerQueuedMessages, transcriptConfirmedNativeDirectMessageIds])
    // A native transcript echo is stronger proof than the browser-local queue
    // placeholder. Clear that placeholder as soon as the original message is
    // visible, unless the runner still explicitly reports the same receipt as
    // queued. Otherwise a long-running successful turn can be mislabeled as
    // "stuck" five minutes later.
    useEffect(() => {
        if (transcriptConfirmedNativeDirectMessageIds.size === 0) return
        const runnerQueueIds = new Set(runnerQueuedMessages?.map((message) => message.id) ?? [])
        setNativeQueuedMessages((current) => {
            const next = current.filter((message) => (
                !transcriptConfirmedNativeDirectMessageIds.has(message.id)
                || runnerQueueIds.has(message.id)
            ))
            return next.length === current.length ? current : next
        })
    }, [runnerQueuedMessages, transcriptConfirmedNativeDirectMessageIds])
    const nativeRecoveryCandidate = useMemo(() => {
        if (directStatusErrorCode === 'external_writer_active') {
            // The runner knows the bridge was rejected before turn/start, so
            // this is not an uncertain delivery and must not block reading or
            // offer a retry for the discarded optimistic message.
            return { candidate: null, uncertain: false, reason: null }
        }
        const runnerQueueIds = new Set(runnerQueuedMessages?.map((message) => message.id) ?? [])
        const recoveryRequired = reconciledNativeQueuedMessages.find((message) => message.recoveryRequired)
        const staleQueued = nativeStalledSince !== null ? reconciledNativeQueuedMessages[0] : null
        const runnerFailedEcho = directStatusErrorCode && directStatusErrorClientMessageId
            && directStatusErrorClientMessageId !== activeNativeClientMessageId
            ? currentNativeDirectMessageEchoes.find((echo) => echo.id === directStatusErrorClientMessageId && !acknowledgedNativeMessageIds.has(echo.id)) ?? null
            : null
        // Older runners can explicitly reject a send while their transcript
        // state is unknown. Preserve that browser receipt as manual-only
        // recovery: failed + queued with no runner queue id is never eligible
        // for the short implicit resend window.
        const rejectedUnknownStatusEcho = currentNativeDirectMessageEchoes.find((echo) => (
            echo.status === 'failed'
            && !acknowledgedNativeMessageIds.has(echo.id)
            && echo.deliveryPhase === 'queued'
            && echo.queueId === null
        )) ?? null
        const failedEcho = runnerFailedEcho ?? rejectedUnknownStatusEcho
        const orphanedQueued = runnerQueuedMessages
            ? reconciledNativeQueuedMessages.find((message) => (
                !runnerQueueIds.has(message.id)
                && connectionNow - message.queuedAt >= NATIVE_ORPHANED_RECEIPT_GRACE_MS
            ))
            : null
        const orphanedEcho = currentNativeDirectMessageEchoes.find((echo) => (
                !acknowledgedNativeMessageIds.has(echo.id) && echo.id !== activeNativeClientMessageId && (
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
            )))
        const queued = recoveryRequired ?? staleQueued ?? orphanedQueued
        const matchingEcho = queued
            ? currentNativeDirectMessageEchoes.find((echo) => echo.id === queued.id) ?? null
            : orphanedEcho ?? failedEcho
        const id = queued?.id ?? orphanedEcho?.id ?? failedEcho?.id ?? null
        const reason = recoveryRequired?.recoveryReason
            ?? (nativeStalledSince !== null ? 'codex_timeout' : null)
            ?? (failedEcho ? (rejectedUnknownStatusEcho ? 'session_status_unknown' : directStatusErrorCode) : null)
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
                deliveryText: matchingEcho?.deliveryText ?? matchingEcho?.text ?? queued?.text ?? '',
                ...(matchingEcho?.attachments?.length ? { attachments: matchingEcho.attachments } : {})
            },
            uncertain: Boolean(recoveryRequired || orphanedQueued || orphanedEcho || failedEcho),
            reason
        }
    }, [
        connectionNow,
        acknowledgedNativeMessageIds,
        activeNativeClientMessageId,
        currentNativeDirectMessageEchoes,
        directStatusErrorClientMessageId,
        directStatusErrorCode,
        reconciledNativeQueuedMessages,
        nativeStalledSince,
        runnerQueuedMessages
    ])
    const codexLimitsState = useCodexSubscriptionLimits({
        api: props.api,
        machineId: props.machineId,
        cwd: context?.session.cwd,
        provider: context?.modelProvider,
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
                            session: event.summary?.id === current.session.id
                                ? { ...current.session, title: event.summary.title }
                                : current.session,
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
                    session: event.summary?.id === current.session.id
                        ? { ...current.session, title: event.summary.title }
                        : current.session,
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
    const hasNativeQueuedMessages = reconciledNativeQueuedMessages.length > 0
    const isSendingDirect = pendingDirectSendCount > 0
    const nativeNeedsManualRecovery = nativeRecoveryCandidate.candidate !== null
        && (nativeStalledSince !== null || nativeRecoveryCandidate.uncertain)
    const canRecoverNativeDelivery = nativeRecoveryCandidate.candidate !== null
        && directStatus === 'idle'
        && (reconciledNativeQueuedMessages.length === 0
            || reconciledNativeQueuedMessages[0]?.id === nativeRecoveryCandidate.candidate.id)
        && nativeControls.controls?.queuePaused !== true
        && !nativeControls.controls?.stoppingTurnId
        && nativeControls.pendingAction === null
    // Browser-only receipts can outlive a Runner restart. Keep them reachable
    // in the queue, not as apparently sent messages in the conversation.
    const displayedNativeQueue = useMemo(() => {
        const result = [...reconciledNativeQueuedMessages]
        const ids = new Set(result.map((message) => message.id))
        for (const echo of visibleNativeDirectMessageEchoes) {
            if (ids.has(echo.id) || (echo.queueId && ids.has(echo.queueId))
                || acknowledgedNativeMessageIds.has(echo.id) || echo.id === activeNativeClientMessageId) continue
            const recovery = nativeRecoveryCandidate.candidate?.id === echo.id
            if (echo.deliveryPhase !== 'queued' && !recovery) continue
            result.push({
                id: echo.id, text: echo.text, queuedAt: echo.createdAt,
                ...(recovery ? { recoveryRequired: true, recoveryReason: nativeRecoveryCandidate.reason ?? undefined } : {}),
                // A browser-only receipt is not proof that a hand-off stopped.
                cancelBlocked: !recovery
            })
        }
        return result
    }, [reconciledNativeQueuedMessages, visibleNativeDirectMessageEchoes, acknowledgedNativeMessageIds,
        activeNativeClientMessageId, nativeRecoveryCandidate])
    const deliveryProgress = statusQuery.data?.success === true ? statusQuery.data.progress : null
    // Repeated polls/heartbeats are not new feedback. Track transcript and
    // delivery changes instead, scoped to this page and the latest prompt.
    const latestEcho = currentNativeDirectMessageEchoes.at(-1)
    const feedbackIsQuiet = useNativeFeedbackSilence(JSON.stringify([
        nativeDirectMessageScopeKey,
        contextQuery.data?.version,
        contextQuery.data?.revision,
        contextQuery.data?.messages.at(-1)?.id,
        directStatus,
        nativeWaitingForUserInput,
        statusQuery.isError,
        deliveryProgress?.startedAt,
        deliveryProgress?.phase,
        deliveryProgress?.phaseStartedAt,
        latestEcho?.id,
        latestEcho?.deliveryPhase,
        latestEcho?.phaseStartedAt,
        pendingDirectSendCount,
        reconciledNativeQueuedMessages.map((message) => message.id)
    ]), connectionNow)
    const confirmedLaunchFailure = nativeRecoveryCandidate.reason === 'launch_failed'
    // Presentation only: uncertain receipts still require explicit recovery;
    // hiding a warning must never authorize an implicit resend.
    const showNativeRecoveryNotice = nativeNeedsManualRecovery && confirmedLaunchFailure
    const showUnconfirmedReceipt = nativeNeedsManualRecovery && !confirmedLaunchFailure
        && !nativeWaitingForUserInput && feedbackIsQuiet
    const recoveryTitle = t(confirmedLaunchFailure
        ? 'recentCodex.direct.recovery.launchFailedTitle'
        : 'recentCodex.direct.recovery.title')
    const directSendPhase = getNativeCodexDirectSendPhase({
        pendingDirectSendCount,
        queuedMessages: reconciledNativeQueuedMessages,
        directMessageEchoes: visibleNativeDirectMessageEchoes,
        runState: directStatus,
        progress: statusQuery.data?.success === true ? statusQuery.data.progress ?? null : null,
        hasAgentReply: deliveryProgress
            ? hasNativeCodexOutputSince(messages, deliveryProgress.startedAt)
            : hasNativeCodexAgentReply(messages)
    })
    const directSendPhaseStartedAt = getNativeCodexDirectSendPhaseStartedAt({
        phase: directSendPhase,
        progress: statusQuery.data?.success === true ? statusQuery.data.progress ?? null : null,
        directMessageEchoes: visibleNativeDirectMessageEchoes
    })
    const connectionStartedAt = (directSendPhase === 'launching' ? directSendPhaseStartedAt ?? undefined : undefined)
        ?? deliveryProgress?.startedAt
        ?? visibleNativeDirectMessageEchoes.find((echo) => echo.status !== 'failed' && echo.deliveryPhase !== 'queued')?.createdAt
    const hasCurrentOutput = connectionStartedAt !== undefined && hasNativeCodexOutputSince(messages, connectionStartedAt)
    const connectionPhase: NativeSendConnectionPhase | null = isForking || nativeNeedsManualRecovery || nativeWaitingForUserInput
        || directSendPhase === 'queued' || hasCurrentOutput
        ? null : directSendPhase === 'reasoning'
            ? connectionStartedAt === undefined ? null : 'connected'
            : directSendPhase
    const isNativeProcessing = isSendingDirect
        || directStatus === 'processing'
        || (directSendPhase !== null && directSendPhase !== 'queued')
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
    const composerNotice = showNativeRecoveryNotice
        ? getNativeRecoveryDetail(
            nativeRecoveryCandidate.reason,
            nativeRecoveryCandidate.uncertain,
            t
        )
        : nativeWaitingForUserInput
            ? t('recentCodex.status.waitingForLocalInput')
            : isNativeProcessing
                ? directStatus === 'processing'
                    ? sshControlled
                        ? t('recentCodex.sshControl.queueing')
                        : t('recentCodex.direct.processing')
                    : null
        : isNativeQueueWaiting
            ? t('recentCodex.status.queued')
            : directStatus === 'idle'
                ? null
                : directStatus === 'unknown'
                    ? feedbackIsQuiet ? t('recentCodex.direct.unknown') : null
                    : statusQuery.isLoading
                        ? t('recentCodex.direct.checking')
                        : statusQuery.isError || directStatus === null
                            ? feedbackIsQuiet ? t('recentCodex.direct.statusFailed') : null
                            : null
    const showRunnerError = isConfirmedNativeSendRejectionCode(directStatusErrorCode)
        && Boolean(directStatusErrorClientMessageId)
        && visibleNativeDirectMessageEchoes.some((echo) => (
            echo.id === directStatusErrorClientMessageId && echo.status === 'failed'
        ))
    const visibleRunnerError = !showRunnerError || directStatusError === dismissedRunnerError ? null : directStatusError
    const composerSendError = directSendError ?? (visibleRunnerError
        ? {
            id: statusQuery.data?.success === true ? statusQuery.data.lastErrorAt ?? 0 : 0,
            text: '',
            message: visibleRunnerError,
            scheduledAt: null
        }
        : null)

    const nativeAgentStatusClass = nativeConnectionHealth === 'offline'
        ? 'bg-[#FF3B30]'
        : nativeConnectionHealth === 'degraded' || nativeConnectionHealth === 'recovering'
            ? 'bg-[#FF9500] animate-pulse'
            : nativeNeedsManualRecovery
                ? 'bg-[#FF9500] animate-pulse'
            : nativeWaitingForUserInput
                ? 'bg-[#FF9500] animate-pulse'
            : isNativeProcessing
                ? 'bg-[#007AFF] animate-pulse'
                : 'bg-[#34C759]'

    const title = context?.session.title ?? t('recentCodex.context.title')
    const nativeGitProjectPath = context?.session.cwd ?? null
    const { isGitRepository } = useMachineGitBranch(
        props.api,
        props.machineId ?? null,
        nativeGitProjectPath,
        true,
        { refetchInterval: false }
    )
    const groupsQuery = useSessionGroups(props.api)
    const labelsQuery = useSessionLabels(props.api)
    const groupSource = useMemo(() => ({ type: 'native-codex' as const, machineId: props.machineId ?? '', codexSessionId: props.sessionId }), [props.machineId, props.sessionId])
    const sessionGroup = resolveSessionGroup(groupsQuery.data, groupSource)
    const sessionLabel = resolveSessionLabel(labelsQuery.data, groupSource)
    const [groupOpen, setGroupOpen] = useState(false)
    const [labelOpen, setLabelOpen] = useState(false)
    const openGroup = useCallback(() => setGroupOpen(true), [])
    const openLabel = useCallback(() => setLabelOpen(true), [])
    const sessionDetails = useMemo<SessionHeaderDetail[]>(() => buildSessionHeaderDetails({
        group: sessionGroup,
        onSetGroup: props.machineId ? openGroup : undefined,
        label: sessionLabel,
        onSetLabel: props.machineId ? openLabel : undefined,
        title,
        sessionId: props.sessionId,
        projectPath: context?.session.cwd,
        lastActivityAt: context?.session.modifiedAt,
        agentFlavor: 'codex',
        model: context?.session.model,
        reasoning: context?.session.modelReasoningEffort
    }, t), [sessionGroup, sessionLabel, openGroup, openLabel, props.machineId, context?.session.cwd, context?.session.model, context?.session.modelReasoningEffort, context?.session.modifiedAt, props.sessionId, t, title])

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

    const recoverControl = useCallback(async () => {
        const version = contextQuery.data?.version
        if (!props.machineId || !version || !canRecoverControl || isRecoveringControl) return
        const recoveryRequestId = recoveryControlAttemptIdRef.current ?? crypto.randomUUID()
        recoveryControlAttemptIdRef.current = recoveryRequestId
        setIsRecoveringControl(true)
        setRecoverControlError(null)
        try {
            const response = await props.api.recoverCodexSessionControl(props.sessionId, {
                machineId: props.machineId,
                recoveryRequestId,
                expectedVersion: version
            })
            if (!response.success) throw new Error(response.error)
            if (response.status === 'ready' && response.sessionId) {
                props.onRecovered?.(response.sessionId)
            } else {
                setRecoveryControlRequestId(response.recoveryRequestId)
                if (response.status === 'unconfirmed') {
                    setRecoverControlError(t('recentCodex.recoverControl.unconfirmed'))
                }
            }
        } catch (error) {
            setRecoverControlError(error instanceof Error ? error.message : t('recentCodex.recoverControl.failed'))
        } finally {
            setIsRecoveringControl(false)
        }
    }, [canRecoverControl, contextQuery.data?.version, isRecoveringControl, props.api, props.machineId, props.onRecovered, props.sessionId, t])

    useEffect(() => {
        if (!recoveryControlRequestId || !props.machineId) return
        const machineId = props.machineId
        let disposed = false
        let timer: number | null = null
        const poll = async () => {
            try {
                const response = await props.api.getCodexSessionControlRecovery(props.sessionId, machineId)
                if (disposed) return
                if (!response.success) {
                    setRecoverControlError(response.error)
                } else if (response.status === 'ready' && response.sessionId) {
                    setRecoveryControlRequestId(null)
                    props.onRecovered?.(response.sessionId)
                    return
                } else if (response.status === 'unconfirmed') {
                    setRecoverControlError(t('recentCodex.recoverControl.unconfirmed'))
                } else {
                    setRecoverControlError(null)
                }
            } catch (error) {
                if (disposed) return
                setRecoverControlError(error instanceof Error ? error.message : t('recentCodex.recoverControl.failed'))
            }
            if (!disposed) timer = window.setTimeout(() => void poll(), 2_000)
        }
        timer = window.setTimeout(() => void poll(), 750)
        return () => {
            disposed = true
            if (timer !== null) window.clearTimeout(timer)
        }
    }, [props.api, props.machineId, props.onRecovered, props.sessionId, recoveryControlRequestId, t])

    useEffect(() => {
        recoveryControlAttemptIdRef.current = null
        setRecoveryControlRequestId(null)
        setRecoverControlError(null)
    }, [props.machineId, props.sessionId])

    const recoverNativeDelivery = useCallback(async () => {
        const candidate = nativeRecoveryCandidate.candidate
        if (!props.machineId || !candidate || !canRecoverNativeDelivery || isRecoveringNativeDelivery) {
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
                forceRecovery: true,
                ...(candidate.attachments?.length ? {
                    attachmentIds: candidate.attachments.map((attachment) => attachment.id)
                } : {})
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
                message.id !== candidate.id || message.deliveryState
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
            const rejected = isConfirmedNativeSendRejection(error, { recovery: true })
            updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                message.id === candidate.id
                    ? message.status === 'queued' || message.deliveryState ? message : {
                        ...message,
                        status: rejected ? 'failed' as const : 'sending' as const,
                        deliveryPhase: 'matching' as const,
                        phaseStartedAt: Date.now()
                    }
                    : message
            )))
            if (pageScopeRef.current === requestScope) {
                if (rejected && readNativeCodexDirectMessageEchoes(requestNativeDirectMessageScope)
                    .some((echo) => echo.id === candidate.id && echo.status === 'failed')) setDirectSendError({
                    id: Date.now(),
                    clientMessageId: candidate.id,
                    text: candidate.text,
                    message: formatDirectSendError(error, t),
                    scheduledAt: null
                })
                void refetchNativeSnapshot()
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
        t,
        updateNativeDirectMessageEchoes
    ])

    const discardNativeRecovery = useCallback(async (queuedMessage?: CodexLocalSessionQueuedMessage) => {
        const candidate = queuedMessage ?? nativeRecoveryCandidate.candidate
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
            if (response.discarded !== true) {
                if (pageScopeRef.current === requestScope) {
                    setDirectSendError({
                        id: Date.now(),
                        text: candidate.text,
                        message: response.active === true
                            ? t('recentCodex.direct.recovery.discardActive')
                            : t('recentCodex.direct.recovery.discardFailed'),
                        scheduledAt: null
                    })
                    void refetchNativeSnapshot()
                }
                return
            }
            updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => (
                current.filter((message) => message.id !== candidate.id)
            ))
            if (pageScopeRef.current !== requestScope) {
                return
            }
            discardedNativeRecoveryIdsRef.current.add(candidate.id)
            setNativeQueuedMessages(response.queuedMessages.filter(
                (message) => !discardedNativeRecoveryIdsRef.current.has(message.id)
            ))
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

    const sendDirectMessage = useCallback((text: string, rawAttachments?: AttachmentMetadata[]) => {
        if (!props.machineId || directStatus === null || directStatus === 'unknown') {
            return
        }
        const attachments = getNativeCodexAttachments(rawAttachments)
        const displayText = text.trim() || (attachments.length > 0 ? nativeAttachmentFallbackText(attachments) : '')
        if (!displayText) return
        const deliveryText = expandCodexCustomPrompt(displayText, nativeComposerCapabilities.commands) ?? displayText
        const requestScope = pageScope
        const requestNativeDirectMessageScope = nativeDirectMessageScope
        const echoId = makeClientSideId('native')
        const createdAt = Date.now()
        const echo: NativeDirectMessageEcho = {
            id: echoId,
            text: displayText,
            ...(deliveryText !== displayText ? { deliveryText } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
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
        // Save the receipt before the round trip. Only a Codex delivery
        // acknowledgement/transcript will promote it into the conversation.
        updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => [...current, echo])
        setNativeForceScrollToken((token) => token + 1)
        setPendingDirectSendCount((count) => count + 1)
        setDirectSendError(null)
        setDismissedRunnerError(null)
        void (async () => {
            try {
                const response = await props.api.sendCodexSessionMessage(props.sessionId, {
                    machineId: props.machineId!,
                    message: deliveryText,
                    ...(deliveryText === displayText ? {} : { displayMessage: displayText }),
                    clientMessageId: echoId,
                    ...(attachments.length > 0 ? { attachmentIds: attachments.map((attachment) => attachment.id) } : {})
                })
                if (response.success !== true) {
                    throw new ApiError(response.error, 409, response.code)
                }
                updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => current.map((message) => (
                    message.id !== echoId || message.deliveryState
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
                        { id: response.queueId!, text: displayText, queuedAt: response.queuedAt! }
                    ])
                }
                // The accepted post already tells us whether it is running or
                // queued. Let the push update/background read reconcile the
                // transcript without blocking another message from being sent.
                void refetchNativeSnapshot()
            } catch (error) {
                const needsVerification = !isConfirmedNativeSendRejection(error)
                const rejectedByExternalWriter = error instanceof ApiError
                    && error.code === 'external_writer_active'
                const rejectedByUnknownStatus = error instanceof ApiError
                    && error.code === 'session_status_unknown'
                if (!needsVerification && attachments.length > 0) {
                    void Promise.all(attachments.map((attachment) => (
                        props.api.deleteCodexSessionAttachment(props.sessionId, props.machineId!, attachment.id)
                    ))).catch(() => {})
                }
                // A transport timeout is not proof that Codex rejected the
                // prompt. Retain a pending receipt while the status stream
                // checks it, then expose explicit recovery rather than
                // creating a second prompt with a new client id.
                updateNativeDirectMessageEchoes(requestNativeDirectMessageScope, (current) => (
                    rejectedByExternalWriter
                        ? current.filter((message) => message.id !== echoId || message.deliveryState)
                        : current.map((message) => (
                            message.id !== echoId || message.status === 'queued' || message.deliveryState
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
                if (!needsVerification && !rejectedByExternalWriter
                    && readNativeCodexDirectMessageEchoes(requestNativeDirectMessageScope)
                        .some((echo) => echo.id === echoId && echo.status === 'failed')) {
                    setDirectSendError({
                        id: Date.now(),
                        clientMessageId: echoId,
                        text: displayText,
                        message: formatDirectSendError(error, t),
                        scheduledAt: null
                    })
                }
                if (needsVerification || rejectedByExternalWriter || rejectedByUnknownStatus) {
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
        t,
        updateNativeDirectMessageEchoes
    ])

    // Saved receipts are reconciled by GET/SSE after navigation. Never POST
    // again without a deliberate recovery action: delivery may have succeeded.

    return (
        <SessionConnectionProvider value={nativeConnectionContext}>
            <SessionDetailSurface source="codex" testId="codex-session-context-page">
                <SessionGroupDrawer key={`group:${props.machineId}:${props.sessionId}`} api={props.api} source={groupSource} open={groupOpen} onOpenChange={setGroupOpen} />
                <SessionLabelDialog api={props.api} source={groupSource} currentLabel={sessionLabel} open={labelOpen} onOpenChange={setLabelOpen} />
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
                                account={codexLimitsState.account}
                                usage={context?.tokenUsage}
                                onRefresh={() => { codexLimitsState.refresh(); void refetchNativeSnapshot() }}
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
                    onRename={props.machineId && context ? () => setRenameOpen(true) : undefined}
                    onGitBranches={isGitRepository ? () => setGitBranchesOpen(true) : undefined}
                    onToggleFiles={props.machineId && nativeGitProjectPath ? () => setFilesOpen(true) : undefined}
                    onFork={() => void fork()}
                        forkLabel={t('session.action.fork')}
                    forkPendingLabel={t('recentCodex.forking')}
                    forkPending={isForking}
                    forkDisabled={!canFork}
                    onCreateMonitor={props.onCreateMonitor}
                    anchorPoint={menuAnchorPoint}
                    menuId={menuId}
                />
                <RenameSessionDialog
                    isOpen={renameOpen}
                    onClose={() => setRenameOpen(false)}
                    currentName={title}
                    onRename={async (name) => {
                        if (!props.machineId) throw new Error(t('recentCodex.runnerRequired'))
                        await renameMutation.mutateAsync({ sessionId: props.sessionId, machineId: props.machineId, name })
                    }}
                    isPending={renameMutation.isPending}
                />
                <GitBranchesDrawer
                    api={props.api}
                    machineId={props.machineId ?? null}
                    cwd={nativeGitProjectPath}
                    open={gitBranchesOpen}
                    onOpenChange={setGitBranchesOpen}
                />
                {props.machineId && nativeGitProjectPath ? <SessionFilesDrawer key={`${props.machineId}:${props.sessionId}`} api={props.api}
                    source={{ type: 'native-codex', sessionId: props.sessionId, machineId: props.machineId }} cwd={nativeGitProjectPath}
                    open={filesOpen} onOpenChange={setFilesOpen} /> : null}
                <SessionConnectionRecoveryControl
                    labels={{
                        degraded: t('session.connection.native.degraded'),
                        recovering: t('session.connection.native.recovering'),
                        offline: t('session.connection.native.offline'),
                        recover: t('session.connection.native.recover')
                    }}
                />

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
                    <NativeCodexFloatingStatusNotice
                        tone="error"
                        title={t('recentCodex.fork.failed.title')}
                        detail={forkError}
                        action={{
                            label: t('recentCodex.retry'),
                            onClick: () => void fork(),
                            disabled: !canFork
                        }}
                        noticeKey={`fork-error:${forkError}`}
                        statusLabel={t('recentCodex.fork.failed.title')}
                        testId="codex-fork-error"
                    />
                ) : showNativeRecoveryNotice ? (
                    <NativeCodexFloatingStatusNotice
                        tone="warning"
                        title={recoveryTitle}
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
                        noticeKey={[
                            'native-recovery',
                            nativeRecoveryCandidate.reason,
                            nativeRecoveryCandidate.uncertain,
                            isRecoveringNativeDelivery,
                            isDiscardingNativeRecovery
                        ].join(':')}
                        statusLabel={recoveryTitle}
                        testId="codex-native-recovery"
                    />
                ) : nativeWaitingForUserInput && !pendingAsyncInput && !(statusQuery.data?.success && statusQuery.data.pendingUserInput) ? (
                    <NativeCodexFloatingStatusNotice
                        tone="warning"
                        title={t('recentCodex.status.waitingForLocalInput')}
                        detail={t('recentCodex.status.waitingForLocalInput.detail')}
                        noticeKey="waiting-for-local-input"
                        statusLabel={t('recentCodex.status.waitingForLocalInput')}
                        testId="codex-native-waiting-for-local-input"
                    />
                ) : feedbackIsQuiet && (directStatus === 'unknown' || statusQuery.isError) ? (
                    <NativeCodexFloatingStatusNotice
                        tone="warning"
                        title={directStatus === 'unknown' ? t('recentCodex.status.unknown') : t('recentCodex.status.failed')}
                        detail={recoverControlError ?? (recoveryControlRequestId
                            ? t('recentCodex.recoverControl.pendingDetail')
                            : canRecoverControl
                                ? t('recentCodex.recoverControl.detail')
                                : t('recentCodex.status.locked'))}
                        action={recoveryControlRequestId ? {
                            label: t('recentCodex.recoverControl.pending'),
                            onClick: () => {},
                            busy: true
                        } : canRecoverControl ? {
                            label: isRecoveringControl ? t('recentCodex.recoverControl.pending') : t('recentCodex.recoverControl.action'),
                            onClick: () => void recoverControl(),
                            busy: isRecoveringControl
                        } : {
                            label: t('recentCodex.retry'),
                            onClick: () => void refetchNativeSnapshot(),
                            busy: statusQuery.isFetching
                        }}
                        noticeKey={directStatus === 'unknown' ? 'status-unknown' : 'status-failed'}
                        statusLabel={directStatus === 'unknown' ? t('recentCodex.status.unknown') : t('recentCodex.status.failed')}
                        testId="codex-status-error"
                    />
                ) : null}

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
                            key={`${props.machineId}:${props.sessionId}`}
                            pendingInput={statusQuery.data?.success ? statusQuery.data.pendingUserInput ?? null : undefined}
                            savedAnswerIds={statusQuery.data?.success ? [
                                ...(statusQuery.data.queuedMessages ?? []).map((message) => message.id),
                                ...(statusQuery.data.deliveryReceipts ?? []).map((receipt) => receipt.id)
                            ] : []}
                            api={props.api}
                            sessionId={props.sessionId}
                            projectPath={context.session.cwd}
                            model={context.session.model}
                            modelReasoningEffort={context.session.modelReasoningEffort}
                            tokenUsage={context.tokenUsage}
                            controls={nativeControls.controls}
                            controlPending={nativeControls.pendingAction === 'answerUserInput' ? null : nativeControls.pendingAction}
                            onStop={nativeControls.stop}
                            onConfigure={nativeControls.configure}
                            onResumeQueue={nativeControls.resumeQueue}
                            onCancelQueuedMessage={(message) => void discardNativeRecovery(message)}
                            cancellingQueuedMessage={isDiscardingNativeRecovery}
                            onRetryQueuedMessage={() => void recoverNativeDelivery()}
                            retryQueuedMessageId={nativeRecoveryCandidate.candidate?.id}
                            retryQueuedMessageDisabled={!canRecoverNativeDelivery || isDiscardingNativeRecovery}
                            retryingQueuedMessage={isRecoveringNativeDelivery}
                            onReadOnlyModelInfo={sshControlled ? nativeControls.explainSharedConfiguration : undefined}
                            machineId={props.machineId}
                            title={title}
                            metadata={nativeMetadata}
                            messages={messages}
                            directMessageEchoes={visibleNativeDirectMessageEchoes.filter((echo) =>
                                !displayedNativeQueue.some((queued) => queued.id === echo.id || queued.id === echo.queueId))}
                            subagents={context.subagents ?? []}
                            version={contextQuery.dataUpdatedAt + olderPages.length + nativeForceScrollToken}
                            hasMoreMessages={hasMoreMessages}
                            isLoadingMoreMessages={isLoadingMore}
                            onLoadMore={loadMore}
                            outlineOpen={outlineOpen}
                            onOutlineOpenChange={setOutlineOpen}
                            isProcessing={isNativeProcessing}
                            waitingForUserInput={nativeWaitingForUserInput}
                            runState={directStatus}
                            activeTurnId={statusQuery.data?.success === true
                                ? statusQuery.data.activeTurnId ?? null
                                : null}
                            plan={context?.plan ?? null}
                            queuedMessages={displayedNativeQueue}
                            connectionPhase={connectionPhase}
                            connectionPhaseStartedAt={directSendPhaseStartedAt}
                            connectionStartedAt={connectionStartedAt}
                            thinkingStartedAt={statusQuery.data?.success === true && statusQuery.data.status === 'processing'
                                ? statusQuery.data.startedAt : undefined}
                            deliveryReceipt={showUnconfirmedReceipt ? (
                                <details key={nativeRecoveryCandidate.candidate?.id} data-testid="codex-native-recovery" data-receipt-state="unconfirmed" className="px-3 py-2 text-sm text-[var(--app-hint)]">
                                    <summary className="cursor-pointer min-h-11 content-center">{t('recentCodex.direct.receipt.details')}</summary>
                                    <p>{t('recentCodex.direct.receipt.unconfirmed')}</p>
                                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                                        <button type="button" className="min-h-11 text-[var(--app-link)]" onClick={() => void refetchNativeSnapshot()} disabled={statusQuery.isFetching}>{t('recentCodex.direct.receipt.refresh')}</button>
                                        <button type="button" className="min-h-11 text-[var(--app-link)] disabled:opacity-50" onClick={() => void recoverNativeDelivery()} disabled={!canRecoverNativeDelivery || isRecoveringNativeDelivery || isDiscardingNativeRecovery}>{t('recentCodex.direct.receipt.resend')}</button>
                                        <button type="button" className="min-h-11" onClick={() => void discardNativeRecovery()} disabled={isDiscardingNativeRecovery}>{t('recentCodex.direct.recovery.discard')}</button>
                                    </div>
                                </details>
                            ) : null}
                            composerDisabled={composerDisabled}
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
            </SessionDetailSurface>
        </SessionConnectionProvider>
    )
}
