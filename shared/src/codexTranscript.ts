import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
    createCodexUserMessageMirrorDeduper,
    normalizeCodexUserMessageContent,
    normalizeCodexUserMessageText
} from './codexUserMessage'
import type { CodexLocalSessionSnapshotVersion } from './codexSnapshot'
export type { CodexLocalSessionSnapshotVersion } from './codexSnapshot'
import { parseAutomationHeartbeatMessageContent } from './messages'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'
import { isHttpForbiddenError } from './utils'
import type { SlashCommand } from './apiTypes'

export type CodexLocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    /** Latest model configuration observed in a native turn context. */
    model?: string | null
    /** Latest reasoning-effort configuration observed in a native turn context. */
    modelReasoningEffort?: string | null
    /** Last native turn lifecycle observed while scanning this transcript. */
    runState?: CodexLocalSessionRunState
    /**
     * A local Codex `request_user_input` call is still awaiting an answer on
     * the originating machine. This is deliberately parallel to runState:
     * native delivery must continue to treat the session as processing.
     */
    waitingForUserInput?: boolean
    /** Explicit current Codex Desktop SSH ownership; false clears a stale UI lock. */
    controlledByCodexSsh?: boolean
}

/** Runner-to-browser list update; the local transcript path stays private. */
export type CodexLocalSessionListUpdate = Omit<CodexLocalSessionSummary, 'file'>

/** Small metadata that may change while a transcript revision stays stable. */
export type CodexLocalSessionDisplaySummary = Pick<
    CodexLocalSessionSummary,
    'id' | 'title' | 'cwd' | 'modifiedAt' | 'model' | 'modelReasoningEffort' | 'controlledByCodexSsh'
>

export type CodexLocalSessionConfig = {
    model: string | null
    modelReasoningEffort: string | null
}

export type CodexLocalSessionListOptions = {
    /** Exclude threads created through SHAPI's Codex app-server client. */
    excludeHapiInitiated?: boolean
}

/**
 * Codex persists the app-server client's `clientInfo.name` as the transcript
 * originator. Keep this in one place so the runner and hub apply the same
 * definition of a SHAPI-initiated thread.
 */
export const HAPI_CODEX_ORIGINATOR = 'hapi-codex-client'

export type CodexLocalSessionContextMessage = {
    role: 'user' | 'assistant'
    text: string
}

export type CodexImportedMessageContent = {
    /** Original Codex rollout timestamp, in milliseconds. */
    createdAt?: number
    role: 'user'
    content: {
        type: 'text'
        text: string
    }
    meta: {
        sentFrom: 'cli'
    }
} | {
    /** Original Codex rollout timestamp, in milliseconds. */
    createdAt?: number
    role: 'agent'
    content: {
        type: typeof AGENT_MESSAGE_PAYLOAD_TYPE
        data: unknown
    }
    meta: {
        sentFrom: 'cli'
    }
}

/**
 * A direct child Codex thread discovered from a native parent transcript.
 * Child rollout files are intentionally kept out of the regular native
 * session list, but an opened parent can present their progress as the same
 * Codex-agent cards used by SHAPI-owned sessions.
 */
export type CodexLocalSessionSubagent = {
    /** Native child thread id; never render this as the human-facing label. */
    id: string
    parentSessionId: string
    /** Codex collaboration nickname, when the native transcript provides one. */
    name?: string | null
    /** Native collaboration role / specialization, when present. */
    role?: string | null
    /** Raw native agent path retained for diagnostics; never a card label by itself. */
    agentPath?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    /** The UI intentionally reduces this to running vs terminal card states. */
    status: 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'
    statusText?: string | null
    startedAt: number
    updatedAt: number
    completedAt?: number
    /** Bounded child transcript records for the existing agent detail dialog. */
    traceMessages: CodexImportedMessageContent[]
}

export type CodexTranscriptImportData = CodexLocalSessionSummary & {
    messages: CodexImportedMessageContent[]
}

export type CodexLocalSessionPage = {
    limit: number
    nextBefore: number | null
    hasMore: boolean
}

export type CodexLocalSessionReadOptions = {
    /** Exclusive message index for loading older transcript entries. */
    before?: number
    limit?: number
}

/** Options for a conditional native Codex transcript snapshot read. */
export type CodexLocalSessionSnapshotReadOptions = CodexLocalSessionReadOptions & {
    /** Conditional matching is valid only for the canonical latest-50 page. */
    knownVersion?: CodexLocalSessionSnapshotVersion
}

export type CodexLocalSessionData = {
    session: CodexLocalSessionSummary
    context: CodexLocalSessionContextMessage[]
    importedMessages: CodexImportedMessageContent[]
    /** Direct native Codex children, separate from parent pagination. */
    subagents: CodexLocalSessionSubagent[]
    startIndex: number
    page: CodexLocalSessionPage
}

/** Runner-side read information used to identify cache effectiveness. */
export type CodexLocalSessionReadTiming = {
    cache: 'hit' | 'miss'
    durationMs: number
}

export type CodexLocalSessionsRpcResponse = {
    success: true
    sessions: CodexLocalSessionSummary[]
} | {
    success: false
    error: string
}

export type CodexLocalSessionDataRpcResponse = {
    success: true
    data: CodexLocalSessionData
} | {
    success: false
    error: string
}

/**
 * The native Codex transcript records task lifecycle events. A missing
 * lifecycle is deliberately "unknown" rather than assumed idle: direct
 * delivery must never race an already-running native turn.
 */
export type CodexLocalSessionRunState = 'idle' | 'processing' | 'unknown'

/** Turn-scoped native records used by the runner's local lifecycle overlay. */
export type CodexTranscriptLifecycleEvent = {
    type: 'task_started' | 'task_complete' | 'turn_aborted' | 'task_failed'
    turnId?: string
}

/**
 * A plan explicitly emitted by Codex's native `update_plan` tool. This is
 * intentionally separate from imported chat messages so a bounded detail
 * page does not lose the current plan when its original tool call is older
 * than the latest message window.
 */
export type CodexLocalSessionPlanStep = {
    text: string
    status: 'pending' | 'in_progress' | 'completed'
}

export type CodexLocalSessionPlan = {
    turnId: string
    callId: string
    steps: CodexLocalSessionPlanStep[]
}

/**
 * Minimal routing state for the native `request_user_input` primitive. The
 * parser intentionally never retains arguments or tool output.
 */
export type CodexTranscriptUserInputEvent = {
    type: 'requested' | 'resolved'
    requestId: string
    turnId?: string
} | {
    /** Ordered turn boundaries prevent a completed cold tail from reopening a wait. */
    type: 'turn_started' | 'turn_terminal'
    turnId?: string
}

export type CodexTranscriptUserInputState = {
    seen: boolean
    waiting: boolean
}

/**
 * Runner-owned progress for a prompt sent into an original native Codex
 * thread. The stages deliberately describe the hand-off, not model output.
 */
export type CodexLocalSessionDirectSendPhase =
    | 'launching'
    | 'matching'
    | 'connected'
    /** The primary bridge failed before delivery, so SHAPI is trying its exact-thread fallback. */
    | 'retrying'
    | 'reasoning'

export type CodexLocalSessionDirectSendProgress = {
    phase: CodexLocalSessionDirectSendPhase
    /** One stable clock for the whole hand-off, including fallback transport. */
    startedAt: number
    /** Lets clients show the duration of the currently visible stage. */
    phaseStartedAt: number
    /** Ordered, bounded stages for this hand-off; survives coalesced status updates. */
    history?: Array<{ phase: CodexLocalSessionDirectSendPhase; startedAt: number }>
    transport: 'app-server' | 'exec-resume'
    /** Present after SHAPI switches from the primary bridge to its safe fallback. */
    attempt?: number
}

/** Why a saved native prompt needs explicit recovery instead of a silent replay. */
export type CodexLocalSessionDirectSendRecoveryReason =
    | 'codex_timeout'
    | 'session_status_unknown'
    | 'launch_failed'
    | 'runner_restarted'
    /** Another Codex client owns this original thread; no prompt was delivered. */
    | 'external_writer_active'

export type CodexLocalSessionStatusRpcResponse = {
    success: true
    status: CodexLocalSessionRunState
    /** Current native turn identity only; plan contents stay in snapshot RPC. */
    activeTurnId?: string
    /** Native Codex is blocked on an answer in its own local UI. */
    waitingForUserInput?: boolean
    /** Explicit current Codex Desktop SSH ownership; false clears a stale UI lock. */
    controlledByCodexSsh?: boolean
    /**
     * The native transcript still says a turn is running but has not changed
     * for a long time. This is only a recovery hint: SHAPI never retries a
     * prompt until the person explicitly asks it to.
     */
    stalledSince?: number
    /** Present while the runner owns a direct native send for this thread. */
    startedAt?: number
    /** Present while the runner can describe its native direct-send hand-off. */
    progress?: CodexLocalSessionDirectSendProgress
    /** Short runner-side launch/exit failure, if the most recent send failed. */
    lastError?: string
    /** Runner timestamp for `lastError`, used to associate a browser receipt safely. */
    lastErrorAt?: number
    /** Browser receipt that caused `lastError`, when the runner knows it. */
    lastErrorClientMessageId?: string
    /** Stable UI-safe category for the latest native delivery failure. */
    lastErrorCode?: CodexLocalSessionDirectSendRecoveryReason
    /** Messages waiting for the native thread to become idle. */
    queuedMessages?: CodexLocalSessionQueuedMessage[]
} | {
    success: false
    error: string
}

/** Queue identity carried by global realtime invalidations; message text stays in snapshot RPC. */
export type CodexLocalSessionRealtimeQueuedMessage = Pick<
    CodexLocalSessionQueuedMessage,
    'id' | 'recoveryRequired' | 'recoveryReason'
>

export type CodexLocalSessionRealtimeStatus = Omit<
    Extract<CodexLocalSessionStatusRpcResponse, { success: true }>,
    'queuedMessages'
> & {
    queuedMessageRefs?: CodexLocalSessionRealtimeQueuedMessage[]
}

/** Capabilities that can safely be presented in an original native thread. */
export type CodexLocalSessionComposerCapabilities = {
    /** Custom prompts only. SHAPI-owned control commands cannot alter a native thread. */
    commands: SlashCommand[]
    skills: Array<{
        name: string
        description?: string
        scope: 'project' | 'user' | 'plugin' | 'system' | 'admin'
    }>
}

