import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseAutomationHeartbeatMessageContent } from './messages'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'

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

export type CodexLocalSessionStatusRpcResponse = {
    success: true
    status: CodexLocalSessionRunState
    /** Present while the runner owns a direct native send for this thread. */
    startedAt?: number
    /** Short runner-side launch/exit failure, if the most recent send failed. */
    lastError?: string
    /** Messages waiting for the native thread to become idle. */
    queuedMessages?: CodexLocalSessionQueuedMessage[]
} | {
    success: false
    error: string
}

export type CodexLocalSessionQueuedMessage = {
    id: string
    text: string
    queuedAt: number
}

export type SendCodexLocalSessionMessageRpcResponse = {
    success: true
    status: 'processing' | 'queued'
    /** Present when the request started a Codex child immediately. */
    startedAt?: number
    /** Present when the request waits behind an existing native turn. */
    queuedAt?: number
    queuePosition?: number
    queueId?: string
    queuedMessages?: CodexLocalSessionQueuedMessage[]
} | {
    success: false
    error: string
    code: 'session_not_found' | 'session_busy' | 'session_status_unknown' | 'workspace_unavailable' | 'invalid_message' | 'launch_failed' | 'queue_full'
}

type CodexTranscriptFileCandidate = {
    file: string
    modifiedAt: number
}

const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 500
const MAX_CODEX_CONTEXT_MESSAGES = 2_000
const MAX_CODEX_CONTEXT_MESSAGE_CHARS = 24_000

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
            files.push({ file: fullPath, modifiedAt: statSync(fullPath).mtimeMs })
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

function getCodexRolloutTimestampKey(value: string | null): string | null {
    if (!value) return null
    const milliseconds = Date.parse(value)
    // event_msg and response_item are emitted by separate streams and can
    // differ by a few milliseconds for the same user-visible turn.
    return Number.isFinite(milliseconds) ? String(Math.round(milliseconds / 1_000)) : value
}

