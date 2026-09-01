import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
    createCodexUserMessageMirrorDeduper,
    normalizeCodexUserMessageContent,
    normalizeCodexUserMessageText
} from './codexUserMessage'
import { parseAutomationHeartbeatMessageContent } from './messages'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'
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
}

/** Runner-to-browser list update; the local transcript path stays private. */
export type CodexLocalSessionListUpdate = Omit<CodexLocalSessionSummary, 'file'>

export type CodexLocalSessionConfig = {
    model: string | null
    modelReasoningEffort: string | null
}

export type CodexLocalSessionListOptions = {
    /** Exclude threads created through HAPI's Codex app-server client. */
    excludeHapiInitiated?: boolean
}

/**
 * Codex persists the app-server client's `clientInfo.name` as the transcript
 * originator. Keep this in one place so the runner and hub apply the same
 * definition of a HAPI-initiated thread.
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

export type CodexLocalSessionData = {
    session: CodexLocalSessionSummary
    context: CodexLocalSessionContextMessage[]
    importedMessages: CodexImportedMessageContent[]
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

/**
 * Runner-owned progress for a prompt sent into an original native Codex
 * thread. The stages deliberately describe the hand-off, not model output.
 */
export type CodexLocalSessionDirectSendPhase =
    | 'launching'
    | 'matching'
    | 'connected'
    /** The primary bridge failed before delivery, so HAPI is trying its exact-thread fallback. */
    | 'retrying'
    | 'reasoning'

export type CodexLocalSessionDirectSendProgress = {
    phase: CodexLocalSessionDirectSendPhase
    /** One stable clock for the whole hand-off, including fallback transport. */
    startedAt: number
    /** Lets clients show the duration of the currently visible stage. */
    phaseStartedAt: number
    transport: 'app-server' | 'exec-resume'
    /** Present after HAPI switches from the primary bridge to its safe fallback. */
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
    /**
     * The native transcript still says a turn is running but has not changed
     * for a long time. This is only a recovery hint: HAPI never retries a
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

/** Capabilities that can safely be presented in an original native thread. */
export type CodexLocalSessionComposerCapabilities = {
    /** Custom prompts only. HAPI-owned control commands cannot alter a native thread. */
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
    /** Monotonic for the lifetime of a runner process and native thread. */
    revision: number
    timing: CodexLocalSessionReadTiming
}

export type CodexLocalSessionSnapshotRpcResponse = {
    success: true
    snapshot: CodexLocalSessionSnapshot
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
    revision: number
    status: Extract<CodexLocalSessionStatusRpcResponse, { success: true }>
    timing: CodexLocalSessionReadTiming
    /** Present after a transcript append; omitted for a status-only update. */
    session?: Pick<CodexLocalSessionSummary, 'id' | 'title' | 'cwd' | 'modifiedAt' | 'model' | 'modelReasoningEffort'>
    importedMessages?: CodexImportedMessageContent[]
    startIndex?: number
    page?: CodexLocalSessionPage
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

/** Internal runner policy for prompts generated by a HAPI Kanban review. */
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
    code: 'session_not_found' | 'session_busy' | 'session_status_unknown' | 'workspace_unavailable' | 'invalid_message' | 'invalid_client_message_id' | 'launch_failed' | 'queue_full' | 'not_native_session'
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
 * destructive stop-and-archive action: the runner reserves it against HAPI
 * delivery and protects saved HAPI queue receipts while Codex performs it.
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
}

export type CodexTranscriptFileCandidate = {
    file: string
    modifiedAt: number
    size: number
}

const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 500
const MAX_CODEX_CONTEXT_MESSAGES = 2_000
const MAX_CODEX_CONTEXT_MESSAGE_CHARS = 24_000
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

function inferSessionIdFromFileName(filePath: string): string | null {
    const match = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(filePath)
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

/**
 * Newer Codex rollouts represent the built-in terminal as a custom tool.
 * Normalize it to the same semantic tool name used by live HAPI messages so
 * native and HAPI details can share the exact renderer and grouping rules.
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

function getCodexSummaryTailLines(filePath: string, size: number): string[] | null {
    const offset = Math.max(0, size - CODEX_SESSION_SUMMARY_WINDOW_BYTES)
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
    }
): CodexLocalSessionSummary | null {
    if (header.isSubagent) return null

    const sessionId = header.sessionId ?? inferSessionIdFromFileName(filePath)
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
        runState: latest.runState
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
            runState: getCodexTranscriptRunState(content)
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
        runState: tail.runState ?? 'unknown'
    })
}

export function listCodexTranscriptFilesByRecency(): CodexTranscriptFileCandidate[] {
    const files: CodexTranscriptFileCandidate[] = []
    collectJsonlFiles(join(getCodexHome(), 'sessions'), files)
    return files.sort((left, right) => right.modifiedAt - left.modifiedAt)
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
        const inferredId = inferSessionIdFromFileName(candidate.file)
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
            } else if (eventType === 'task_complete' || eventType === 'turn_aborted') {
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
                } else if (eventType === 'task_complete' || eventType === 'turn_aborted') {
                    summary.runState = 'idle'
                }
            }
        } catch {
            // A live writer can expose an incomplete final JSONL record.
        }
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
    startedAtByCallId: Map<string, number>
    toolResultIndexesByCallId: Map<string, number[]>
    pendingHeartbeatTimestamp?: number
}

export function createCodexTranscriptImportAccumulator(): CodexTranscriptImportAccumulator {
    return {
        messages: [],
        canonicalChatMessageIndexByRolloutKey: new Map(),
        userMessageMirrorDeduper: createCodexUserMessageMirrorDeduper(),
        startedAtByCallId: new Map(),
        toolResultIndexesByCallId: new Map()
    }
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
            let message = convertCodexRecordToImportedMessage(record)
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
    options: CodexLocalSessionReadOptions = {}
): CodexLocalSessionData {
    const transcriptPage = getCodexTranscriptMessagePage(importedMessages, options)
    return {
        session,
        context: getCodexTranscriptContextFromImportedMessages(transcriptPage.messages),
        importedMessages: transcriptPage.messages,
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
    return createLocalCodexSessionData(session, importedMessages, options)
}