export type CodexLocalSessionComposerCapabilitiesRpcResponse = {
    success: true
    commands: CodexLocalSessionComposerCapabilities['commands']
    skills: CodexLocalSessionComposerCapabilities['skills']
} | {
    success: false
    error: string
}

export type CodexLocalSessionSnapshot = {
    data: CodexLocalSessionData
    status: Extract<CodexLocalSessionStatusRpcResponse, { success: true }>
    /** Present on full snapshot responses from current runners. */
    plan?: CodexLocalSessionPlan | null
    /** Opaque version for conditional reads and realtime invalidations. */
    version: CodexLocalSessionSnapshotVersion
    /** Kept alongside `version` for compact display and older consumers. */
    revision: number
    timing: CodexLocalSessionReadTiming
}

export type CodexLocalSessionSnapshotRpcResponse = {
    success: true
    unchanged: false
    snapshot: CodexLocalSessionSnapshot
} | {
    /** The known `{ runnerEpoch, revision }` still describes the transcript page. */
    success: true
    unchanged: true
    version: CodexLocalSessionSnapshotVersion
    revision: number
    /** Small display metadata can change independently from the transcript. */
    session?: CodexLocalSessionDisplaySummary
    status: Extract<CodexLocalSessionStatusRpcResponse, { success: true }>
    timing: CodexLocalSessionReadTiming
} | {
    success: false
    error: string
}

/**
 * Bounded transcript state sent by the runner only for a browser that has
 * already opened this native thread. It deliberately excludes the local
 * transcript path and other runner-only metadata.
 */
export type CodexLocalSessionRealtimeSnapshot = {
    /** Opaque version only; transcript bodies travel through snapshot RPC. */
    version: CodexLocalSessionSnapshotVersion
    revision: number
    status: CodexLocalSessionRealtimeStatus
    timing: CodexLocalSessionReadTiming
}

export type CodexLocalSessionQueuedMessage = {
    id: string
    text: string
    queuedAt: number
    /**
     * A prior runner stopped after accepting this prompt and before it could
     * prove delivery. Keep it visible, but require an explicit retry because
     * the original Codex turn may already have received it.
     */
    recoveryRequired?: boolean
    /** Why this saved prompt cannot be replayed silently. */
    recoveryReason?: CodexLocalSessionDirectSendRecoveryReason
}

/** Internal runner policy for prompts generated by a SHAPI Kanban review. */
export type NativeCodexDeliveryPolicy = 'default' | 'untrusted-review'

/**
 * Runner-owned integrity capability for an untrusted Kanban review. It names
 * a single staged file and digest only; feedback bytes never travel through
 * the generic native-message RPC or durable outbox.
 */
export type NativeKanbanFeedbackReviewGuard = {
    stagePath: string
    sha256: string
}

export type SendCodexLocalSessionMessageRpcResponse = {
    success: true
    status: 'processing' | 'queued'
    /** Present when the request started a Codex child immediately. */
    startedAt?: number
    /** Present when the runner started a direct native app-server bridge. */
    progress?: CodexLocalSessionDirectSendProgress
    /** Present when the request waits behind an existing native turn. */
    queuedAt?: number
    queuePosition?: number
    queueId?: string
    queuedMessages?: CodexLocalSessionQueuedMessage[]
} | {
    success: false
    error: string
    code: 'session_not_found' | 'session_busy' | 'session_status_unknown' | 'workspace_unavailable' | 'invalid_message' | 'invalid_client_message_id' | 'launch_failed' | 'queue_full' | 'not_native_session' | 'external_writer_active'
}

/**
 * Removes a saved native hand-off receipt from the runner outbox. This never
 * stops an original Codex turn that might already have received the prompt.
 */
export type DiscardCodexLocalSessionMessageRpcResponse = {
    success: true
    /** False when the runner no longer owns this receipt. The browser may still drop its local copy. */
    discarded: boolean
    /** True when the requested receipt may still belong to an active Codex turn. */
    active?: boolean
    queuedMessages: CodexLocalSessionQueuedMessage[]
} | {
    success: false
    error: string
    code: 'session_not_found' | 'invalid_client_message_id' | 'launch_failed' | 'not_native_session'
}

/**
 * Archives an original Codex thread through the Codex app-server. This is a
 * destructive stop-and-archive action: the runner reserves it against SHAPI
 * delivery and protects saved SHAPI queue receipts while Codex performs it.
 */
export type ArchiveCodexLocalSessionRpcResponse = {
    success: true
} | {
    success: false
    error: string
    code:
        | 'session_not_found'
        | 'not_native_session'
        | 'session_busy'
        | 'session_status_unknown'
        | 'session_queued'
        | 'archive_in_progress'
        | 'archive_unsupported'
        | 'archive_failed'
        | 'external_writer_active'
}

export type CodexTranscriptFileCandidate = {
    file: string
    modifiedAt: number
    size: number
}

const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 500
const MAX_CODEX_CONTEXT_MESSAGES = 2_000
const MAX_CODEX_CONTEXT_MESSAGE_CHARS = 24_000
const MAX_CODEX_PLAN_STEPS = 32
const MAX_CODEX_PLAN_STEP_CHARS = 600
const MAX_CODEX_PLAN_ID_LENGTH = 512
const MAX_CODEX_SUBAGENT_TRACE_MESSAGES = 160
const MAX_CODEX_SUBAGENT_TRACE_BYTES = 1024 * 1024
const MAX_CODEX_SUBAGENT_TRACE_PAYLOAD_BYTES = 64 * 1024
const MAX_CODEX_SUBAGENTS_TRACE_PAYLOAD_BYTES = 1024 * 1024
// Session lists only need metadata from the transcript header and latest
// records. Large historical transcripts must not be fully loaded just to
// render a row in the native-session list.
const CODEX_SESSION_SUMMARY_FULL_READ_MAX_BYTES = 512 * 1024
const CODEX_SESSION_SUMMARY_WINDOW_BYTES = 64 * 1024
// Codex writes its injected environment before the first real prompt. That
// preamble is often larger than the regular list-summary header, so allow a
// bounded second header read solely to recover the thread title.
const CODEX_SESSION_TITLE_HEAD_MAX_BYTES = 256 * 1024

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

function getCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim()
    if (!configured) {
        return join(homedir(), '.codex')
    }
    return resolveLocalPath(configured.replace(/^~(?=$|[\\/])/, homedir()))
}

function collectJsonlFiles(root: string, files: CodexTranscriptFileCandidate[]): void {
    if (!existsSync(root)) return
    let entries
    try {
        entries = readdirSync(root, { withFileTypes: true })
    } catch {
        return
    }

    for (const entry of entries) {
        const fullPath = join(root, entry.name)
        if (entry.isDirectory()) {
            collectJsonlFiles(fullPath, files)
            continue
        }
        if (!entry.isFile() || !fullPath.toLowerCase().endsWith('.jsonl')) continue
        try {
            const stats = statSync(fullPath)
            files.push({ file: fullPath, modifiedAt: stats.mtimeMs, size: stats.size })
        } catch {
            // The transcript can disappear while Codex rotates sessions.
        }
    }
}

function extractCodexText(value: unknown): string {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                const record = asRecord(item)
                if (record?.type === 'text' && typeof record.text === 'string') return record.text
                if (record?.type === 'input_text' && typeof record.text === 'string') return record.text
                if (record?.type === 'output_text' && typeof record.text === 'string') return record.text
                return null
            })
            .filter((part): part is string => Boolean(part))
            .join(' ')
            .trim()
    }
    const record = asRecord(value)
    if (record?.type === 'text' && typeof record.text === 'string') return record.text.trim()
    if (record?.type === 'input_text' && typeof record.text === 'string') return record.text.trim()
    if (record?.type === 'output_text' && typeof record.text === 'string') return record.text.trim()
    return ''
}

function truncateText(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function isStandaloneUrlReference(value: string): boolean {
    const line = value.trim()
    if (/^<?https?:\/\/\S+>?$/i.test(line)) return true

    const markdownLink = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i.exec(line)
    return markdownLink !== null && /^https?:\/\//i.test(markdownLink[1].trim())
}

/**
 * Turn a raw Codex thread title (normally its first user prompt) into the
 * compact, human-readable label used by a session list. A standalone URL is
 * context, not a useful session name, so prefer the following text line.
 */
export function getCodexSessionDisplayTitle(value: string, maxLength = 80): string {
    const lines = value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    const preferred = lines.find((line) => !isStandaloneUrlReference(line)) ?? lines[0] ?? ''
    return truncateText(preferred.replace(/\s+/g, ' '), maxLength)
}

function getCodexRolloutTimestampKey(value: string | null): string | null {
    if (!value) return null
    const milliseconds = Date.parse(value)
    // event_msg and response_item are emitted by separate streams and can
    // differ by a few milliseconds for the same user-visible turn.
    return Number.isFinite(milliseconds) ? String(Math.round(milliseconds / 1_000)) : value
}

/**
 * Codex can continue one thread in a rotated rollout file such as
 * `rollout-...-<thread-id>_<turn-id>.jsonl`. The first UUID remains the
 * thread id; any later UUID belongs to the rollover turn.
 */
export function getCodexSessionIdFromTranscriptFilePath(filePath: string): string | null {
    const fileName = filePath.split(/[\\/]/).pop() ?? ''
    if (!/^rollout-.+\.jsonl$/i.test(fileName)) return null

    const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(fileName)
    return match?.[1] ?? null
}

function parseCodexFunctionArguments(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
    try {
        return JSON.parse(trimmed)
    } catch {
        return value
    }
}

function extractCodexToolCallId(payload: Record<string, unknown>): string | null {
    const candidates = ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id']
    for (const key of candidates) {
        const value = payload[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

/** Read only a turn routing id; never retain surrounding tool content. */
function extractCodexTurnId(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
    const turn = asRecord(payload.turn)
    const scope = asRecord(payload.scope)
    const passthrough = asRecord(payload.internal_chat_message_metadata_passthrough)
    return asString(
        payload.turn_id
        ?? payload.turnId
        ?? turn?.id
        ?? turn?.turn_id
        ?? turn?.turnId
        ?? scope?.turn_id
        ?? scope?.turnId
        ?? passthrough?.turn_id
        ?? passthrough?.turnId
        ?? record.turn_id
        ?? record.turnId
    )
}

function normalizeCodexPlanIdentifier(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    return normalized.length > 0 && normalized.length <= MAX_CODEX_PLAN_ID_LENGTH
        ? normalized
        : null
}

function parseCodexPlanSteps(value: unknown): CodexLocalSessionPlanStep[] | null {
    const input = asRecord(value)
    const rawSteps = input?.plan
    if (!Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_CODEX_PLAN_STEPS) {
        return null
    }

    const steps: CodexLocalSessionPlanStep[] = []
    for (const rawStep of rawSteps) {
        const record = asRecord(rawStep)
        const text = typeof record?.step === 'string' ? record.step.trim() : ''
        const status = record?.status
        if (
            !text
            || text.length > MAX_CODEX_PLAN_STEP_CHARS
            || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
        ) {
            return null
        }
        steps.push({ text, status })
    }
    return steps
}

function isSuccessfulCodexPlanOutput(value: unknown): boolean {
    if (typeof value === 'string') {
        return value.trim() === 'Plan updated'
    }

    const record = asRecord(value)
    if (!record) return false
    if (record.success === false || record.ok === false || record.is_error === true || record.isError === true) {
        return false
    }
    const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : ''
    if (status && status !== 'ok' && status !== 'success' && status !== 'completed') {
        return false
    }

    const message = [record.output, record.message, record.content]
        .find((candidate): candidate is string => typeof candidate === 'string')
    return message?.trim() === 'Plan updated'
}

/**
 * Newer Codex rollouts represent the built-in terminal as a custom tool.
 * Normalize it to the same semantic tool name used by live SHAPI messages so
 * native and SHAPI details can share the exact renderer and grouping rules.
 */
export function normalizeCodexCustomToolName(name: string): string {
    return name === 'exec' ? 'CodexBash' : name
}

export function normalizeCodexCustomToolInput(name: string, input: unknown): unknown {
    return name === 'exec' ? { command: input } : input
}

function getNumericOutputField(record: Record<string, unknown> | null, keys: string[]): number | null {
    if (!record) return null
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) return parsed
        }
    }
    return null
}

function getBooleanOutputField(record: Record<string, unknown> | null, keys: string[]): boolean | null {
    if (!record) return null
    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'boolean') return value
    }
    return null
}