function shouldIgnoreSyntheticUserMessage(text: string): boolean {
    const normalized = text.trim()
    return normalized.startsWith('# AGENTS.md instructions')
        || normalized.startsWith('<environment_context>')
        || normalized.startsWith('<app-context>')
        || normalized.startsWith('<skills_instructions>')
        || normalized.startsWith('<permissions instructions>')
        || normalized.startsWith('<collaboration_mode>')
        || normalized.startsWith('<plugins_instructions>')
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

/** Attach transcript timestamps so imported tool cards show real durations. */
function enrichImportedToolTiming(messages: CodexImportedMessageContent[]): CodexImportedMessageContent[] {
    const startedAtByCallId = new Map<string, number>()

    for (const message of messages) {
        if (message.role !== 'agent' || message.createdAt === undefined) continue
        const data = asRecord(message.content.data)
        if (data?.type !== 'tool-call') continue
        const callId = asString(data.callId)
        if (callId && !startedAtByCallId.has(callId)) {
            startedAtByCallId.set(callId, message.createdAt)
        }
    }

    return messages.map((message) => {
        if (message.role !== 'agent' || message.createdAt === undefined) return message
        const data = asRecord(message.content.data)
        if (!data) return message
        const callId = asString(data.callId)
        if (!callId) return message

        const startedAt = startedAtByCallId.get(callId)
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
    })
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
            const text = extractCodexText(payload.content)
            if (text && !shouldIgnoreSyntheticUserMessage(text)) return truncateText(text, 140)
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
    if (changedTitle) return truncateText(changedTitle, 80)
    if (firstUserMessage) return truncateText(firstUserMessage, 80)
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

function parseCodexLocalSession(filePath: string, knownModifiedAt?: number): CodexLocalSessionSummary | null {
    let content: string
    try {
        content = readFileSync(filePath, 'utf-8')
    } catch {
        return null
    }

    const allLines = content.split(/\r?\n/).filter(Boolean)
    const headLines = allLines.slice(0, 200)
    let sessionId: string | null = null
    let cwd: string | null = null
    let originator: string | null = null
    let cliVersion: string | null = null
    let firstUserMessage: string | null = null

    for (const line of headLines) {
        try {
            const record = asRecord(JSON.parse(line))
            const type = typeof record?.type === 'string' ? record.type : null
            if (type === 'session_meta') {
                const payload = asRecord(record?.payload)
                if (payload) {
                    if (isSubagentSource(payload.source)) return null
                    if (!sessionId && typeof payload.id === 'string') sessionId = payload.id
                    if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
                    if (!originator && typeof payload.originator === 'string') originator = payload.originator
                    if (!cliVersion && typeof payload.cli_version === 'string') cliVersion = payload.cli_version
                }
            }
            if (!firstUserMessage && type === 'response_item') {
                const payload = asRecord(record?.payload)
                if (payload?.type === 'message' && payload.role === 'user') {
                    const text = extractCodexText(payload.content)
                    if (text && !shouldIgnoreSyntheticUserMessage(text)) firstUserMessage = text
                }
            }
        } catch {
            // Ignore malformed transcript records.
        }
    }

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null
    const modifiedAt = knownModifiedAt ?? (() => {
        try {
            return statSync(filePath).mtimeMs
        } catch {
            return Date.now()
        }
    })()
    const config = getLatestCodexSessionConfig(allLines)

    return {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, getLatestCodexChangedTitle(allLines), firstUserMessage),
        lastUserMessage: getLatestCodexUserMessage(allLines),
        cwd,
        file: filePath,
        modifiedAt,
        originator,
        cliVersion,
        model: config.model,
        modelReasoningEffort: config.modelReasoningEffort,
        runState: getCodexTranscriptRunState(content)
    }
}

function listCodexTranscriptFilesByRecency(): CodexTranscriptFileCandidate[] {
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
        const session = parseCodexLocalSession(candidate.file, candidate.modifiedAt)
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
        const session = parseCodexLocalSession(candidate.file, candidate.modifiedAt)
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
            const text = asString(payload.message) ?? asString(payload.text) ?? asString(payload.content)
            return text && !shouldIgnoreSyntheticUserMessage(text) ? buildImportedUserMessage(text, createdAt) : null
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
        return null
    }

    if (type !== 'response_item') return null
    const itemType = asString(payload.type)
    if (!itemType) return null
    if (itemType === 'message') {
        const role = asString(payload.role)
        const text = extractCodexText(payload.content)
        if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
        if (role === 'user') return buildImportedUserMessage(text, createdAt)
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

export function parseCodexTranscriptImportData(summary: CodexLocalSessionSummary): CodexTranscriptImportData | null {
    let content: string
    try {
        content = readFileSync(summary.file, 'utf-8')
    } catch {
        return null
    }

    const messages: CodexImportedMessageContent[] = []
    const canonicalChatMessageIndexByRolloutKey = new Map<string, number>()
    let pendingHeartbeatTimestamp: number | undefined
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
        try {
            const record = asRecord(JSON.parse(line))
            if (!record) continue
            let message = convertCodexRecordToImportedMessage(record)
            if (!message) continue

            const heartbeatTimestamp = getHeartbeatTimestamp(message)
            if (message.role === 'user') {
                pendingHeartbeatTimestamp = heartbeatTimestamp
            }
            if (heartbeatTimestamp !== undefined) {
                message = { ...message, createdAt: heartbeatTimestamp }
            } else if (message.role === 'agent' && pendingHeartbeatTimestamp !== undefined
                && parseAutomationHeartbeatMessageContent(message.content)) {
                message = { ...message, createdAt: pendingHeartbeatTimestamp }
            }

            const fingerprint = importedChatMessageFingerprint(message)
            const timestamp = getCodexRolloutTimestampKey(asString(record.timestamp))
            const rolloutKey = fingerprint && timestamp ? `${timestamp}\u0000${fingerprint}` : null
            if (rolloutKey) {
                const existingIndex = canonicalChatMessageIndexByRolloutKey.get(rolloutKey)
                if (existingIndex !== undefined) {
                    if (record.type === 'response_item') messages[existingIndex] = message
                    continue
                }
                canonicalChatMessageIndexByRolloutKey.set(rolloutKey, messages.length)
            }
            messages.push(message)
        } catch {
            // Ignore malformed transcript records.
        }
    }
    return { ...summary, messages: enrichImportedToolTiming(messages) }
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

export function getLocalCodexSessionData(
    sessionId: string,
    options: CodexLocalSessionReadOptions = {}
): CodexLocalSessionData | null {
    const session = findLocalCodexSession(sessionId)
    if (!session) return null
    const importedMessages = parseCodexTranscriptImportData(session)?.messages ?? []
    const transcriptPage = getCodexTranscriptMessagePage(importedMessages, options)
    return {
        session,
        context: getCodexTranscriptContextFromImportedMessages(transcriptPage.messages),
        importedMessages: transcriptPage.messages,
        startIndex: transcriptPage.startIndex,
        page: transcriptPage.page
    }
}