/**
 * Codex versions used by the desktop app sometimes serialize an exec result
 * as a JSON envelope inside an `input_text` chunk. Lift its metadata to the
 * shape understood by the shared Terminal card instead of displaying raw JSON.
 */
function normalizeCodexCustomToolOutputEnvelope(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return text

    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch {
        return text
    }

    const record = asRecord(parsed)
    if (!record) return text
    const metadata = asRecord(record.metadata)
    const hasKnownEnvelopeField = 'stdout' in record
        || 'stderr' in record
        || 'status' in record
        || 'is_error' in record
        || 'isError' in record
        || getNumericOutputField(record, ['exit_code', 'exitCode', 'durationMs', 'duration_ms']) !== null
        || getNumericOutputField(metadata, ['exit_code', 'exitCode', 'duration_seconds', 'durationSeconds']) !== null
    if (!hasKnownEnvelopeField) return text

    const result: Record<string, unknown> = { ...record }
    const output = typeof record.stdout === 'string'
        ? record.stdout
        : typeof record.output === 'string'
            ? record.output
            : null
    if (output !== null && result.stdout === undefined) result.stdout = output

    const exitCode = getNumericOutputField(record, ['exit_code', 'exitCode', 'exitcode'])
        ?? getNumericOutputField(metadata, ['exit_code', 'exitCode', 'exitcode'])
    if (exitCode !== null && result.exit_code === undefined && result.exitCode === undefined) {
        result.exit_code = exitCode
    }

    const durationMs = getNumericOutputField(record, ['durationMs', 'duration_ms'])
        ?? (() => {
            const seconds = getNumericOutputField(metadata, ['duration_seconds', 'durationSeconds'])
            return seconds === null ? null : Math.max(0, seconds * 1_000)
        })()
    if (durationMs !== null && result.durationMs === undefined && result.duration_ms === undefined) {
        result.durationMs = durationMs
    }

    const status = typeof record.status === 'string'
        ? record.status
        : typeof metadata?.status === 'string'
            ? metadata.status
            : null
    if (status !== null && result.status === undefined) result.status = status

    const explicitError = getBooleanOutputField(record, ['is_error', 'isError'])
        ?? getBooleanOutputField(metadata, ['is_error', 'isError'])
    if (explicitError !== null && result.is_error === undefined && result.isError === undefined) {
        result.is_error = explicitError
    } else if (explicitError === null && exitCode !== null && result.is_error === undefined && result.isError === undefined) {
        result.is_error = exitCode !== 0
    }

    return result
}

export function normalizeCodexCustomToolOutput(output: unknown): unknown {
    if (typeof output === 'string') {
        return normalizeCodexCustomToolOutputEnvelope(output)
    }
    if (!Array.isArray(output)) return output

    const textParts = output
        .map((item) => {
            const record = asRecord(item)
            if ((record?.type === 'input_text' || record?.type === 'output_text' || record?.type === 'text')
                && typeof record.text === 'string') {
                return record.text
            }
            return null
        })
        .filter((part): part is string => part !== null)

    if (textParts.length === 0) return output
    return normalizeCodexCustomToolOutputEnvelope(textParts.join('\n'))
}

function extractCodexChangedTitle(record: Record<string, unknown>): string | null {
    if (record.type === 'response_item') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'function_call' && payload.name === 'change_title') {
            const argumentsText = typeof payload.arguments === 'string' ? payload.arguments : null
            if (!argumentsText) return null
            try {
                const parsedArguments = JSON.parse(argumentsText) as { title?: unknown }
                return typeof parsedArguments.title === 'string' && parsedArguments.title.trim()
                    ? parsedArguments.title.trim()
                    : null
            } catch {
                return null
            }
        }
    }

    if (record.type === 'event_msg') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'mcp_tool_call_end') {
            const invocation = asRecord(payload.invocation)
            const argumentsRecord = asRecord(invocation?.arguments)
            if (invocation?.tool === 'change_title' && typeof argumentsRecord?.title === 'string' && argumentsRecord.title.trim()) {
                return argumentsRecord.title.trim()
            }
        }
    }
    return null
}

function getLatestCodexChangedTitle(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index]))
            if (!record) continue
            const title = extractCodexChangedTitle(record)
            if (title) return title
        } catch {
            // Ignore malformed transcript records.
        }
    }
    return null
}

function getLatestCodexUserMessage(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index]))
            if (!record || record.type !== 'response_item') continue
            const payload = asRecord(record.payload)
            if (payload?.type !== 'message' || payload.role !== 'user') continue
            const text = normalizeCodexUserMessageContent(payload.content)
            if (text) return truncateText(text, 140)
        } catch {
            // Ignore malformed transcript records.
        }
    }
    return null
}

function extractCodexSessionConfig(record: Record<string, unknown>): Partial<CodexLocalSessionConfig> {
    if (record.type !== 'turn_context' && record.type !== 'session_meta') return {}
    const payload = asRecord(record.payload)
    if (!payload) return {}

    const collaborationMode = asRecord(payload.collaboration_mode ?? payload.collaborationMode)
    const settings = asRecord(collaborationMode?.settings)
    return {
        model: asString(payload.model) ?? asString(settings?.model) ?? undefined,
        modelReasoningEffort: asString(payload.effort)
            ?? asString(payload.reasoning_effort)
            ?? asString(payload.model_reasoning_effort)
            ?? asString(payload.modelReasoningEffort)
            ?? asString(settings?.reasoning_effort)
            ?? asString(settings?.model_reasoning_effort)
            ?? asString(settings?.modelReasoningEffort)
            ?? undefined
    }
}

/** Return the latest native model settings without treating arbitrary output as config. */
export function getLatestCodexSessionConfig(lines: readonly string[]): CodexLocalSessionConfig {
    let model: string | null = null
    let modelReasoningEffort: string | null = null

    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const record = asRecord(JSON.parse(lines[index] ?? ''))
            if (!record) continue
            const config = extractCodexSessionConfig(record)
            if (model === null && config.model) model = config.model
            if (modelReasoningEffort === null && config.modelReasoningEffort) {
                modelReasoningEffort = config.modelReasoningEffort
            }
            if (model !== null && modelReasoningEffort !== null) break
        } catch {
            // Ignore malformed or partially-written transcript records.
        }
    }

    return { model, modelReasoningEffort }
}

function getCodexSessionTitle(
    cwd: string | null | undefined,
    sessionId: string,
    changedTitle: string | null,
    firstUserMessage: string | null
): string {
    if (changedTitle) return getCodexSessionDisplayTitle(changedTitle)
    if (firstUserMessage) return getCodexSessionDisplayTitle(firstUserMessage)
    if (cwd) {
        const parts = cwd.split(/[\\/]+/).filter(Boolean)
        if (parts.length > 0) return parts[parts.length - 1]
    }
    return sessionId.slice(0, 8)
}

function isSubagentSource(value: unknown): boolean {
    const record = asRecord(value)
    return record ? Object.prototype.hasOwnProperty.call(record, 'subagent') : false
}

type CodexSubagentSessionHeader = {
    sessionId: string | null
    parentSessionId: string | null
    name: string | null
    role: string | null
    agentPath: string | null
}

/**
 * Native child sessions have a `source.subagent` marker in `session_meta`.
 * Codex has used a few shapes over time, so keep the parent/name extraction
 * tolerant while requiring a concrete direct parent before surfacing a card.
 */
function getCodexSubagentSessionHeader(lines: readonly string[]): CodexSubagentSessionHeader | null {
    for (const line of lines.slice(0, 200)) {
        try {
            const record = asRecord(JSON.parse(line))
            if (record?.type !== 'session_meta') continue
            const payload = asRecord(record.payload)
            const source = asRecord(payload?.source)
            if (!payload || !source || !Object.prototype.hasOwnProperty.call(source, 'subagent')) continue

            const subagent = asRecord(source.subagent)
            const threadSpawn = asRecord(subagent?.thread_spawn ?? subagent?.threadSpawn)
            const parentSessionId = asString(
                threadSpawn?.parent_thread_id
                ?? threadSpawn?.parentThreadId
                ?? subagent?.parent_thread_id
                ?? subagent?.parentThreadId
                ?? payload.parent_thread_id
                ?? payload.parentThreadId
            )
            const name = asString(
                threadSpawn?.agent_nickname
                ?? threadSpawn?.agentNickname
                ?? threadSpawn?.agent_name
                ?? threadSpawn?.agentName
                ?? subagent?.agent_nickname
                ?? subagent?.agentNickname
                ?? subagent?.agent_name
                ?? subagent?.agentName
                ?? payload.agent_nickname
                ?? payload.agentNickname
            )
            const role = asString(
                threadSpawn?.agent_role
                ?? threadSpawn?.agentRole
                ?? subagent?.agent_role
                ?? subagent?.agentRole
                ?? payload.agent_role
                ?? payload.agentRole
            )
            const agentPath = asString(
                threadSpawn?.agent_path
                ?? threadSpawn?.agentPath
                ?? subagent?.agent_path
                ?? subagent?.agentPath
                ?? payload.agent_path
                ?? payload.agentPath
            )
            return {
                sessionId: asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId),
                parentSessionId,
                name,
                role,
                agentPath
            }
        } catch {
            // A native writer can expose a partial final JSONL record. The
            // header lives at the beginning, so later attempts can recover.
        }
    }
    return null
}

export function isHapiInitiatedCodexSession(
    session: Pick<CodexLocalSessionSummary, 'originator'>
): boolean {
    return session.originator?.trim().toLowerCase() === HAPI_CODEX_ORIGINATOR
}

type CodexSessionHeader = {
    sessionId: string | null
    cwd: string | null
    originator: string | null
    cliVersion: string | null
    firstUserMessage: string | null
    isSubagent: boolean
}

function getCodexSessionHeader(lines: readonly string[]): CodexSessionHeader {
    let sessionId: string | null = null
    let cwd: string | null = null
    let originator: string | null = null
    let cliVersion: string | null = null
    let firstUserMessage: string | null = null

    for (const line of lines.slice(0, 200)) {
        try {
            const record = asRecord(JSON.parse(line))
            const type = typeof record?.type === 'string' ? record.type : null
            if (type === 'session_meta') {
                const payload = asRecord(record?.payload)
                if (payload) {
                    if (isSubagentSource(payload.source)) {
                        return {
                            sessionId,
                            cwd,
                            originator,
                            cliVersion,
                            firstUserMessage,
                            isSubagent: true
                        }
                    }
                    if (!sessionId && typeof payload.id === 'string') sessionId = payload.id
                    if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
                    if (!originator && typeof payload.originator === 'string') originator = payload.originator
                    if (!cliVersion && typeof payload.cli_version === 'string') cliVersion = payload.cli_version
                }
            }
            if (!firstUserMessage && type === 'response_item') {
                const payload = asRecord(record?.payload)
                if (payload?.type === 'message' && payload.role === 'user') {
                    const text = normalizeCodexUserMessageContent(payload.content)
                    if (text) firstUserMessage = text
                }
            }
        } catch {
            // Ignore malformed transcript records.
        }
    }

    return { sessionId, cwd, originator, cliVersion, firstUserMessage, isSubagent: false }
}

function readCodexTranscriptRange(filePath: string, offset: number, length: number): Buffer | null {
    if (length <= 0) return Buffer.alloc(0)

    let descriptor: number | null = null
    try {
        descriptor = openSync(filePath, 'r')
        const bytes = Buffer.allocUnsafe(length)
        const bytesRead = readSync(descriptor, bytes, 0, length, offset)
        return Buffer.from(bytes.subarray(0, bytesRead))
    } catch {
        return null
    } finally {
        if (descriptor !== null) {
            try {
                closeSync(descriptor)
            } catch {
                // The transcript read has already failed or completed.
            }
        }
    }
}

function getCodexSummaryHeadLines(
    filePath: string,
    size: number,
    maxBytes = CODEX_SESSION_SUMMARY_WINDOW_BYTES
): string[] | null {
    const bytes = readCodexTranscriptRange(filePath, 0, Math.min(size, maxBytes))
    return bytes === null ? null : bytes.toString('utf8').split(/\r?\n/).filter(Boolean)
}

function getCodexSummaryTailLines(filePath: string, size: number, maxBytes = CODEX_SESSION_SUMMARY_WINDOW_BYTES): string[] | null {
    const offset = Math.max(0, size - maxBytes)
    const bytes = readCodexTranscriptRange(filePath, offset, size - offset)
    if (bytes === null) return null

    let text = bytes.toString('utf8')
    // The start of a tail window can be in the middle of a JSONL record. Drop
    // that partial line so malformed JSON never obscures a later lifecycle.
    if (offset > 0) {
        const firstNewline = text.indexOf('\n')
        if (firstNewline === -1) return []
        text = text.slice(firstNewline + 1)
    }
    return text.split(/\r?\n/).filter(Boolean)
}

function buildCodexLocalSessionSummary(
    filePath: string,
    modifiedAt: number,
    header: CodexSessionHeader,
    latest: {
        changedTitle: string | null
        lastUserMessage: string | null
        config: CodexLocalSessionConfig
        runState: CodexLocalSessionRunState
        waitingForUserInput?: boolean
    }
): CodexLocalSessionSummary | null {
    if (header.isSubagent) return null

    const sessionId = header.sessionId ?? getCodexSessionIdFromTranscriptFilePath(filePath)
    if (!sessionId) return null

    return {
        id: sessionId,
        title: getCodexSessionTitle(header.cwd, sessionId, latest.changedTitle, header.firstUserMessage),
        lastUserMessage: latest.lastUserMessage,
        cwd: header.cwd,
        file: filePath,
        modifiedAt,
        originator: header.originator,
        cliVersion: header.cliVersion,
        model: latest.config.model,
        modelReasoningEffort: latest.config.modelReasoningEffort,
        runState: latest.runState,
        ...(latest.waitingForUserInput === undefined ? {} : {
            waitingForUserInput: latest.waitingForUserInput
        })
    }
}

/**
 * Read the metadata used by a native-session list row. Small transcripts keep
 * the exact full-file parser; large histories read just the first and last
 * window so list rendering is not proportional to transcript size.
 */
export function readLocalCodexSessionSummary(
    filePath: string,
    knownModifiedAt?: number,
    knownSize?: number
): CodexLocalSessionSummary | null {
    let modifiedAt = knownModifiedAt
    let size = knownSize
    if (modifiedAt === undefined || size === undefined) {
        try {
            const stats = statSync(filePath)
            modifiedAt = stats.mtimeMs
            size = stats.size
        } catch {
            return null
        }
    }

    if (modifiedAt === undefined || size === undefined) return null
    const resolvedModifiedAt = modifiedAt
    const resolvedSize = size

    if (resolvedSize <= CODEX_SESSION_SUMMARY_FULL_READ_MAX_BYTES) {
        let content: string
        try {
            content = readFileSync(filePath, 'utf-8')
        } catch {
            return null
        }

        const allLines = content.split(/\r?\n/).filter(Boolean)
        return buildCodexLocalSessionSummary(filePath, resolvedModifiedAt, getCodexSessionHeader(allLines), {
            changedTitle: getLatestCodexChangedTitle(allLines),
            lastUserMessage: getLatestCodexUserMessage(allLines),
            config: getLatestCodexSessionConfig(allLines),
            runState: getCodexTranscriptRunState(content),
            waitingForUserInput: getCodexTranscriptUserInputState(allLines).waiting
        })
    }

    const headLines = getCodexSummaryHeadLines(filePath, resolvedSize)
    const tailLines = getCodexSummaryTailLines(filePath, resolvedSize)
    if (headLines === null || tailLines === null) return null

    const tail = getCodexTranscriptTailSummary(tailLines)
    let header = getCodexSessionHeader(headLines)
    if (!tail.title && !header.isSubagent && !header.firstUserMessage && resolvedSize > CODEX_SESSION_SUMMARY_WINDOW_BYTES) {
        const titleHeadLines = getCodexSummaryHeadLines(
            filePath,
            resolvedSize,
            CODEX_SESSION_TITLE_HEAD_MAX_BYTES
        )
        if (titleHeadLines !== null) {
            header = getCodexSessionHeader(titleHeadLines)
        }
    }

    return buildCodexLocalSessionSummary(filePath, resolvedModifiedAt, header, {
        changedTitle: tail.title ?? null,
        lastUserMessage: tail.lastUserMessage ?? null,
        config: {
            model: tail.model ?? null,
            modelReasoningEffort: tail.modelReasoningEffort ?? null
        },
        // Unknown is deliberately conservative: direct sends will queue until
        // a live transcript append proves the native turn is idle.
        runState: tail.runState ?? 'unknown',
        ...(tail.waitingForUserInput === undefined ? {} : {
            waitingForUserInput: tail.waitingForUserInput
        })
    })
}

export function listCodexTranscriptFilesByRecency(): CodexTranscriptFileCandidate[] {
    const files: CodexTranscriptFileCandidate[] = []
    collectJsonlFiles(join(getCodexHome(), 'sessions'), files)
    return files.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

/**
 * Return every rollout segment for one native Codex thread in transcript
 * order. Codex may rotate an active thread into a second JSONL file, so the
 * newest segment alone is not its complete history.
 */
export function listLocalCodexSessionTranscriptFiles(sessionId: string): CodexTranscriptFileCandidate[] {
    const id = sessionId.trim()
    if (!id) return []

    return listCodexTranscriptFilesByRecency()
        .filter((candidate) => getCodexSessionIdFromTranscriptFilePath(candidate.file) === id)
        .sort((left, right) => left.modifiedAt - right.modifiedAt || left.file.localeCompare(right.file))
}

export function listLocalCodexSessions(
    limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT,
    options: CodexLocalSessionListOptions = {}
): CodexLocalSessionSummary[] {
    const sessions: CodexLocalSessionSummary[] = []
    const seenSessionIds = new Set<string>()
    for (const candidate of listCodexTranscriptFilesByRecency()) {
        const session = readLocalCodexSessionSummary(candidate.file, candidate.modifiedAt, candidate.size)
        if (!session || seenSessionIds.has(session.id)) continue
        if (options.excludeHapiInitiated && isHapiInitiatedCodexSession(session)) continue
        seenSessionIds.add(session.id)
        sessions.push(session)
        if (sessions.length >= limit) break
    }
    return sessions
}

export function findLocalCodexSession(sessionId: string): CodexLocalSessionSummary | null {
    for (const candidate of listCodexTranscriptFilesByRecency()) {
        const inferredId = getCodexSessionIdFromTranscriptFilePath(candidate.file)
        if (inferredId && inferredId !== sessionId) continue
        const session = readLocalCodexSessionSummary(candidate.file, candidate.modifiedAt, candidate.size)
        if (session?.id === sessionId) return session
    }
    return null
}

/**
 * Return the last native turn lifecycle state from the raw Codex transcript.
 *
 * `task_started` is emitted before a native turn begins. `task_complete` and
 * `turn_aborted` close it. Older transcript formats which do not carry these
 * records intentionally remain unknown, so callers do not append to a thread
 * whose live state cannot be proven.
 */
export function getLocalCodexSessionRunState(sessionId: string): CodexLocalSessionRunState | null {
    const session = findLocalCodexSession(sessionId)
    if (!session) return null
    return session.runState ?? 'unknown'
}

/**
 * Read only lifecycle routing metadata from JSONL records. Callers must not
 * infer a turn identity from an unscoped legacy record.
 */
export function getCodexTranscriptLifecycleEvents(lines: readonly string[]): CodexTranscriptLifecycleEvent[] {
    const events: CodexTranscriptLifecycleEvent[] = []
    for (const line of lines) {
        if (!line) continue
        try {
            const record = asRecord(JSON.parse(line))
            if (record?.type !== 'event_msg') continue
            const payload = asRecord(record.payload)
            const type = asString(payload?.type)
            if (type !== 'task_started' && type !== 'task_complete' && type !== 'turn_aborted' && type !== 'task_failed') continue
            const turnId = payload ? extractCodexTurnId(record, payload) : null
            events.push({ type, ...(turnId ? { turnId } : {}) })
        } catch {
            // A runner can observe the transcript while Codex is appending a
            // partial final line. Earlier complete records remain useful.
        }
    }
    return events
}

/**
 * Extract only the lifecycle identity of native local-input calls. Function
 * outputs are intentionally emitted as candidates and are matched against a
 * known request id by the lifecycle tracker; this keeps a bounded tail read
 * useful even when the request record lies before the tail window.
 */
export function getCodexTranscriptUserInputEvents(lines: readonly string[]): CodexTranscriptUserInputEvent[] {
    const events: CodexTranscriptUserInputEvent[] = []
    for (const line of lines) {
        if (!line) continue
        try {
            const record = asRecord(JSON.parse(line))
            if (!record) continue
            const payload = asRecord(record.payload)
            if (!payload) continue
            if (record.type === 'event_msg') {
                const eventType = asString(payload.type)
                const turnId = extractCodexTurnId(record, payload)
                if (eventType === 'task_started') {
                    events.push({ type: 'turn_started', ...(turnId ? { turnId } : {}) })
                } else if (eventType === 'task_complete' || eventType === 'turn_aborted' || eventType === 'task_failed') {
                    events.push({ type: 'turn_terminal', ...(turnId ? { turnId } : {}) })
                }
                continue
            }
            if (record.type !== 'response_item') continue
            const itemType = asString(payload.type)
            const requestId = extractCodexToolCallId(payload)
            if (!requestId) continue
            const turnId = extractCodexTurnId(record, payload)
            if (
                (itemType === 'function_call' || itemType === 'custom_tool_call')
                && payload.name === 'request_user_input'
            ) {
                events.push({ type: 'requested', requestId, ...(turnId ? { turnId } : {}) })
            } else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
                events.push({ type: 'resolved', requestId, ...(turnId ? { turnId } : {}) })
            }
        } catch {
            // A live native transcript can expose a partial final JSONL line.
        }
    }
    return events
}

/**
 * Raw transcript fallback for cold list rows. The runner tracker adds
 * stronger hook/tombstone semantics for hot sessions; this only gives a
 * bounded cold read enough information to surface a genuine waiting state.
 */
export function getCodexTranscriptUserInputState(lines: readonly string[]): CodexTranscriptUserInputState {
    let active: { requestId: string; turnId?: string } | null = null
    let seen = false

    for (const event of getCodexTranscriptUserInputEvents(lines)) {
        if (event.type === 'requested') {
            seen = true
            active = {
                requestId: event.requestId,
                ...(event.turnId ? { turnId: event.turnId } : {})
            }
        } else if (event.type === 'resolved') {
            if (active?.requestId === event.requestId) {
                seen = true
                active = null
            }
        } else if (event.type === 'turn_started') {
            if (active && (!event.turnId || !active.turnId || active.turnId !== event.turnId)) {
                active = null
            }
        } else if (active && (!event.turnId || !active.turnId || active.turnId === event.turnId)) {
            active = null
        }
    }

    return { seen, waiting: active !== null }
}

function getCodexTranscriptRunState(content: string): CodexLocalSessionRunState {
    let state: CodexLocalSessionRunState = 'unknown'
    for (const line of content.split(/\r?\n/)) {
        if (!line) continue
        try {
            const record = asRecord(JSON.parse(line))
            if (record?.type !== 'event_msg') continue
            const payload = asRecord(record.payload)
            const eventType = asString(payload?.type)
            if (eventType === 'task_started') {
                state = 'processing'
            } else if (eventType === 'task_complete' || eventType === 'turn_aborted' || eventType === 'task_failed') {
                state = 'idle'
            }
        } catch {
            // A runner can observe the transcript while Codex is appending a
            // partial final line. Earlier well-formed lifecycle records still
            // give us the safest known state.
        }
    }
    return state
}

/**
 * Summary fields that can be safely advanced from newly appended JSONL
 * records. The cache keeps the previous values when a tail has no matching
 * record, so a live append never needs to rescan the whole transcript.
 */
export type CodexTranscriptTailSummary = {
    title?: string
    lastUserMessage?: string
    model?: string
    modelReasoningEffort?: string
    runState?: CodexLocalSessionRunState
    waitingForUserInput?: boolean
}

export function getCodexTranscriptTailSummary(lines: readonly string[]): CodexTranscriptTailSummary {
    const summary: CodexTranscriptTailSummary = {}
    for (const line of lines) {
        if (!line) continue
        try {
            const record = asRecord(JSON.parse(line))
            if (!record) continue

            const title = extractCodexChangedTitle(record)
            if (title) summary.title = truncateText(title, 80)

            const config = extractCodexSessionConfig(record)
            if (config.model) summary.model = config.model
            if (config.modelReasoningEffort) summary.modelReasoningEffort = config.modelReasoningEffort

            if (record.type === 'response_item') {
                const payload = asRecord(record.payload)
                if (payload?.type === 'message' && payload.role === 'user') {
                    const text = normalizeCodexUserMessageContent(payload.content)
                    if (text) {
                        summary.lastUserMessage = truncateText(text, 140)
                    }
                }
            }

            if (record.type === 'event_msg') {
                const payload = asRecord(record.payload)
                const eventType = asString(payload?.type)
                if (eventType === 'task_started') {
                    summary.runState = 'processing'
                } else if (eventType === 'task_complete' || eventType === 'turn_aborted' || eventType === 'task_failed') {
                    summary.runState = 'idle'
                }
            }
        } catch {
            // A live writer can expose an incomplete final JSONL record.
        }
    }
    const userInput = getCodexTranscriptUserInputState(lines)
    if (userInput.seen) {
        summary.waitingForUserInput = userInput.waiting
    }
    return summary
}

function getCodexRecordTimestamp(record: Record<string, unknown>): number | undefined {
    const timestamp = asString(record.timestamp)
    if (!timestamp) return undefined
    const parsed = Date.parse(timestamp)
    return Number.isFinite(parsed) ? parsed : undefined
}

function buildImportedUserMessage(text: string, createdAt?: number): CodexImportedMessageContent {
    return {
        ...(createdAt === undefined ? {} : { createdAt }),
        role: 'user',
        content: { type: 'text', text },
        meta: { sentFrom: 'cli' }
    }
}

function buildImportedAgentMessage(data: unknown, createdAt?: number): CodexImportedMessageContent {
    return {
        ...(createdAt === undefined ? {} : { createdAt }),
        role: 'agent',
        content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data },
        meta: { sentFrom: 'cli' }
    }
}

function getCodexReasoningSummaryParts(payload: Record<string, unknown>): string[] {
    const values = Array.isArray(payload.summary) ? payload.summary : []
    const parts: string[] = []
    for (const value of values) {
        const record = asRecord(value)
        const text = (typeof value === 'string' ? value : asString(record?.text))?.trim()
        if (!text || parts[parts.length - 1] === text) continue
        parts.push(text)
    }
    return parts
}

function getPendingReasoningText(accumulator: CodexTranscriptImportAccumulator): string | null {
    return accumulator.pendingReasoningParts.length > 0
        ? accumulator.pendingReasoningParts.join('\n\n')
        : null
}

function buildCanonicalReasoningMessage(
    record: Record<string, unknown>,
    fallbackText: string | null
): CodexImportedMessageContent | null {
    if (record.type !== 'response_item') return null
    const payload = asRecord(record.payload)
    if (payload?.type !== 'reasoning') return null
    const message = getCodexReasoningSummaryParts(payload).join('\n\n') || fallbackText?.trim()
    if (!message) return null
    const id = asString(payload.id)
        ?? `codex-reasoning:${asString(record.timestamp) ?? message.length}`
    return buildImportedAgentMessage({ type: 'reasoning', message, id }, getCodexRecordTimestamp(record))
}

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): CodexImportedMessageContent | null {
    const type = asString(record.type)
    const payload = asRecord(record.payload)
    if (!type || !payload) return null

    const createdAt = getCodexRecordTimestamp(record)

    if (type === 'event_msg') {
        const eventType = asString(payload.type)
        if (!eventType) return null
        if (eventType === 'user_message') {
            const rawText = asString(payload.message) ?? asString(payload.text) ?? asString(payload.content)
            const text = rawText ? normalizeCodexUserMessageText(rawText) : null
            return text ? buildImportedUserMessage(text, createdAt) : null
        }
        if (eventType === 'agent_message') {
            const message = asString(payload.message)
            return message ? buildImportedAgentMessage({ type: 'message', message, id: randomUUID() }, createdAt) : null
        }
        if (eventType === 'agent_reasoning') {
            const message = asString(payload.text) ?? asString(payload.message)
            return message ? buildImportedAgentMessage({ type: 'reasoning', message, id: randomUUID() }, createdAt) : null
        }
        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payload.delta) ?? asString(payload.text) ?? asString(payload.message)
            return delta ? buildImportedAgentMessage({ type: 'reasoning-delta', delta }, createdAt) : null
        }
        if (eventType === 'token_count') {
            const info = asRecord(payload.info)
            return info ? buildImportedAgentMessage({ type: 'token_count', info, id: randomUUID() }, createdAt) : null
        }
        if (eventType === 'context_compacted') {
            return buildImportedAgentMessage({ type: 'context_compacted', id: randomUUID() }, createdAt)
        }
        // Native Codex can end a failed turn with task_complete + error.
        if (eventType === 'task_complete' || eventType === 'task_failed') {
            const error = asString(payload.error) ?? asString(asRecord(payload.error)?.message)
            if (isHttpForbiddenError(error)) {
                return buildImportedAgentMessage({
                    type: 'task-status',
                    status: 'failed',
                    source: 'codex',
                    code: 'http_forbidden',
                    message: 'HTTP 403 Forbidden',
                    recoverable: false
                }, createdAt)
            }
        }
        return null
    }

    if (type !== 'response_item') return null
    const itemType = asString(payload.type)
    if (!itemType) return null
    if (itemType === 'message') {
        const role = asString(payload.role)
        if (role === 'user') {
            const text = normalizeCodexUserMessageContent(payload.content)
            return text ? buildImportedUserMessage(text, createdAt) : null
        }
        const text = extractCodexText(payload.content)
        if (!text) return null
        if (role === 'assistant') return buildImportedAgentMessage({ type: 'message', message: text, id: randomUUID() }, createdAt)
        return null
    }
    if (itemType === 'custom_tool_call') {
        const name = asString(payload.name)
        const callId = extractCodexToolCallId(payload)
        return name && callId
            ? buildImportedAgentMessage({
                type: 'tool-call',
                name: normalizeCodexCustomToolName(name),
                callId,
                input: normalizeCodexCustomToolInput(name, payload.input),
                id: randomUUID()
            }, createdAt)
            : null
    }
    if (itemType === 'custom_tool_call_output') {
        const callId = extractCodexToolCallId(payload)
        return callId
            ? buildImportedAgentMessage({
                type: 'tool-call-result',
                callId,
                output: normalizeCodexCustomToolOutput(payload.output),
                id: randomUUID()
            }, createdAt)
            : null
    }
    if (itemType === 'function_call') {
        const name = asString(payload.name)
        const callId = extractCodexToolCallId(payload)
        return name && callId
            ? buildImportedAgentMessage({ type: 'tool-call', name, callId, input: parseCodexFunctionArguments(payload.arguments), id: randomUUID() }, createdAt)
            : null
    }
    if (itemType === 'function_call_output') {
        const callId = extractCodexToolCallId(payload)
        return callId
            ? buildImportedAgentMessage({ type: 'tool-call-result', callId, output: payload.output, id: randomUUID() }, createdAt)
            : null
    }
    return null
}

function importedChatMessageFingerprint(message: CodexImportedMessageContent): string | null {
    if (message.role === 'user') return `user:${message.content.text.trim()}`
    const data = asRecord(message.content.data)
    if (data?.type !== 'message') return null
    const text = asString(data.message)?.trim()
    return text ? `assistant:${text}` : null
}

function getHeartbeatTimestamp(message: CodexImportedMessageContent): number | undefined {
    const heartbeat = parseAutomationHeartbeatMessageContent(message.content)
    if (!heartbeat?.currentTimeIso) return undefined
    const timestamp = Date.parse(heartbeat.currentTimeIso)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

/**
 * Stateful JSONL import parser. Keeping its canonical-message and tool-call
 * indexes lets a runner append only new transcript records without changing
 * the shape of a full transcript import.
 */
export type CodexTranscriptImportAccumulator = {
    messages: CodexImportedMessageContent[]
    canonicalChatMessageIndexByRolloutKey: Map<string, number>
    userMessageMirrorDeduper: ReturnType<typeof createCodexUserMessageMirrorDeduper>
    /** Tool calls whose questions and answers must remain on the native client. */
    localOnlyCallIds: Set<string>
    startedAtByCallId: Map<string, number>
    toolResultIndexesByCallId: Map<string, number[]>
    pendingHeartbeatTimestamp?: number
    pendingReasoningIndex?: number
    pendingReasoningParts: string[]
    reasoningFingerprintsInCurrentTurn: Set<string>
    /** The transcript-owned current native turn. Never inferred from reasoning. */
    activePlanTurnId: string | null
    /** Valid update_plan calls await their matching successful tool output. */
    pendingPlansByCallId: Map<string, CodexLocalSessionPlan>
    /** Last confirmed plan for the active native turn, retained outside the message page. */
    plan: CodexLocalSessionPlan | null
}

export function createCodexTranscriptImportAccumulator(): CodexTranscriptImportAccumulator {
    return {
        messages: [],
        canonicalChatMessageIndexByRolloutKey: new Map(),
        userMessageMirrorDeduper: createCodexUserMessageMirrorDeduper(),
        localOnlyCallIds: new Set(),
        startedAtByCallId: new Map(),
        toolResultIndexesByCallId: new Map(),
        pendingReasoningParts: [],
        reasoningFingerprintsInCurrentTurn: new Set(),
        activePlanTurnId: null,
        pendingPlansByCallId: new Map(),
        plan: null
    }
}

function cloneCodexLocalSessionPlan(plan: CodexLocalSessionPlan): CodexLocalSessionPlan {
    return {
        turnId: plan.turnId,
        callId: plan.callId,
        steps: plan.steps.map((step) => ({ ...step }))
    }
}

/** Read a defensive copy of the current transcript-confirmed native plan. */
export function getCodexTranscriptImportPlan(
    accumulator: CodexTranscriptImportAccumulator
): CodexLocalSessionPlan | null {
    return accumulator.plan ? cloneCodexLocalSessionPlan(accumulator.plan) : null
}

/**
 * Extract only an explicit native `update_plan` transaction. We require both
 * a turn id and the matching successful output, so an unrelated/failed tool
 * record can neither resurrect an old plan nor masquerade as progress.
 *
 * Returns true when the record belongs to update_plan and must stay out of
 * the ordinary transcript message stream; the PlanStatusSummary owns its UI.
 */
function applyCodexTranscriptPlanRecord(
    accumulator: CodexTranscriptImportAccumulator,
    record: Record<string, unknown>
): boolean {
    const recordType = asString(record.type)
    const payload = asRecord(record.payload)
    if (!recordType || !payload) return false

    if (recordType === 'event_msg') {
        const eventType = asString(payload.type)
        const turnId = extractCodexTurnId(record, payload)
        if (eventType === 'task_started' && turnId) {
            if (accumulator.activePlanTurnId !== turnId) {
                accumulator.activePlanTurnId = turnId
                accumulator.pendingPlansByCallId.clear()
                accumulator.plan = null
            }
        } else if (
            (eventType === 'task_complete' || eventType === 'turn_aborted' || eventType === 'task_failed')
            && turnId
            && accumulator.activePlanTurnId === turnId
        ) {
            accumulator.activePlanTurnId = null
            accumulator.pendingPlansByCallId.clear()
            accumulator.plan = null
        }
        return false
    }

    if (recordType !== 'response_item') return false
    const itemType = asString(payload.type)
    if (!itemType) return false

    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
        if (asString(payload.name) !== 'update_plan') return false
        // Stock Codex rollout response_items normally omit turn_id. They are
        // ordered inside the surrounding task_started/task terminal records,
        // so inherit the accumulator's current transcript-owned turn. An
        // explicit id, when present, must still match that turn.
        const explicitTurnId = normalizeCodexPlanIdentifier(extractCodexTurnId(record, payload))
        const turnId = explicitTurnId ?? accumulator.activePlanTurnId
        const callId = normalizeCodexPlanIdentifier(extractCodexToolCallId(payload))
        const source = itemType === 'function_call'
            ? parseCodexFunctionArguments(payload.arguments)
            : parseCodexFunctionArguments(payload.input)
        const steps = parseCodexPlanSteps(source)
        if (
            turnId
            && callId
            && steps
            && accumulator.activePlanTurnId === turnId
        ) {
            accumulator.pendingPlansByCallId.set(callId, { turnId, callId, steps })
        }
        // update_plan has its own compact status renderer. Suppress malformed
        // calls too; exposing raw plan payloads creates duplicate noisy cards.
        return true
    }

    if (itemType !== 'function_call_output' && itemType !== 'custom_tool_call_output') return false
    const callId = normalizeCodexPlanIdentifier(extractCodexToolCallId(payload))
    if (!callId) return false
    const candidate = accumulator.pendingPlansByCallId.get(callId)
    if (!candidate) return false

    accumulator.pendingPlansByCallId.delete(callId)
    const outputTurnId = normalizeCodexPlanIdentifier(extractCodexTurnId(record, payload))
    if (
        (!outputTurnId || outputTurnId === candidate.turnId)
        && accumulator.activePlanTurnId === candidate.turnId
        && isSuccessfulCodexPlanOutput(payload.output)
    ) {
        accumulator.plan = cloneCodexLocalSessionPlan(candidate)
    }
    return true
}

function getImportedToolData(message: CodexImportedMessageContent): Record<string, unknown> | null {
    return message.role === 'agent' ? asRecord(message.content.data) : null
}

function applyImportedToolTiming(
    message: CodexImportedMessageContent,
    startedAt?: number
): CodexImportedMessageContent {
    if (message.role !== 'agent' || message.createdAt === undefined) return message
    const data = getImportedToolData(message)
    if (!data) return message
    const nextData: Record<string, unknown> = { ...data }
    if (data.type === 'tool-call') {
        if (nextData.startedAt === undefined && nextData.started_at === undefined) {
            nextData.startedAt = message.createdAt
        }
        return { ...message, content: { ...message.content, data: nextData } }
    }
    if (data.type !== 'tool-call-result') return message
    if (nextData.completedAt === undefined && nextData.completed_at === undefined) {
        nextData.completedAt = message.createdAt
    }
    if (nextData.durationMs === undefined && nextData.duration_ms === undefined && startedAt !== undefined) {
        nextData.durationMs = Math.max(0, message.createdAt - startedAt)
    }
    return { ...message, content: { ...message.content, data: nextData } }
}

function addImportedMessage(
    accumulator: CodexTranscriptImportAccumulator,
    message: CodexImportedMessageContent
): void {
    const data = getImportedToolData(message)
    const callId = data ? asString(data.callId) : null
    if (data?.type === 'tool-call') {
        if (callId && message.createdAt !== undefined && !accumulator.startedAtByCallId.has(callId)) {
            accumulator.startedAtByCallId.set(callId, message.createdAt)
            for (const index of accumulator.toolResultIndexesByCallId.get(callId) ?? []) {
                accumulator.messages[index] = applyImportedToolTiming(accumulator.messages[index], message.createdAt)
            }
        }
        accumulator.messages.push(applyImportedToolTiming(message))
        return
    }

    if (data?.type === 'tool-call-result') {
        const startedAt = callId ? accumulator.startedAtByCallId.get(callId) : undefined
        const index = accumulator.messages.length
        accumulator.messages.push(applyImportedToolTiming(message, startedAt))
        if (callId) {
            const indexes = accumulator.toolResultIndexesByCallId.get(callId) ?? []
            indexes.push(index)
            accumulator.toolResultIndexesByCallId.set(callId, indexes)
        }
        return
    }

    accumulator.messages.push(message)
}

function getImportedReasoningData(message: CodexImportedMessageContent): Record<string, unknown> | null {
    const data = getImportedToolData(message)
    return data?.type === 'reasoning' ? data : null
}

function appendPendingReasoningPart(
    accumulator: CodexTranscriptImportAccumulator,
    text: string,
    createdAt: number | undefined,
    timestamp: string | null
): void {
    const part = text.trim()
    if (!part || accumulator.pendingReasoningParts[accumulator.pendingReasoningParts.length - 1] === part) {
        return
    }
    accumulator.pendingReasoningParts.push(part)
    const message = accumulator.pendingReasoningParts.join('\n\n')

    if (accumulator.pendingReasoningIndex === undefined) {
        accumulator.pendingReasoningIndex = accumulator.messages.length
        addImportedMessage(accumulator, buildImportedAgentMessage({
            type: 'reasoning',
            message,
            id: `codex-reasoning-event:${timestamp ?? accumulator.messages.length}`
        }, createdAt))
        return
    }

    const existing = accumulator.messages[accumulator.pendingReasoningIndex]
    const data = existing ? getImportedReasoningData(existing) : null
    if (!existing || !data || existing.role !== 'agent') return
    accumulator.messages[accumulator.pendingReasoningIndex] = {
        ...existing,
        content: {
            ...existing.content,
            data: { ...data, message }
        }
    }
}

function resetPendingReasoning(accumulator: CodexTranscriptImportAccumulator): void {
    accumulator.pendingReasoningIndex = undefined
    accumulator.pendingReasoningParts = []
}

function finalizePendingReasoning(
    accumulator: CodexTranscriptImportAccumulator,
    canonicalMessage: CodexImportedMessageContent | null = null
): void {
    const pendingIndex = accumulator.pendingReasoningIndex
    const pendingMessage = pendingIndex === undefined ? null : accumulator.messages[pendingIndex] ?? null
    const resolvedMessage = canonicalMessage ?? pendingMessage
    if (!resolvedMessage) {
        resetPendingReasoning(accumulator)
        return
    }

    const text = asString(getImportedReasoningData(resolvedMessage)?.message)?.trim()
    if (!text) {
        resetPendingReasoning(accumulator)
        return
    }

    if (accumulator.reasoningFingerprintsInCurrentTurn.has(text)) {
        if (pendingIndex !== undefined && pendingIndex === accumulator.messages.length - 1) {
            accumulator.messages.pop()
        }
        resetPendingReasoning(accumulator)
        return
    }

    accumulator.reasoningFingerprintsInCurrentTurn.add(text)
    if (pendingIndex !== undefined) {
        accumulator.messages[pendingIndex] = resolvedMessage
    } else if (canonicalMessage) {
        addImportedMessage(accumulator, canonicalMessage)
    }
    resetPendingReasoning(accumulator)
}

function getCodexRecordKinds(record: Record<string, unknown>): {
    recordType: string | null
    payloadType: string | null
    payload: Record<string, unknown> | null
} {
    const payload = asRecord(record.payload)
    return {
        recordType: asString(record.type),
        payloadType: asString(payload?.type),
        payload
    }
}

function startsReasoningTurn(recordType: string | null, payloadType: string | null, payload: Record<string, unknown> | null): boolean {
    return (recordType === 'event_msg' && (payloadType === 'task_started' || payloadType === 'user_message'))
        || (recordType === 'response_item' && payloadType === 'message' && payload?.role === 'user')
}

function endsReasoningTurn(recordType: string | null, payloadType: string | null): boolean {
    return recordType === 'event_msg'
        && (payloadType === 'task_complete' || payloadType === 'turn_aborted' || payloadType === 'task_failed')
}

function shouldClosePendingReasoning(message: CodexImportedMessageContent | null): boolean {
    if (!message) return false
    const data = getImportedToolData(message)
    return data?.type !== 'token_count'
}

/** Append complete JSONL records to an existing native transcript import. */
export function appendCodexTranscriptImportLines(
    accumulator: CodexTranscriptImportAccumulator,
    lines: readonly string[]
): void {
    for (const line of lines) {
        if (!line) continue
        try {
            const record = asRecord(JSON.parse(line))
            if (!record) continue
            const { recordType, payloadType, payload } = getCodexRecordKinds(record)

            if (applyCodexTranscriptPlanRecord(accumulator, record)) {
                finalizePendingReasoning(accumulator)
                continue
            }

            if (
                recordType === 'response_item'
                && (payloadType === 'function_call' || payloadType === 'custom_tool_call')
                && payload?.name === 'request_user_input'
            ) {
                const callId = extractCodexToolCallId(payload)
                if (callId) accumulator.localOnlyCallIds.add(callId)
                finalizePendingReasoning(accumulator)
                continue
            }
            if (
                recordType === 'response_item'
                && (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output')
            ) {
                const callId = payload ? extractCodexToolCallId(payload) : null
                if (callId && accumulator.localOnlyCallIds.has(callId)) {
                    finalizePendingReasoning(accumulator)
                    continue
                }
            }

            if (recordType === 'event_msg' && payloadType === 'agent_reasoning_delta') {
                continue
            }
            if (recordType === 'event_msg' && payloadType === 'agent_reasoning') {
                const text = asString(payload?.text) ?? asString(payload?.message)
                if (text) {
                    appendPendingReasoningPart(
                        accumulator,
                        text,
                        getCodexRecordTimestamp(record),
                        asString(record.timestamp)
                    )
                }
                continue
            }
            if (recordType === 'response_item' && payloadType === 'reasoning') {
                finalizePendingReasoning(
                    accumulator,
                    buildCanonicalReasoningMessage(record, getPendingReasoningText(accumulator))
                )
                continue
            }

            let message = convertCodexRecordToImportedMessage(record)
            if (shouldClosePendingReasoning(message) || startsReasoningTurn(recordType, payloadType, payload) || endsReasoningTurn(recordType, payloadType)) {
                finalizePendingReasoning(accumulator)
            }
            if (startsReasoningTurn(recordType, payloadType, payload)) {
                accumulator.reasoningFingerprintsInCurrentTurn.clear()
            }
            if (endsReasoningTurn(recordType, payloadType)) {
                accumulator.reasoningFingerprintsInCurrentTurn.clear()
            }
            const suppressUserMirror = accumulator.userMessageMirrorDeduper.shouldSuppress(
                record,
                message?.role === 'user' ? message.content.text : ''
            )
            if (!message || suppressUserMirror) continue

            const heartbeatTimestamp = getHeartbeatTimestamp(message)
            if (message.role === 'user') {
                accumulator.pendingHeartbeatTimestamp = heartbeatTimestamp
            }
            if (heartbeatTimestamp !== undefined) {
                message = { ...message, createdAt: heartbeatTimestamp }
            } else if (message.role === 'agent' && accumulator.pendingHeartbeatTimestamp !== undefined
                && parseAutomationHeartbeatMessageContent(message.content)) {
                message = { ...message, createdAt: accumulator.pendingHeartbeatTimestamp }
            }

            const fingerprint = message.role === 'user' ? null : importedChatMessageFingerprint(message)
            const timestamp = getCodexRolloutTimestampKey(asString(record.timestamp))
            const rolloutKey = fingerprint && timestamp ? `${timestamp}\u0000${fingerprint}` : null
            if (rolloutKey) {
                const existingIndex = accumulator.canonicalChatMessageIndexByRolloutKey.get(rolloutKey)
                if (existingIndex !== undefined) {
                    if (record.type === 'response_item') accumulator.messages[existingIndex] = message
                    continue
                }
                accumulator.canonicalChatMessageIndexByRolloutKey.set(rolloutKey, accumulator.messages.length)
            }
            addImportedMessage(accumulator, message)
        } catch {
            // Ignore malformed transcript records. A cache retains unfinished
            // bytes and retries the final line on the next append.
        }
    }
}

type CodexSubagentTranscriptGroup = {
    id: string
    header: CodexSubagentSessionHeader
    files: CodexTranscriptFileCandidate[]
    filePaths: Set<string>
}

function addCodexSubagentTranscriptFile(
    group: CodexSubagentTranscriptGroup,
    candidate: CodexTranscriptFileCandidate
): void {
    if (group.filePaths.has(candidate.file)) return
    group.filePaths.add(candidate.file)
    group.files.push(candidate)
}

function getNativeSubagentStatusText(status: CodexLocalSessionSubagent['status']): string {
    if (status === 'completed') return 'Completed'
    if (status === 'failed') return 'Failed'
    if (status === 'canceled') return 'Canceled'
    if (status === 'unknown') return 'Unknown'
    return 'Working'
}

function normalizeNativeSubagentField(value: string | null): string | null {
    const normalized = value?.trim()
    return normalized ? normalized : null
}

function boundCodexSubagentTrace(messages: readonly CodexImportedMessageContent[], budget: number): CodexImportedMessageContent[] {
    const recent: CodexImportedMessageContent[] = []
    let bytes = 0
    for (let index = messages.length - 1; index >= 0 && recent.length < MAX_CODEX_SUBAGENT_TRACE_MESSAGES; index--) {
        const message = messages[index]
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8')
        // A giant tool result must not crowd out the following answer or
        // delay the entire parent conversation. Raw transcripts stay intact.
        if (bytes + size > budget) continue
        bytes += size
        recent.push(message)
    }
    return recent.reverse()
}

function buildCodexLocalSessionSubagent(
    parentSessionId: string,
    group: CodexSubagentTranscriptGroup
): CodexLocalSessionSubagent {
    const files = [...group.files].sort((left, right) => (
        left.modifiedAt - right.modifiedAt || left.file.localeCompare(right.file)
    ))
    const accumulator = createCodexTranscriptImportAccumulator()
    let model: string | null = null
    let modelReasoningEffort: string | null = null
    let status: CodexLocalSessionSubagent['status'] = 'unknown'
    let currentTurnId: string | null = null
    let startedAt: number | null = null
    let completedAt: number | undefined
    let updatedAt = files.reduce((latest, file) => Math.max(latest, file.modifiedAt), 0)

    for (const file of files) {
        // Child cards expose a bounded recent trace. Reading every historical
        // body here can block the parent snapshot for tens of seconds and
        // allocate gigabytes even when its own message page is only 50 rows.
        const lines = getCodexSummaryTailLines(file.file, file.size, MAX_CODEX_SUBAGENT_TRACE_BYTES)
        if (lines === null) continue
        if (file.size > MAX_CODEX_SUBAGENT_TRACE_BYTES) {
            const head = getCodexSummaryHeadLines(file.file, file.size) ?? []
            const initialConfig = getLatestCodexSessionConfig(head)
            if (initialConfig.model) model = initialConfig.model
            if (initialConfig.modelReasoningEffort) modelReasoningEffort = initialConfig.modelReasoningEffort
            // A skipped middle can contain another turn. Do not use an old
            // segment's turn id to reject the latest terminal or claim busy.
            currentTurnId = null
            status = 'unknown'
            startedAt = null
            completedAt = undefined
        }
        const config = getLatestCodexSessionConfig(lines)
        if (config.model) model = config.model
        if (config.modelReasoningEffort) modelReasoningEffort = config.modelReasoningEffort
        appendCodexTranscriptImportLines(accumulator, lines)

        for (const line of lines) {
            try {
                const record = asRecord(JSON.parse(line))
                if (record?.type !== 'event_msg') continue
                const payload = asRecord(record.payload)
                const eventType = asString(payload?.type)
                if (!payload || !eventType) continue
                const eventAt = getCodexRecordTimestamp(record) ?? file.modifiedAt
                updatedAt = Math.max(updatedAt, eventAt)
                const turnId = extractCodexTurnId(record, payload)
                if (eventType === 'task_started') {
                    status = 'running'
                    currentTurnId = turnId
                    startedAt = eventAt
                    completedAt = undefined
                    continue
                }
                if (eventType !== 'task_complete' && eventType !== 'task_failed' && eventType !== 'turn_aborted') {
                    continue
                }
                // A delayed terminal from an older turn must not close a
                // newer child run in a rotated transcript segment.
                if (currentTurnId && turnId && currentTurnId !== turnId) continue
                status = eventType === 'task_complete'
                    ? 'completed'
                    : eventType === 'task_failed'
                        ? 'failed'
                        : 'canceled'
                currentTurnId = turnId ?? currentTurnId
                startedAt ??= eventAt
                completedAt = eventAt
            } catch {
                // Ignore malformed/partially written JSONL lines.
            }
        }
    }

    const traceMessages = accumulator.messages.filter((message) => message.role === 'agent')
    const boundedTraceMessages = boundCodexSubagentTrace(traceMessages, MAX_CODEX_SUBAGENT_TRACE_PAYLOAD_BYTES)
    const fallbackStartedAt = files[0]?.modifiedAt ?? updatedAt ?? Date.now()
    const name = normalizeNativeSubagentField(group.header.name)
    const role = normalizeNativeSubagentField(group.header.role)
    const agentPath = normalizeNativeSubagentField(group.header.agentPath)

    return {
        id: group.id,
        parentSessionId,
        ...(name ? { name } : {}),
        ...(role ? { role } : {}),
        ...(agentPath ? { agentPath } : {}),
        model,
        modelReasoningEffort,
        status,
        statusText: getNativeSubagentStatusText(status),
        startedAt: startedAt ?? fallbackStartedAt,
        updatedAt: Math.max(updatedAt, completedAt ?? 0),
        ...(completedAt === undefined ? {} : { completedAt }),
        traceMessages: boundedTraceMessages
    }
}

/**
 * Return direct native Codex children for one parent thread. These files are
 * hidden from the native session list, so association must happen before the
 * normal summary filter discards their `source.subagent` metadata.
 */
export function listLocalCodexSessionSubagents(parentSessionId: string): CodexLocalSessionSubagent[] {
    const parentId = parentSessionId.trim()
    if (!parentId) return []

    const candidates = listCodexTranscriptFilesByRecency()
    const groups = new Map<string, CodexSubagentTranscriptGroup>()
    const childIdByTranscriptId = new Map<string, string>()

    for (const candidate of candidates) {
        const lines = getCodexSummaryHeadLines(candidate.file, candidate.size)
        const header = lines ? getCodexSubagentSessionHeader(lines) : null
        if (!header || header.parentSessionId !== parentId) continue
        const transcriptId = getCodexSessionIdFromTranscriptFilePath(candidate.file)
        const childId = header.sessionId ?? transcriptId
        if (!childId) continue

        const group = groups.get(childId) ?? {
            id: childId,
            header,
            files: [],
            filePaths: new Set<string>()
        }
        groups.set(childId, group)
        addCodexSubagentTranscriptFile(group, candidate)
        if (transcriptId) childIdByTranscriptId.set(transcriptId, childId)
    }

    // A rotated follow-up segment can omit the full subagent header. Once a
    // first segment identifies the child, keep every same-thread segment in
    // its ordered history exactly as the parent transcript cache does.
    for (const candidate of candidates) {
        const transcriptId = getCodexSessionIdFromTranscriptFilePath(candidate.file)
        if (!transcriptId) continue
        const childId = childIdByTranscriptId.get(transcriptId) ?? (groups.has(transcriptId) ? transcriptId : null)
        if (!childId) continue
        const group = groups.get(childId)
        if (group) addCodexSubagentTranscriptFile(group, candidate)
    }

    const subagents = Array.from(groups.values())
        .map((group) => buildCodexLocalSessionSubagent(parentId, group))
        .sort((left, right) => (
            left.startedAt - right.startedAt
            || left.updatedAt - right.updatedAt
            || left.id.localeCompare(right.id)
        ))
    let remaining = MAX_CODEX_SUBAGENTS_TRACE_PAYLOAD_BYTES
    for (let index = subagents.length - 1; index >= 0; index--) {
        const subagent = subagents[index]
        subagent.traceMessages = boundCodexSubagentTrace(subagent.traceMessages, remaining)
        remaining = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(subagent.traceMessages), 'utf8'))
    }
    return subagents
}

export function parseCodexTranscriptImportData(summary: CodexLocalSessionSummary): CodexTranscriptImportData | null {
    let content: string
    try {
        content = readFileSync(summary.file, 'utf-8')
    } catch {
        return null
    }

    const accumulator = createCodexTranscriptImportAccumulator()
    appendCodexTranscriptImportLines(accumulator, content.split(/\r?\n/).filter(Boolean))
    return { ...summary, messages: accumulator.messages }
}

function getCodexTranscriptContextFromImportedMessages(importedMessages: readonly CodexImportedMessageContent[]): CodexLocalSessionContextMessage[] {
    const messages: CodexLocalSessionContextMessage[] = []
    for (const message of importedMessages) {
        if (message.role === 'user') {
            const text = message.content.text.trim()
            if (text) messages.push({ role: 'user', text: truncateText(text, MAX_CODEX_CONTEXT_MESSAGE_CHARS) })
            continue
        }
        const data = asRecord(message.content.data)
        if (data?.type !== 'message') continue
        const text = asString(data.message)?.trim()
        if (text) messages.push({ role: 'assistant', text: truncateText(text, MAX_CODEX_CONTEXT_MESSAGE_CHARS) })
    }
    // A recent-session detail page must open on the newest turn. Trim after
    // filtering so verbose tool/reasoning records do not consume the context
    // window and hide the latest user/assistant exchange.
    return messages.slice(-MAX_CODEX_CONTEXT_MESSAGES)
}

export function getCodexTranscriptContext(summary: CodexLocalSessionSummary): CodexLocalSessionContextMessage[] {
    return getCodexTranscriptContextFromImportedMessages(parseCodexTranscriptImportData(summary)?.messages ?? [])
}

function getCodexTranscriptMessagePage(
    messages: readonly CodexImportedMessageContent[],
    options: CodexLocalSessionReadOptions
): { messages: CodexImportedMessageContent[]; startIndex: number; page: CodexLocalSessionPage } {
    const total = messages.length
    const requestedLimit = options.limit ?? total
    const limit = Math.max(1, Math.min(requestedLimit, total || requestedLimit))
    const before = Math.min(Math.max(0, options.before ?? total), total)
    const startIndex = Math.max(0, before - limit)

    return {
        messages: messages.slice(startIndex, before),
        startIndex,
        page: {
            limit,
            nextBefore: startIndex > 0 ? startIndex : null,
            hasMore: startIndex > 0
        }
    }
}

/**
 * Builds a page from already parsed transcript messages. The runner uses this
 * to serve subsequent status/context reads from its native transcript cache
 * without re-reading a JSONL file.
 */
export function createLocalCodexSessionData(
    session: CodexLocalSessionSummary,
    importedMessages: CodexImportedMessageContent[],
    options: CodexLocalSessionReadOptions = {},
    subagents: CodexLocalSessionSubagent[] = []
): CodexLocalSessionData {
    const transcriptPage = getCodexTranscriptMessagePage(importedMessages, options)
    return {
        session,
        context: getCodexTranscriptContextFromImportedMessages(transcriptPage.messages),
        importedMessages: transcriptPage.messages,
        subagents,
        startIndex: transcriptPage.startIndex,
        page: transcriptPage.page
    }
}

export function getLocalCodexSessionData(
    sessionId: string,
    options: CodexLocalSessionReadOptions = {}
): CodexLocalSessionData | null {
    const session = findLocalCodexSession(sessionId)
    if (!session) return null
    const importedMessages = parseCodexTranscriptImportData(session)?.messages ?? []
    return createLocalCodexSessionData(
        session,
        importedMessages,
        options,
        listLocalCodexSessionSubagents(session.id)
    )
}
