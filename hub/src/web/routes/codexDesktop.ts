import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, hostname, platform } from 'node:os'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import {
    getLatestCodexSessionConfig,
    isHapiInitiatedCodexSession,
    normalizeCodexCustomToolInput,
    normalizeCodexCustomToolName,
    normalizeCodexCustomToolOutput,
    readLocalCodexSessionSummary,
    type CodexLocalSessionData as RunnerCodexLocalSessionData,
    type CodexLocalSessionReadTiming,
    type CodexLocalSessionStatusRpcResponse,
    type SendCodexLocalSessionMessageRpcResponse
} from '@hapi/protocol/codexTranscript'
import { parseAutomationHeartbeatMessageContent } from '@hapi/protocol/messages'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { Store, StoredMessage } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

type ScriptLogKind = 'sync' | 'restart'

const DIRECT_IMPORT_COMMAND = 'direct-import'
const RESTART_SCRIPT_ENV_NAME = 'HAPI_CODEX_RESTART_SCRIPT'
const RESTART_SCRIPT_DEFAULT_FILE = 'Restart-CodexDesktop.ps1'
const RESTART_SCRIPT_ARGS = ['-Apply']
const RESTART_SCRIPT_MESSAGE = 'Codex Desktop restart script started'

type ScriptLaunchResponse = {
    success: true
    message: string
    pid: number
    command: string
    script?: string
    cwd: string
    output?: string
    codexDesktopRunning?: boolean
    codexClientAvailable?: boolean
    syncedCount?: number
    sessionIds?: string[]
} | {
    success: false
    error: string
    script?: string
    cwd: string
    output?: string
    codexDesktopRunning?: boolean
    codexClientAvailable?: boolean
    syncedCount?: number
    sessionIds?: string[]
}

type CodexDesktopStatus = {
    running: boolean
    clientAvailable: boolean
}

type CodexDesktopStatusResponse = {
    success: true
    codexDesktopRunning: boolean
    codexClientAvailable: boolean
}

type CodexLocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    runState?: 'idle' | 'processing' | 'unknown'
}

type CodexTranscriptFileCandidate = {
    file: string
    modifiedAt: number
    size: number
}

type CodexLocalSessionsResponse = {
    success: true
    sessions: CodexLocalSessionSummary[]
}

type CodexLocalSessionContextMessage = {
    id: string
    createdAt: number
    position?: number
    content: CodexImportedMessageContent
}

type CodexLocalSessionContextResponse = {
    success: true
    session: Pick<CodexLocalSessionSummary, 'id' | 'title' | 'cwd' | 'modifiedAt' | 'model' | 'modelReasoningEffort'>
    messages: CodexLocalSessionContextMessage[]
    page: {
        limit: number
        nextBefore: number | null
        hasMore: boolean
    }
}

type CodexLocalSessionSnapshotResponse = CodexLocalSessionContextResponse & {
    status: Extract<CodexLocalSessionStatusRpcResponse, { success: true }>
    revision: number
    timing: CodexLocalSessionReadTiming
}

type ForkCodexLocalSessionResponse = {
    type: 'success'
    sessionId: string
    session?: unknown
} | {
    type: 'error'
    code?: 'hub_unavailable' | 'invalid_fork_request' | 'runner_offline' | 'session_read_failed' | 'session_not_found' | 'workspace_missing' | 'codex_home_unavailable' | 'fork_spawn_failed'
    message: string
}

type DirectCodexLocalSessionTarget = {
    type: 'success'
    machine: Machine
} | {
    type: 'error'
    status: 404 | 409 | 502 | 503
    message: string
}

type CodexImportedMessageContent = {
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

type CodexTranscriptImportData = CodexLocalSessionSummary & {
    messages: CodexImportedMessageContent[]
}

type ImportCandidate = {
    sessionId: string
    active: boolean
    updatedAt: number
    metadata: Record<string, unknown> | null
}

type ImportTargetSelection = {
    sessionId: string | null
    comparablePrefixCount: number
}

type SyncSessionRequestParseResult = {
    sessionIds: string[]
    error?: string
}

type CodexDuplicateSessionGroup = {
    codexSessionId: string
    hapiSessionIds: string[]
    canonicalSessionId?: string
    removedSessionIds?: string[]
}

type CodexDuplicateSessionsResponse = {
    success: true
    duplicates: CodexDuplicateSessionGroup[]
} | {
    success: false
    error: string
}

type CodexMergeDuplicateSessionsResponse = {
    success: true
    merged: CodexDuplicateSessionGroup[]
    mergedCount: number
} | {
    success: false
    error: string
}

type DuplicateSessionGroupCandidate = {
    codexSessionId: string
    sessions: ImportCandidate[]
}

const CODEX_DESKTOP_NOT_FOUND_ERROR = '尝试重启codex客户端失败，未安装/找不到codex客户端'
const SCRIPT_TIMEOUT_ERROR = '执行超时'
const NO_SYNC_SESSION_SELECTED_ERROR = '未选择需要导入的 Codex 会话'
const CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR = 'Codex transcript import is not available outside the default namespace'
const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000
const DEFAULT_CODEX_SESSION_SCAN_LIMIT = 500
const DEFAULT_RECENT_CODEX_SESSION_LIMIT = 5
const DEFAULT_RECENT_CODEX_CONTEXT_PAGE_LIMIT = 50
const CODEX_SESSION_SUMMARY_FULL_READ_MAX_BYTES = 512 * 1024

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

function getScriptRoot(): string {
    const configured = process.env.HAPI_CODEX_SCRIPT_ROOT?.trim()
    return configured ? resolveLocalPath(configured) : process.cwd()
}

function getDefaultScriptPath(defaultFile: string): string {
    const configuredRoot = process.env.HAPI_CODEX_SCRIPT_ROOT?.trim()
    if (configuredRoot) {
        return join(resolveLocalPath(configuredRoot), defaultFile)
    }

    const cwd = process.cwd()
    const candidateRoots = [
        cwd,
        resolve(cwd, '..'),
        resolve(cwd, '..', '..')
    ]

    for (const root of candidateRoots) {
        const candidate = join(root, defaultFile)
        if (existsSync(candidate)) {
            return candidate
        }
    }

    return join(getScriptRoot(), defaultFile)
}

function getRestartScriptPath(): string {
    const configured = process.env[RESTART_SCRIPT_ENV_NAME]?.trim()
    return configured ? resolveLocalPath(configured) : getDefaultScriptPath(RESTART_SCRIPT_DEFAULT_FILE)
}

function getWorkspace(scriptPath: string): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(configured) : dirname(scriptPath)
}

function getDirectImportWorkspace(): string {
    const configured = process.env.HAPI_CODEX_WORKSPACE?.trim()
    return configured ? resolveLocalPath(configured) : process.cwd()
}

function expandHomePath(pathValue: string): string {
    return pathValue.replace(/^~(?=$|[\\/])/, homedir())
}

function getCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim()
    return configured ? resolveLocalPath(expandHomePath(configured)) : join(homedir(), '.codex')
}

/** Codex transcripts read here live on the Hub host, never on an arbitrary runner. */
function getCodexTranscriptHost(): string {
    return process.env.HAPI_HOSTNAME?.trim() || hostname()
}

function getCodexSessionRoots(): string[] {
    const codexHome = getCodexHome()
    // 中文注释：当前 direct import 只从 sessions 目录解析 transcript，避免把 archived_sessions 中暂不参与导入的会话展示给用户。
    return [join(codexHome, 'sessions')]
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
        if (entry.isFile() && fullPath.toLowerCase().endsWith('.jsonl')) {
            try {
                const stats = statSync(fullPath)
                files.push({
                    file: fullPath,
                    modifiedAt: stats.mtimeMs,
                    size: stats.size
                })
            } catch {
                // The transcript can disappear while Codex rotates sessions.
            }
        }
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read the last native turn lifecycle from a host-local Codex transcript.
 * Keep the Hub-side scanner aligned with the runner/shared scanner: the
 * no-machineId path is used by the native session list and must expose the
 * same processing state as the runner RPC path.
 */
function getCodexTranscriptRunState(content: string): 'idle' | 'processing' | 'unknown' {
    let state: 'idle' | 'processing' | 'unknown' = 'unknown'
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
            // Ignore a partially-written final transcript line.
        }
    }
    return state
}

function extractCodexText(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim()
    }
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
    if (record?.type === 'text' && typeof record.text === 'string') {
        return record.text.trim()
    }
    if (record?.type === 'input_text' && typeof record.text === 'string') {
        return record.text.trim()
    }
    if (record?.type === 'output_text' && typeof record.text === 'string') {
        return record.text.trim()
    }
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
    if (typeof value !== 'string') {
        return value
    }

    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return value
    }

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
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
    }
    return null
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
    const type = typeof record.type === 'string' ? record.type : null
    if (type === 'response_item') {
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

    if (type === 'event_msg') {
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
    // 中文注释：Codex 会在 transcript 中记录 change_title 调用；这里从后往前取最后一次成功设置的标题，作为弹窗主标题显示。
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index])
            const record = asRecord(parsed)
            if (!record) continue
            const title = extractCodexChangedTitle(record)
            if (title) {
                return title
            }
        } catch {
            continue
        }
    }
    return null
}

function getLatestCodexUserMessage(lines: string[]): string | null {
    // 中文注释：弹窗副标题展示最近一次真实用户提问，不再显示路径，便于用户按会话内容而不是目录来识别。
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index])
            const record = asRecord(parsed)
            if (!record || record.type !== 'response_item') continue
            const payload = asRecord(record.payload)
            if (payload?.type !== 'message' || payload.role !== 'user') continue
            const text = extractCodexText(payload.content)
            if (text && !shouldIgnoreSyntheticUserMessage(text)) {
                return truncateText(text, 140)
            }
        } catch {
            continue
        }
    }
    return null
}

function getCodexSessionTitle(
    cwd: string | null | undefined,
    sessionId: string,
    changedTitle: string | null,
    firstUserMessage: string | null
): string {
    if (changedTitle) {
        return truncateText(changedTitle, 80)
    }

    if (firstUserMessage) {
        return truncateText(firstUserMessage, 80)
    }

    if (cwd) {
        const parts = cwd.split(/[\\/]+/).filter(Boolean)
        if (parts.length > 0) {
            return parts[parts.length - 1]
        }
    }

    return sessionId.slice(0, 8)
}

function isSubagentSource(value: unknown): boolean {
    const record = asRecord(value)
    return record ? Object.prototype.hasOwnProperty.call(record, 'subagent') : false
}

function parseCodexLocalSession(
    filePath: string,
    knownModifiedAt?: number,
    knownSize?: number
): CodexLocalSessionSummary | null {
    if (knownSize !== undefined && knownSize > CODEX_SESSION_SUMMARY_FULL_READ_MAX_BYTES) {
        return readLocalCodexSessionSummary(filePath, knownModifiedAt, knownSize)
    }

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
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }

        const record = asRecord(parsed)
        const type = typeof record?.type === 'string' ? record.type : null
        if (type === 'session_meta') {
            const payload = asRecord(record?.payload)
            if (payload) {
                if (isSubagentSource(payload.source)) {
                    return null
                }
                if (!sessionId && typeof payload.id === 'string') {
                    sessionId = payload.id
                }
                if (!cwd && typeof payload.cwd === 'string') {
                    cwd = payload.cwd
                }
                if (!originator && typeof payload.originator === 'string') {
                    originator = payload.originator
                }
                if (!cliVersion && typeof payload.cli_version === 'string') {
                    cliVersion = payload.cli_version
                }
            }
        }

        if (!firstUserMessage && type === 'response_item') {
            const payload = asRecord(record?.payload)
            if (payload?.type === 'message' && payload.role === 'user') {
                const text = extractCodexText(payload.content)
                if (text && !shouldIgnoreSyntheticUserMessage(text)) {
                    firstUserMessage = text
                }
            }
        }
    }

    const changedTitle = getLatestCodexChangedTitle(allLines)
    const lastUserMessage = getLatestCodexUserMessage(allLines)
    const config = getLatestCodexSessionConfig(allLines)

    sessionId = sessionId ?? inferSessionIdFromFileName(filePath)
    if (!sessionId) return null

    const modifiedAt = knownModifiedAt ?? (() => {
        try {
            return statSync(filePath).mtimeMs
        } catch {
            // Fall back to current time if stat fails during a concurrent file change.
            return Date.now()
        }
    })()

    return {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, changedTitle, firstUserMessage),
        lastUserMessage,
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
    for (const root of getCodexSessionRoots()) {
        collectJsonlFiles(root, files)
    }
    return files.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

function listLocalCodexSessions(
    limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT,
    options: { excludeHapiInitiated?: boolean } = {}
): CodexLocalSessionSummary[] {
    const sessions: CodexLocalSessionSummary[] = []
    const seenSessionIds = new Set<string>()
    // Stat every file cheaply, then only read enough newest rollouts to fill
    // the requested page instead of every transcript.
    for (const candidate of listCodexTranscriptFilesByRecency()) {
        const session = parseCodexLocalSession(candidate.file, candidate.modifiedAt, candidate.size)
        if (!session) continue
        if (seenSessionIds.has(session.id)) continue
        if (options.excludeHapiInitiated && isHapiInitiatedCodexSession(session)) continue
        seenSessionIds.add(session.id)
        sessions.push(session)
        if (sessions.length >= limit) break
    }
    return sessions
}

function findLocalCodexSession(sessionId: string): CodexLocalSessionSummary | null {
    for (const candidate of listCodexTranscriptFilesByRecency()) {
        const inferredId = inferSessionIdFromFileName(candidate.file)
        if (inferredId && inferredId !== sessionId) continue
        const session = parseCodexLocalSession(candidate.file, candidate.modifiedAt, candidate.size)
        if (session?.id === sessionId) return session
    }
    return null
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
        content: {
            type: 'text',
            text
        },
        meta: {
            sentFrom: 'cli'
        }
    }
}

function buildImportedAgentMessage(data: unknown, createdAt?: number): CodexImportedMessageContent {
    return {
        ...(createdAt === undefined ? {} : { createdAt }),
        role: 'agent',
        content: {
            type: AGENT_MESSAGE_PAYLOAD_TYPE,
            data
        },
        meta: {
            sentFrom: 'cli'
        }
    }
}

function convertCodexRecordToImportedMessage(record: Record<string, unknown>): CodexImportedMessageContent | null {
    const type = asString(record.type)
    const payload = asRecord(record.payload)
    if (!type || !payload) {
        return null
    }

    const createdAt = getCodexRecordTimestamp(record)

    if (type === 'event_msg') {
        const eventType = asString(payload.type)
        if (!eventType) {
            return null
        }

        if (eventType === 'user_message') {
            const text = asString(payload.message)
                ?? asString(payload.text)
                ?? asString(payload.content)
            if (!text || shouldIgnoreSyntheticUserMessage(text)) {
                return null
            }
            return buildImportedUserMessage(text, createdAt)
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

    if (type === 'response_item') {
        const itemType = asString(payload.type)
        if (!itemType) {
            return null
        }

        if (itemType === 'message') {
            const role = asString(payload.role)
            const text = extractCodexText(payload.content)
            if (!text || shouldIgnoreSyntheticUserMessage(text)) {
                return null
            }
            if (role === 'user') {
                return buildImportedUserMessage(text, createdAt)
            }
            if (role === 'assistant') {
                return buildImportedAgentMessage({ type: 'message', message: text, id: randomUUID() }, createdAt)
            }
            return null
        }

        if (itemType === 'custom_tool_call') {
            const name = asString(payload.name)
            const callId = extractCodexToolCallId(payload)
            if (!name || !callId) {
                return null
            }
            return buildImportedAgentMessage({
                type: 'tool-call',
                name: normalizeCodexCustomToolName(name),
                callId,
                input: normalizeCodexCustomToolInput(name, payload.input),
                id: randomUUID()
            }, createdAt)
        }

        if (itemType === 'custom_tool_call_output') {
            const callId = extractCodexToolCallId(payload)
            if (!callId) {
                return null
            }
            return buildImportedAgentMessage({
                type: 'tool-call-result',
                callId,
                output: normalizeCodexCustomToolOutput(payload.output),
                id: randomUUID()
            }, createdAt)
        }

        if (itemType === 'function_call') {
            const name = asString(payload.name)
            const callId = extractCodexToolCallId(payload)
            if (!name || !callId) {
                return null
            }
            return buildImportedAgentMessage({
                type: 'tool-call',
                name,
                callId,
                input: parseCodexFunctionArguments(payload.arguments),
                id: randomUUID()
            }, createdAt)
        }

        if (itemType === 'function_call_output') {
            const callId = extractCodexToolCallId(payload)
            if (!callId) {
                return null
            }
            return buildImportedAgentMessage({
                type: 'tool-call-result',
                callId,
                output: payload.output,
                id: randomUUID()
            }, createdAt)
        }
    }

    return null
}

function importedChatMessageFingerprint(message: CodexImportedMessageContent): string | null {
    if (message.role === 'user') {
        return `user:${message.content.text.trim()}`
    }

    const data = asRecord(message.content.data)
    if (data?.type !== 'message') {
        return null
    }
    const text = asString(data.message)?.trim()
    return text ? `assistant:${text}` : null
}

function getHeartbeatTimestamp(message: CodexImportedMessageContent): number | undefined {
    const heartbeat = parseAutomationHeartbeatMessageContent(message.content)
    if (!heartbeat?.currentTimeIso) return undefined
    const timestamp = Date.parse(heartbeat.currentTimeIso)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function parseCodexTranscriptImportData(summary: CodexLocalSessionSummary): CodexTranscriptImportData | null {
    let content: string
    try {
        content = readFileSync(summary.file, 'utf-8')
    } catch {
        return null
    }

    const lines = content.split(/\r?\n/).filter(Boolean)
    const messages: CodexImportedMessageContent[] = []
    const canonicalChatMessageIndexByRolloutKey = new Map<string, number>()
    let pendingHeartbeatTimestamp: number | undefined

    for (const line of lines) {
        let parsed: unknown
        try {
            parsed = JSON.parse(line)
        } catch {
            continue
        }

        const record = asRecord(parsed)
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
        // Standard Codex rollouts write the same chat item in both formats at
        // the same timestamp. Prefer response_item but do not globally dedupe
        // identical text from separate turns.
        if (rolloutKey) {
            const existingIndex = canonicalChatMessageIndexByRolloutKey.get(rolloutKey)
            if (existingIndex !== undefined) {
                if (record.type === 'response_item') {
                    messages[existingIndex] = message
                }
                continue
            }
            canonicalChatMessageIndexByRolloutKey.set(rolloutKey, messages.length)
        }
        messages.push(message)
    }

    return {
        ...summary,
        messages: enrichImportedToolTiming(messages)
    }
}

function createCodexTranscriptContextMessages(
    sessionId: string,
    messages: CodexImportedMessageContent[],
    startIndex = 0,
    fallbackCreatedAt = Date.now()
): CodexLocalSessionContextMessage[] {
    return messages.map((content, index) => ({
        // The imported transcript does not retain HAPI store row IDs. Stable
        // local IDs keep React/thread reconciliation intact across pages.
        id: `codex-local:${sessionId}:${startIndex + index}`,
        createdAt: content.createdAt ?? fallbackCreatedAt,
        position: startIndex + index,
        content
    }))
}

function createRunnerCodexSessionContextResponse(
    data: RunnerCodexLocalSessionData,
    revision: number
): CodexLocalSessionContextResponse & { revision: number } {
    const { session, importedMessages } = data
    return {
        success: true,
        session: {
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            modifiedAt: session.modifiedAt,
            model: session.model,
            modelReasoningEffort: session.modelReasoningEffort
        },
        messages: createCodexTranscriptContextMessages(session.id, importedMessages, data.startIndex, session.modifiedAt),
        page: data.page,
        revision
    }
}

function paginateCodexTranscriptMessages(
    messages: CodexImportedMessageContent[],
    limit: number,
    before?: number
): { messages: CodexImportedMessageContent[]; startIndex: number; page: CodexLocalSessionContextResponse['page'] } {
    const endIndex = Math.min(Math.max(0, before ?? messages.length), messages.length)
    const startIndex = Math.max(0, endIndex - limit)
    return {
        messages: messages.slice(startIndex, endIndex),
        startIndex,
        page: {
            limit,
            nextBefore: startIndex > 0 ? startIndex : null,
            hasMore: startIndex > 0
        }
    }
}

function getCodexTranscriptContextPage(
    summary: CodexLocalSessionSummary,
    limit: number,
    before?: number
): { messages: CodexLocalSessionContextMessage[]; page: CodexLocalSessionContextResponse['page'] } {
    const transcript = parseCodexTranscriptImportData(summary)
    const transcriptPage = paginateCodexTranscriptMessages(transcript?.messages ?? [], limit, before)
    return {
        messages: createCodexTranscriptContextMessages(summary.id, transcriptPage.messages, transcriptPage.startIndex, summary.modifiedAt),
        page: transcriptPage.page
    }
}

function parseCodexSessionLimit(value: string | undefined): number | null {
    if (value === undefined) return null
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return null
    return parsed
}

function parseExcludeHapiInitiated(value: string | undefined): boolean | null {
    if (value === undefined || value === 'false') return false
    if (value === 'true') return true
    return null
}

function parseForceRefresh(value: string | undefined): boolean | null {
    if (value === undefined || value === 'false') return false
    if (value === 'true') return true
    return null
}

function parseCodexContextPageLimit(value: string | undefined): number | null {
    if (value === undefined) return DEFAULT_RECENT_CODEX_CONTEXT_PAGE_LIMIT
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null
}

function parseCodexContextBefore(value: string | undefined): number | null | undefined {
    if (value === undefined) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseCodexRunnerMachineId(value: string | undefined): string | null {
    const machineId = value?.trim()
    return machineId ? machineId : null
}

function parseForkCodexLocalSessionRequest(value: unknown): { machineId: string } | null {
    if (value === null || value === undefined) return null
    const record = asRecord(value)
    if (!record) return null
    const machineId = record.machineId
    if (typeof machineId !== 'string' || !machineId.trim()) return null
    return { machineId: machineId.trim() }
}

function parseSendCodexLocalSessionMessageRequest(value: unknown): { machineId: string; message: string } | null {
    const record = asRecord(value)
    if (!record) return null
    const machineId = typeof record.machineId === 'string' ? record.machineId.trim() : ''
    const message = typeof record.message === 'string' ? record.message.trim() : ''
    if (!machineId || !message) return null
    return { machineId, message }
}

function getOnlineCodexRunner(engine: SyncEngine, namespace: string, machineId: string): Machine | null {
    return engine.getOnlineMachinesByNamespace(namespace).find((machine) => machine.id === machineId) ?? null
}

function normalizeComparablePath(pathValue: string, options?: { caseInsensitive?: boolean }): string {
    let normalized = pathValue.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, '')
    }
    return options?.caseInsensitive ? normalized.toLowerCase() : normalized
}

function shouldCompareCaseInsensitive(...pathValues: string[]): boolean {
    return pathValues.some((pathValue) => /^[a-z]:[\\/]/i.test(pathValue) || pathValue.includes('\\'))
}

function isPathInsideWorkspaceRoot(pathValue: string, rootValue: string): boolean {
    if (!pathValue.trim() || !rootValue.trim()) {
        return false
    }

    const caseInsensitive = shouldCompareCaseInsensitive(pathValue, rootValue)
    const path = normalizeComparablePath(pathValue, { caseInsensitive })
    const root = normalizeComparablePath(rootValue, { caseInsensitive })
    if (!path || !root) {
        return false
    }
    if (path === root) {
        return true
    }
    if (root === '/') {
        return path.startsWith('/')
    }
    return path.startsWith(`${root}/`)
}

function machineOwnsCodexCwd(machine: Machine, cwd: string): boolean {
    const workspaceRoots = machine.metadata?.workspaceRoots ?? []
    // 未配置 workspace roots 的 runner 保持项目既有的“任意目录可 spawn”语义；
    // 此时它能运行 fork，只是在多个未限定 runner 同时在线时仍由调用方要求
    // 显式选择，避免错误地挑中另一台机器。
    if (workspaceRoots.length === 0) {
        return true
    }
    return workspaceRoots.some((workspaceRoot) => isPathInsideWorkspaceRoot(cwd, workspaceRoot))
}

function machineCanUseLocalCodexSession(machine: Machine): boolean {
    // The selected runner supplied the transcript itself. workspaceRoots only
    // scopes discovery and the file browser; an explicit native Codex session
    // may legitimately use a worktree under CODEX_HOME.
    return typeof machine.metadata?.codexHome === 'string'
}

function resolveDirectCodexLocalSessionTarget(options: {
    engine: SyncEngine | null
    namespace: string
    machineId: string
}): DirectCodexLocalSessionTarget {
    const engine = options.engine
    if (!engine) {
        return { type: 'error', status: 503, message: 'HAPI hub is not connected' }
    }
    const machine = getOnlineCodexRunner(engine, options.namespace, options.machineId)
    if (!machine) {
        return { type: 'error', status: 409, message: 'Selected runner is not online' }
    }
    if (!machineCanUseLocalCodexSession(machine)) {
        return {
            type: 'error',
            status: 409,
            message: 'Selected runner does not advertise a Codex transcript home'
        }
    }
    return { type: 'success', machine }
}

function resolveImportMachineId(
    cwd: string | null | undefined,
    namespace: string,
    engine: SyncEngine | null
): string | undefined {
    if (!cwd || !engine) {
        return undefined
    }

    const matches = engine.getOnlineMachinesByNamespace(namespace)
        .filter((machine) => machineOwnsCodexCwd(machine, cwd))
    const machineIds = Array.from(new Set(matches.map((machine) => machine.id)))
    return machineIds.length === 1 ? machineIds[0] : undefined
}

function buildImportedSessionMetadata(
    data: CodexTranscriptImportData,
    existingMetadata?: Record<string, unknown> | null,
    resolvedMachineId?: string
): Record<string, unknown> {
    const now = Date.now()
    const path = data.cwd ?? (typeof existingMetadata?.path === 'string' ? existingMetadata.path : dirname(data.file))
    const host = typeof existingMetadata?.host === 'string' ? existingMetadata.host : getCodexTranscriptHost()
    const osValue = typeof existingMetadata?.os === 'string' ? existingMetadata.os : platform()
    const summaryText = data.lastUserMessage ?? data.title
    const machineId = typeof existingMetadata?.machineId === 'string'
        ? existingMetadata.machineId
        : resolvedMachineId

    return {
        ...(existingMetadata ?? {}),
        path,
        host,
        os: osValue,
        name: data.title,
        summary: summaryText
            ? {
                text: summaryText,
                updatedAt: now
            }
            : existingMetadata?.summary,
        flavor: 'codex',
        codexSessionId: data.id,
        ...(machineId ? { machineId } : {}),
        lifecycleState: typeof existingMetadata?.lifecycleState === 'string'
            ? existingMetadata.lifecycleState
            : 'imported',
        lifecycleStateSince: typeof existingMetadata?.lifecycleStateSince === 'number'
            ? existingMetadata.lifecycleStateSince
            : now
    }
}

function stableSerialize(value: unknown): string {
    if (value === null || value === undefined) {
        return String(value)
    }
    if (typeof value === 'string') {
        return JSON.stringify(value)
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value)
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableSerialize(item)).join(',')}]`
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const keys = Object.keys(record).sort()
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
}

function normalizeComparableAgentData(value: unknown): unknown {
    const record = asRecord(value)
    if (!record) {
        return value
    }

    const normalized = { ...record }
    if ('id' in normalized) {
        delete normalized.id
    }
    return normalized
}

function normalizeComparableContent(content: unknown): string | null {
    const record = asRecord(content)
    if (!record) {
        return null
    }

    if (record.role === 'user') {
        const body = asRecord(record.content)
        if (body?.type !== 'text' || typeof body.text !== 'string') {
            return null
        }
        return stableSerialize({
            role: 'user',
            text: body.text
        })
    }

    if (record.role === 'agent') {
        const body = asRecord(record.content)
        if (!body || body.type !== AGENT_MESSAGE_PAYLOAD_TYPE) {
            return null
        }
        return stableSerialize({
            role: 'agent',
            data: normalizeComparableAgentData(body.data)
        })
    }

    return null
}

function getComparableStoredMessageKey(message: StoredMessage): string {
    // 中文注释：重复会话合并时优先按标准 user/agent 结构去重；遇到非标准消息再回退到稳定序列化，确保不会遗漏相同内容。
    return normalizeComparableContent(message.content) ?? stableSerialize(message.content)
}

function collectImportCandidates(
    store: Store,
    namespace: string,
    getSyncEngine?: () => SyncEngine | null
): ImportCandidate[] {
    const engineSessions = getSyncEngine?.()?.getSessionsByNamespace(namespace) ?? []
    if (engineSessions.length > 0) {
        return engineSessions.map((session) => ({
            sessionId: session.id,
            active: session.active,
            updatedAt: session.updatedAt,
            metadata: asRecord(session.metadata)
        }))
    }

    return store.sessions.getSessionsByNamespace(namespace).map((session) => ({
        sessionId: session.id,
        active: session.active,
        updatedAt: session.updatedAt,
        metadata: asRecord(session.metadata)
    }))
}

function selectImportTargetSession(
    store: Store,
    candidates: ImportCandidate[],
    codexSessionId: string,
    importedComparableMessages: string[]
): ImportTargetSelection {
    const relatedCandidates = candidates
        .filter((candidate) => candidate.metadata?.codexSessionId === codexSessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)

    if (relatedCandidates.some((candidate) => candidate.active)) {
        throw new Error('当前会话仍处于活跃状态，请等待会话结束后重试')
    }

    let bestSessionId: string | null = null
    let bestPrefixCount = -1

    for (const candidate of relatedCandidates) {
        const comparableMessages = store.messages.getAllMessages(candidate.sessionId)
            .map((message) => normalizeComparableContent(message.content))
            .filter((value): value is string => value !== null)

        if (comparableMessages.length > importedComparableMessages.length) {
            continue
        }

        let prefixMatches = true
        for (let index = 0; index < comparableMessages.length; index += 1) {
            if (comparableMessages[index] !== importedComparableMessages[index]) {
                prefixMatches = false
                break
            }
        }

        if (!prefixMatches) {
            continue
        }

        if (comparableMessages.length > bestPrefixCount) {
            bestPrefixCount = comparableMessages.length
            bestSessionId = candidate.sessionId
        }
    }

    return {
        sessionId: bestSessionId,
        comparablePrefixCount: Math.max(0, bestPrefixCount)
    }
}

function listDuplicateCodexSessionGroups(
    store: Store,
    namespace: string,
    codexSessionIds: string[],
    getSyncEngine?: () => SyncEngine | null
): DuplicateSessionGroupCandidate[] {
    const requestedSessionIds = new Set(codexSessionIds)
    if (requestedSessionIds.size === 0) {
        return []
    }

    const groups = new Map<string, ImportCandidate[]>()
    for (const candidate of collectImportCandidates(store, namespace, getSyncEngine)) {
        const codexSessionId = typeof candidate.metadata?.codexSessionId === 'string'
            ? candidate.metadata.codexSessionId
            : null
        if (!codexSessionId || !requestedSessionIds.has(codexSessionId)) {
            continue
        }

        const existing = groups.get(codexSessionId)
        if (existing) {
            existing.push(candidate)
        } else {
            groups.set(codexSessionId, [candidate])
        }
    }

    return Array.from(groups.entries())
        .map(([codexSessionId, sessions]) => ({
            codexSessionId,
            sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        }))
        .filter((group) => group.sessions.length > 1)
}

async function mergeDuplicateCodexSessionGroups(options: {
    store: Store
    namespace: string
    codexSessionIds: string[]
    getSyncEngine?: () => SyncEngine | null
}): Promise<CodexMergeDuplicateSessionsResponse> {
    const groups = listDuplicateCodexSessionGroups(
        options.store,
        options.namespace,
        options.codexSessionIds,
        options.getSyncEngine
    )
    if (groups.length === 0) {
        return {
            success: true,
            merged: [],
            mergedCount: 0
        }
    }

    const merged: CodexDuplicateSessionGroup[] = []
    for (const group of groups) {
        const result = await mergeSingleDuplicateCodexSessionGroup({
            group,
            store: options.store,
            namespace: options.namespace,
            getSyncEngine: options.getSyncEngine
        })
        merged.push(result)
    }

    return {
        success: true,
        merged,
        mergedCount: merged.length
    }
}

async function mergeSingleDuplicateCodexSessionGroup(options: {
    group: DuplicateSessionGroupCandidate
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<CodexDuplicateSessionGroup> {
    const engine = options.getSyncEngine?.() ?? null
    const sessionStates = options.group.sessions
        .map((candidate) => ({
            ...candidate,
            storedMessages: options.store.messages.getAllMessages(candidate.sessionId),
        }))
        .map((candidate) => ({
            ...candidate,
            comparableKeys: candidate.storedMessages.map((message) => getComparableStoredMessageKey(message))
        }))
        .sort((a, b) => {
            if (b.comparableKeys.length !== a.comparableKeys.length) {
                return b.comparableKeys.length - a.comparableKeys.length
            }
            if (b.updatedAt !== a.updatedAt) {
                return b.updatedAt - a.updatedAt
            }
            return a.sessionId.localeCompare(b.sessionId)
        })

    if (sessionStates.some((candidate) => candidate.active)) {
        throw new Error('当前会话仍处于活跃状态，请等待会话结束后重试')
    }

    const canonical = sessionStates[0]
    if (!canonical) {
        throw new Error(`No duplicate Hapi session found for Codex thread: ${options.group.codexSessionId}`)
    }

    const knownKeys = new Set(canonical.comparableKeys)
    const removedSessionIds: string[] = []
    const appendedMessages: StoredMessage[] = []
    let latestActivity = canonical.updatedAt

    for (const source of sessionStates.slice(1)) {
        latestActivity = Math.max(latestActivity, source.updatedAt)
        for (const message of source.storedMessages) {
            const comparableKey = getComparableStoredMessageKey(message)
            if (knownKeys.has(comparableKey)) {
                continue
            }

            const copied = options.store.messages.copyMessageToSession(canonical.sessionId, {
                content: message.content,
                createdAt: message.createdAt,
                localId: message.localId,
                invokedAt: message.invokedAt,
                scheduledAt: message.scheduledAt
            })
            knownKeys.add(comparableKey)
            appendedMessages.push(copied)
            latestActivity = Math.max(latestActivity, copied.invokedAt ?? copied.createdAt)
        }

        if (engine) {
            await engine.deleteSession(source.sessionId)
        } else {
            const deleted = options.store.sessions.deleteSession(source.sessionId, options.namespace)
            if (!deleted) {
                throw new Error(`Failed to delete duplicate Hapi session: ${source.sessionId}`)
            }
        }
        removedSessionIds.push(source.sessionId)
    }

    if (appendedMessages.length > 0) {
        emitImportedMessageEvents(engine, canonical.sessionId, appendedMessages)
    }

    if (engine) {
        engine.recordSessionActivity(canonical.sessionId, latestActivity)
        // 中文注释：即使这次只是删除重复分身、没有新增消息，也主动刷新 canonical 会话，确保左侧列表立刻收敛到合并后的状态。
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId: canonical.sessionId
        })
    } else {
        options.store.sessions.touchSessionUpdatedAt(canonical.sessionId, latestActivity, options.namespace)
    }

    return {
        codexSessionId: options.group.codexSessionId,
        hapiSessionIds: sessionStates.map((candidate) => candidate.sessionId),
        canonicalSessionId: canonical.sessionId,
        removedSessionIds
    }
}

function emitImportedMessageEvents(
    engine: SyncEngine | null,
    sessionId: string,
    appendedMessages: StoredMessage[]
): void {
    if (!engine) {
        return
    }

    // 中文注释：只有追加到已有 Hapi 会话时才逐条广播新增消息，确保当前打开的会话右侧消息区能立即刷新到最新 transcript。
    for (const message of appendedMessages) {
        engine.handleRealtimeEvent({
            type: 'message-received',
            sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                localId: message.localId ?? null,
                content: message.content,
                createdAt: message.createdAt,
                invokedAt: message.invokedAt
            }
        })
    }
}

function getPathExts(): string[] {
    if (process.platform !== 'win32') {
        return ['']
    }
    const fromEnv = (process.env.PATHEXT ?? '')
        .split(';')
        .map(ext => ext.trim().toLowerCase())
        .filter(Boolean)
    return Array.from(new Set(['', '.exe', '.cmd', '.bat', '.ps1', ...fromEnv]))
}

function findOnPath(commandName: string): string | null {
    if (commandName.includes('\\') || commandName.includes('/')) {
        return existsSync(commandName) ? commandName : null
    }

    const pathDirs = (process.env.PATH ?? '')
        .split(process.platform === 'win32' ? ';' : ':')
        .map(part => part.trim())
        .filter(Boolean)
    const extensions = getPathExts()

    for (const dir of pathDirs) {
        for (const ext of extensions) {
            const candidate = join(dir, commandName.endsWith(ext) ? commandName : `${commandName}${ext}`)
            if (existsSync(candidate)) {
                return candidate
            }
        }
    }

    return null
}

function getCodexLauncherCandidates(): string[] {
    return [
        process.env.HAPI_CODEX_COMMAND?.trim() ?? '',
        findOnPath('codex') ?? '',
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'codex.exe') : ''
    ].filter(Boolean)
}

function isCodexLauncherAvailable(): boolean {
    return getCodexLauncherCandidates().some(candidate => {
        try {
            return existsSync(candidate)
        } catch {
            return false
        }
    })
}

function isCodexDesktopPath(pathValue: string): boolean {
    return /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:Codex|resources\\codex)\.exe$/i.test(pathValue)
}

function isCodexDesktopPackageInstalled(): boolean {
    if (process.platform !== 'win32') {
        return false
    }

    const command = [
        "$package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue",
        "if ($package) { 'true' } else { 'false' }"
    ].join('\n')

    for (const shell of ['pwsh', 'powershell.exe']) {
        try {
            const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', command], {
                encoding: 'utf-8',
                timeout: 5000,
                windowsHide: true
            })
            if (result.status === 0) {
                return result.stdout.trim().toLowerCase().includes('true')
            }
        } catch {
            // Try next shell.
        }
    }

    return false
}

function isCodexDesktopInstallAvailable(): boolean {
    if (process.platform !== 'win32') {
        return isCodexLauncherAvailable()
    }

    if (isCodexDesktopPackageInstalled()) {
        return true
    }

    return getCodexLauncherCandidates().some(candidate => {
        try {
            return isCodexDesktopPath(candidate) && existsSync(candidate)
        } catch {
            return false
        }
    })
}

function isCodexDesktopRunning(): boolean {
    if (process.platform !== 'win32') {
        return false
    }

    const command = [
        "$targets = @(Get-CimInstance Win32_Process | Where-Object {",
        "    ($_.Name -ieq 'Codex.exe' -or $_.Name -ieq 'codex.exe') -and",
        "    $_.ExecutablePath -match '\\\\WindowsApps\\\\OpenAI\\.Codex_'",
        '})',
        "if ($targets.Count -gt 0) { 'true' } else { 'false' }"
    ].join('\n')

    for (const shell of ['pwsh', 'powershell.exe']) {
        try {
            const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-Command', command], {
                encoding: 'utf-8',
                timeout: 5000,
                windowsHide: true
            })
            if (result.status === 0) {
                return result.stdout.trim().toLowerCase().includes('true')
            }
        } catch {
            // Try next shell.
        }
    }

    return false
}

function getCodexDesktopStatus(): CodexDesktopStatus {
    const running = isCodexDesktopRunning()
    return {
        running,
        clientAvailable: running || isCodexDesktopInstallAvailable()
    }
}

function getScriptTimeoutMs(): number {
    const configured = Number(process.env.HAPI_CODEX_SCRIPT_TIMEOUT_MS)
    if (Number.isFinite(configured) && configured > 0) {
        return configured
    }
    return DEFAULT_SCRIPT_TIMEOUT_MS
}

function createLaunchArgs(scriptPath: string, workspace: string, scriptArgs: string[]): string[] {
    return [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Workspace',
        workspace,
        ...scriptArgs
    ]
}

function appendScriptLog(workspace: string, kind: ScriptLogKind, message: string): void {
    try {
        const logDir = join(workspace, 'logs')
        mkdirSync(logDir, { recursive: true })
        const line = `[${new Date().toISOString()}] [${kind}] ${message}\n`
        appendFileSync(join(logDir, 'CodexDesktopScript.log'), line, 'utf-8')
    } catch {
        // Best-effort logging only; API response still carries the error.
    }
}

async function runPowerShellScript(scriptPath: string, workspace: string, scriptArgs: string[]): Promise<{ pid: number; command: string; output: string }> {
    const configuredPwsh = process.env.HAPI_PWSH_PATH?.trim()
    const candidates = Array.from(new Set([
        configuredPwsh || 'pwsh',
        'powershell.exe'
    ]))
    const args = createLaunchArgs(scriptPath, workspace, scriptArgs)
    let lastError: unknown = null

    for (const command of candidates) {
        try {
            return await new Promise((resolvePromise, rejectPromise) => {
                const output: string[] = []
                let settled = false
                let didSpawn = false
                let timeout: ReturnType<typeof setTimeout> | null = null
                const child = spawn(command, args, {
                    cwd: workspace,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                })

                const cleanup = () => {
                    if (timeout) {
                        clearTimeout(timeout)
                    }
                    child.off('spawn', onSpawn)
                    child.off('error', onError)
                    child.off('exit', onExit)
                }

                const settleResolve = (value: { pid: number; command: string; output: string }) => {
                    if (settled) return
                    settled = true
                    cleanup()
                    resolvePromise(value)
                }

                const settleReject = (error: Error) => {
                    if (settled) return
                    settled = true
                    cleanup()
                    rejectPromise(error)
                }

                const onSpawn = () => {
                    didSpawn = true
                }

                const onError = (error: Error) => {
                    if (!didSpawn) {
                        ;(error as Error & { shellLaunchFailed?: boolean }).shellLaunchFailed = true
                    }
                    settleReject(error)
                }

                const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                    const combinedOutput = output.join('').trim()
                    if (code === 0) {
                        settleResolve({ pid: child.pid ?? 0, command, output: combinedOutput })
                        return
                    }
                    const detail = combinedOutput ? `\n${combinedOutput}` : ''
                    settleReject(new Error(`${command} exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}.${detail}`))
                }

                timeout = setTimeout(() => {
                    child.kill()
                    settleReject(new Error(SCRIPT_TIMEOUT_ERROR))
                }, getScriptTimeoutMs())

                child.stdout?.on('data', (chunk) => output.push(String(chunk)))
                child.stderr?.on('data', (chunk) => output.push(String(chunk)))
                child.once('spawn', onSpawn)
                child.once('error', onError)
                child.once('exit', onExit)
            })
        } catch (error) {
            lastError = error
            if (!(error instanceof Error && (error as Error & { shellLaunchFailed?: boolean }).shellLaunchFailed)) {
                throw error instanceof Error ? error : new Error(String(error))
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function launchRestartScript(): Promise<ScriptLaunchResponse> {
    const scriptPath = getRestartScriptPath()
    const workspace = getWorkspace(scriptPath)

    if (!existsSync(scriptPath)) {
        appendScriptLog(workspace, 'restart', `FAILED: Script not found: ${scriptPath}`)
        return {
            success: false,
            error: `Script not found: ${scriptPath}`,
            script: scriptPath,
            cwd: workspace
        }
    }

    if (!existsSync(workspace)) {
        appendScriptLog(workspace, 'restart', `FAILED: Workspace not found: ${workspace}`)
        return {
            success: false,
            error: `Workspace not found: ${workspace}`,
            script: scriptPath,
            cwd: workspace
        }
    }

    try {
        const launched = await runPowerShellScript(scriptPath, workspace, RESTART_SCRIPT_ARGS)
        const output = launched.output
        appendScriptLog(
            workspace,
            'restart',
            `SUCCESS: ${RESTART_SCRIPT_MESSAGE}; pid=${launched.pid}; command=${launched.command}; script=${scriptPath}${output ? `; output=${output}` : ''}`
        )
        return {
            success: true,
            message: RESTART_SCRIPT_MESSAGE,
            pid: launched.pid,
            command: launched.command,
            script: scriptPath,
            cwd: workspace,
            output
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appendScriptLog(workspace, 'restart', `FAILED: ${message}; script=${scriptPath}`)
        return {
            success: false,
            error: message,
            script: scriptPath,
            cwd: workspace
        }
    }
}

function parseSyncSessionRequest(body: unknown): SyncSessionRequestParseResult {
    // 中文注释：导入弹窗现在直接提交 Codex thread ID；未传 body 时按“未选择会话”处理，避免再回退到旧的默认最新会话逻辑。
    if (body === null || typeof body !== 'object' || Array.isArray(body) || !('sessionIds' in body)) {
        return { sessionIds: [] }
    }

    const rawSessionIds = (body as { sessionIds?: unknown }).sessionIds
    if (!Array.isArray(rawSessionIds)) {
        return { sessionIds: [], error: 'Invalid sessionIds' }
    }

    const sessionIds: string[] = []
    for (const value of rawSessionIds) {
        if (typeof value !== 'string') {
            return { sessionIds: [], error: 'Invalid sessionIds' }
        }
        const trimmed = value.trim()
        if (trimmed) {
            sessionIds.push(trimmed)
        }
    }

    // 中文注释：前端允许多选，这里按 Codex thread 去重，避免重复导入同一条本地 transcript。
    return { sessionIds: Array.from(new Set(sessionIds)) }
}

function combineSyncOutputs(results: ScriptLaunchResponse[]): string | undefined {
    const output = results
        .map((result, index) => {
            // 中文注释：direct import 不再依赖隐藏脚本；这里把每个会话的导入摘要拼成一段文本，便于前端或日志统一查看。
            const detail = result.success ? (result.output ?? '') : (result.output ?? result.error)
            return detail ? `[${index + 1}] ${detail}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
        .trim()
    return output || undefined
}

function getDirectImportRouteContext(): { workspace: string } {
    return {
        workspace: getDirectImportWorkspace()
    }
}

function createImportErrorResponse(
    codexSessionIds: string[],
    error: string,
    syncedCount = 0
): ScriptLaunchResponse {
    const { workspace } = getDirectImportRouteContext()
    appendScriptLog(workspace, 'sync', `FAILED: ${error}; sessionIds=${codexSessionIds.join(',') || '(none)'}`)
    return {
        success: false,
        error,
        cwd: workspace,
        sessionIds: codexSessionIds,
        syncedCount
    }
}

function createImportSuccessResponse(
    codexSessionIds: string[],
    results: ScriptLaunchResponse[]
): ScriptLaunchResponse {
    const { workspace } = getDirectImportRouteContext()
    appendScriptLog(
        workspace,
        'sync',
        `SUCCESS: imported ${results.length} Codex session(s); sessionIds=${codexSessionIds.join(',')}`
    )
    return {
        success: true,
        message: `Imported ${results.length} Codex session(s) into Hapi`,
        pid: 0,
        command: DIRECT_IMPORT_COMMAND,
        cwd: workspace,
        output: combineSyncOutputs(results),
        sessionIds: codexSessionIds,
        syncedCount: results.length
    }
}

function importSingleCodexSession(options: {
    codexSessionId: string
    localSessionsById: Map<string, CodexLocalSessionSummary>
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): ScriptLaunchResponse {
    const summary = options.localSessionsById.get(options.codexSessionId)
    if (!summary) {
        return {
            ...createImportErrorResponse([options.codexSessionId], `Transcript not found for Codex session: ${options.codexSessionId}`),
            output: `未找到对应的本地 transcript：${options.codexSessionId}`
        }
    }

    const transcript = parseCodexTranscriptImportData(summary)
    if (!transcript) {
        return {
            ...createImportErrorResponse([options.codexSessionId], `Failed to parse Codex transcript: ${summary.file}`),
            output: `解析 transcript 失败：${summary.file}`
        }
    }

    if (transcript.messages.length === 0) {
        return {
            ...createImportErrorResponse([options.codexSessionId], `No importable conversation content found in transcript: ${summary.file}`),
            output: `transcript 中没有可导入的会话内容：${summary.file}`
        }
    }

    const importedComparableMessages = transcript.messages
        .map((message) => normalizeComparableContent(message))
        .filter((value): value is string => value !== null)

    try {
        const candidates = collectImportCandidates(options.store, options.namespace, options.getSyncEngine)
        const target = selectImportTargetSession(
            options.store,
            candidates,
            options.codexSessionId,
            importedComparableMessages
        )
        const engine = options.getSyncEngine?.() ?? null
        const existingStored = target.sessionId ? options.store.sessions.getSessionByNamespace(target.sessionId, options.namespace) : null
        const metadata = buildImportedSessionMetadata(
            transcript,
            asRecord(existingStored?.metadata),
            resolveImportMachineId(transcript.cwd, options.namespace, engine)
        )

        let sessionId = existingStored?.id ?? null
        let created = false
        if (!sessionId) {
            // 中文注释：找不到可安全续写的历史会话时，直接新建一个 Hapi 会话，避免把已分叉的数据硬写进旧会话。
            const createdSession = engine?.getOrCreateSession(
                randomUUID(),
                metadata,
                {},
                options.namespace
            ) ?? options.store.sessions.getOrCreateSession(randomUUID(), metadata, {}, options.namespace)
            sessionId = createdSession.id
            created = true
        } else if (existingStored) {
            const updatedMetadata = options.store.sessions.updateSessionMetadata(
                existingStored.id,
                metadata,
                existingStored.metadataVersion,
                options.namespace
            )
            if (updatedMetadata.result !== 'success') {
                throw new Error(`Failed to update metadata for Hapi session: ${existingStored.id}`)
            }
            engine?.handleRealtimeEvent({ type: 'session-updated', sessionId: existingStored.id })
        }

        if (!sessionId) {
            throw new Error(`Failed to determine target Hapi session for Codex thread: ${options.codexSessionId}`)
        }

        const comparablePrefixCount = sessionId ? target.comparablePrefixCount : 0
        const messagesToAppend = transcript.messages.slice(comparablePrefixCount)
        const appendedMessages = messagesToAppend.map((message) => options.store.messages.addMessage(sessionId!, message))

        // 中文注释：更新 Hapi 会话的 updatedAt，并在已有会话追加时广播新增消息，让当前打开的聊天页立刻显示客户端新增内容。
        const latestMessageCreatedAt = appendedMessages[appendedMessages.length - 1]?.createdAt ?? Date.now()
        if (engine) {
            engine.recordSessionActivity(sessionId, latestMessageCreatedAt)
        } else {
            options.store.sessions.touchSessionUpdatedAt(sessionId, latestMessageCreatedAt, options.namespace)
        }
        if (!created) {
            emitImportedMessageEvents(engine, sessionId, appendedMessages)
        }

        const output = [
            `Codex thread: ${options.codexSessionId}`,
            `Hapi session: ${sessionId}`,
            `Action: ${created ? 'created' : 'updated'}`,
            `Appended messages: ${appendedMessages.length}`
        ].join('\n')

        appendScriptLog(
            getDirectImportRouteContext().workspace,
            'sync',
            `SUCCESS: codexSessionId=${options.codexSessionId}; hapiSessionId=${sessionId}; created=${created}; appended=${appendedMessages.length}`
        )

        return {
            success: true,
            message: created ? 'Codex session imported into a new Hapi session' : 'Codex session appended to existing Hapi session',
            pid: 0,
            command: DIRECT_IMPORT_COMMAND,
            cwd: getDirectImportRouteContext().workspace,
            output,
            sessionIds: [options.codexSessionId],
            syncedCount: 1
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            ...createImportErrorResponse([options.codexSessionId], message),
            output: `Codex thread: ${options.codexSessionId}\n${message}`
        }
    }
}

export async function importSelectedCodexSessions(options: {
    codexSessionIds: string[]
    store: Store
    namespace: string
    getSyncEngine?: () => SyncEngine | null
}): Promise<ScriptLaunchResponse> {
    const codexSessionIds = options.codexSessionIds
    if (codexSessionIds.length === 0) {
        return createImportErrorResponse(codexSessionIds, NO_SYNC_SESSION_SELECTED_ERROR)
    }

    const localSessionsById = new Map<string, CodexLocalSessionSummary>()
    for (const codexSessionId of new Set(codexSessionIds)) {
        const session = findLocalCodexSession(codexSessionId)
        if (session) localSessionsById.set(codexSessionId, session)
    }
    const results: ScriptLaunchResponse[] = []
    for (const codexSessionId of codexSessionIds) {
        const result = importSingleCodexSession({
            codexSessionId,
            localSessionsById,
            store: options.store,
            namespace: options.namespace,
            getSyncEngine: options.getSyncEngine
        })
        results.push(result)

        if (!result.success) {
            return {
                ...result,
                sessionIds: codexSessionIds,
                syncedCount: Math.max(0, results.length - 1),
                output: combineSyncOutputs(results) ?? result.output
            }
        }
    }

    return createImportSuccessResponse(codexSessionIds, results)
}

export function createCodexDesktopRoutes(options: {
    store: Store
    getSyncEngine: () => SyncEngine | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('/codex/*', async (c, next) => {
        if (c.get('namespace') !== 'default') {
            return c.json({
                success: false,
                error: CODEX_TRANSCRIPT_IMPORT_NAMESPACE_ERROR
            }, 403)
        }
        return next()
    })

    app.get('/codex/status', (c) => {
        const codexStatus = getCodexDesktopStatus()
        return c.json({
            success: true,
            codexDesktopRunning: codexStatus.running,
            codexClientAvailable: codexStatus.clientAvailable
        } satisfies CodexDesktopStatusResponse)
    })

    app.get('/codex/sessions', async (c) => {
        const limit = parseCodexSessionLimit(c.req.query('limit'))
        if (c.req.query('limit') !== undefined && limit === null) {
            return c.json({ success: false, error: 'limit must be an integer between 1 and 100' }, 400)
        }
        const excludeHapiInitiated = parseExcludeHapiInitiated(c.req.query('excludeHapiInitiated'))
        if (excludeHapiInitiated === null) {
            return c.json({ success: false, error: 'excludeHapiInitiated must be true or false' }, 400)
        }
        const forceRefresh = parseForceRefresh(c.req.query('forceRefresh'))
        if (forceRefresh === null) {
            return c.json({ success: false, error: 'forceRefresh must be true or false' }, 400)
        }
        const machineId = parseCodexRunnerMachineId(c.req.query('machineId'))
        if (!machineId) {
            return c.json({
                success: true,
                sessions: listLocalCodexSessions(limit ?? DEFAULT_CODEX_SESSION_SCAN_LIMIT, { excludeHapiInitiated })
            } satisfies CodexLocalSessionsResponse)
        }
        const engine = options.getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'HAPI hub is not connected' }, 503)
        }
        if (!getOnlineCodexRunner(engine, c.get('namespace'), machineId)) {
            return c.json({ success: false, error: 'Selected runner is not online' }, 409)
        }
        try {
            const listOptions = {
                ...(excludeHapiInitiated ? { excludeHapiInitiated: true } : {}),
                ...(forceRefresh ? { forceRefresh: true } : {})
            }
            const result = Object.keys(listOptions).length > 0
                ? await engine.listCodexLocalSessions(
                    machineId,
                    limit ?? DEFAULT_RECENT_CODEX_SESSION_LIMIT,
                    listOptions
                )
                : await engine.listCodexLocalSessions(machineId, limit ?? DEFAULT_RECENT_CODEX_SESSION_LIMIT)
            if (result.success !== true) {
                return c.json({ success: false, error: result.error || 'Failed to list Codex sessions on the selected runner' }, 502)
            }
            // The runner normally filters before applying its limit. Filter a
            // second time at the hub boundary so a rolling upgrade cannot leak
            // a HAPI-created thread from an older runner implementation.
            const sessions = excludeHapiInitiated
                ? result.sessions.filter((session) => !isHapiInitiatedCodexSession(session))
                : result.sessions
            return c.json({ success: true, sessions } satisfies CodexLocalSessionsResponse)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex sessions on the selected runner'
            }, 502)
        }
    })

    app.get('/codex/sessions/:id/context', async (c) => {
        const limit = parseCodexContextPageLimit(c.req.query('limit'))
        if (limit === null) {
            return c.json({ success: false, error: 'limit must be an integer between 1 and 100' }, 400)
        }
        const before = parseCodexContextBefore(c.req.query('before'))
        if (before === null) {
            return c.json({ success: false, error: 'before must be a non-negative integer' }, 400)
        }
        const machineId = parseCodexRunnerMachineId(c.req.query('machineId'))
        if (!machineId) {
            const summary = findLocalCodexSession(c.req.param('id'))
            if (!summary) {
                return c.json({ success: false, error: 'Codex session not found' }, 404)
            }
            const contextPage = getCodexTranscriptContextPage(summary, limit, before)
            return c.json({
                success: true,
                session: {
                    id: summary.id,
                    title: summary.title,
                    cwd: summary.cwd,
                    modifiedAt: summary.modifiedAt,
                    model: summary.model,
                    modelReasoningEffort: summary.modelReasoningEffort
                },
                messages: contextPage.messages,
                page: contextPage.page
            } satisfies CodexLocalSessionContextResponse)
        }
        const engine = options.getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'HAPI hub is not connected' }, 503)
        }
        if (!getOnlineCodexRunner(engine, c.get('namespace'), machineId)) {
            return c.json({ success: false, error: 'Selected runner is not online' }, 409)
        }
        try {
            const result = await engine.readCodexLocalSession(machineId, c.req.param('id'), {
                limit,
                ...(before === undefined ? {} : { before })
            })
            if (result.success !== true) {
                return c.json({ success: false, error: result.error || 'Codex session not found' }, 404)
            }
            const { session, importedMessages } = result.data
            return c.json({
                success: true,
                session: {
                    id: session.id,
                    title: session.title,
                    cwd: session.cwd,
                    modifiedAt: session.modifiedAt,
                    model: session.model,
                    modelReasoningEffort: session.modelReasoningEffort
                },
                messages: createCodexTranscriptContextMessages(session.id, importedMessages, result.data.startIndex, session.modifiedAt),
                page: result.data.page
            } satisfies CodexLocalSessionContextResponse)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read Codex session on the selected runner'
            }, 502)
        }
    })

    app.get('/codex/sessions/:id/status', async (c) => {
        const machineId = parseCodexRunnerMachineId(c.req.query('machineId'))
        if (!machineId) {
            return c.json({ success: false, error: 'machineId is required' }, 400)
        }

        const engine = options.getSyncEngine()
        const target = resolveDirectCodexLocalSessionTarget({
            engine,
            namespace: c.get('namespace'),
            machineId
        })
        if (target.type === 'error') {
            return c.json({ success: false, error: target.message }, target.status)
        }

        try {
            const result = await engine!.getCodexLocalSessionStatus(target.machine.id, c.req.param('id'))
            if (result.success !== true) {
                return c.json(result, 404)
            }
            return c.json(result satisfies CodexLocalSessionStatusRpcResponse)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read native Codex session status'
            }, 502)
        }
    })

    app.get('/codex/sessions/:id/snapshot', async (c) => {
        const limit = parseCodexContextPageLimit(c.req.query('limit'))
        if (limit === null) {
            return c.json({ success: false, error: 'limit must be an integer between 1 and 100' }, 400)
        }
        const before = parseCodexContextBefore(c.req.query('before'))
        if (before === null) {
            return c.json({ success: false, error: 'before must be a non-negative integer' }, 400)
        }
        const machineId = parseCodexRunnerMachineId(c.req.query('machineId'))
        if (!machineId) {
            return c.json({ success: false, error: 'machineId is required' }, 400)
        }

        const engine = options.getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'HAPI hub is not connected' }, 503)
        }
        if (!getOnlineCodexRunner(engine, c.get('namespace'), machineId)) {
            return c.json({ success: false, error: 'Selected runner is not online' }, 409)
        }

        try {
            const result = await engine.readCodexLocalSessionSnapshot(machineId, c.req.param('id'), {
                limit,
                ...(before === undefined ? {} : { before })
            })
            if (result.success !== true) {
                return c.json({ success: false, error: result.error || 'Codex session not found' }, 404)
            }
            const response: CodexLocalSessionSnapshotResponse = {
                ...createRunnerCodexSessionContextResponse(result.snapshot.data, result.snapshot.revision),
                status: result.snapshot.status,
                timing: result.snapshot.timing
            }
            c.header('Server-Timing', `native-cache;desc=${result.snapshot.timing.cache};dur=${result.snapshot.timing.durationMs}`)
            return c.json(response)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read native Codex session snapshot'
            }, 502)
        }
    })

    app.post('/codex/sessions/:id/messages', async (c) => {
        const request = parseSendCodexLocalSessionMessageRequest(await c.req.json().catch(() => null))
        if (!request) {
            return c.json({ success: false, error: 'machineId and message are required' }, 400)
        }

        const engine = options.getSyncEngine()
        const target = resolveDirectCodexLocalSessionTarget({
            engine,
            namespace: c.get('namespace'),
            machineId: request.machineId
        })
        if (target.type === 'error') {
            return c.json({ success: false, error: target.message }, target.status)
        }

        try {
            const result = await engine!.sendCodexLocalSessionMessage(
                target.machine.id,
                c.req.param('id'),
                request.message
            )
            if (result.success === true) {
                return c.json(result satisfies SendCodexLocalSessionMessageRpcResponse, 202)
            }
            const status = result.code === 'invalid_message'
                ? 400
                : result.code === 'session_not_found'
                    ? 404
                    : result.code === 'launch_failed'
                        ? 502
                        : result.code === 'queue_full'
                            ? 429
                            : 409
            return c.json(result satisfies SendCodexLocalSessionMessageRpcResponse, status)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to send message to native Codex session'
            }, 502)
        }
    })

    app.post('/codex/sessions/:id/fork', async (c) => {
        const engine = options.getSyncEngine()
        if (!engine) {
            return c.json({ type: 'error', code: 'hub_unavailable', message: 'HAPI hub is not connected' } satisfies ForkCodexLocalSessionResponse, 503)
        }

        const request = parseForkCodexLocalSessionRequest(await c.req.json().catch(() => null))
        if (!request) {
            return c.json({ type: 'error', code: 'invalid_fork_request', message: 'Invalid fork request' } satisfies ForkCodexLocalSessionResponse, 400)
        }

        const namespace = c.get('namespace')
        const machine = getOnlineCodexRunner(engine, namespace, request.machineId)
        if (!machine) {
            return c.json({
                type: 'error',
                code: 'runner_offline',
                message: 'Selected runner is not online'
            } satisfies ForkCodexLocalSessionResponse, 409)
        }

        let localSession
        try {
            localSession = await engine.readCodexLocalSession(machine.id, c.req.param('id'))
        } catch (error) {
            return c.json({
                type: 'error',
                code: 'session_read_failed',
                message: error instanceof Error ? error.message : 'Failed to read Codex session on the selected runner'
            } satisfies ForkCodexLocalSessionResponse, 502)
        }
        if (localSession.success !== true) {
            return c.json({ type: 'error', code: 'session_not_found', message: localSession.error || 'Codex session not found' } satisfies ForkCodexLocalSessionResponse, 404)
        }

        const summary = localSession.data.session
        const cwd = summary.cwd?.trim()
        if (!cwd) {
            return c.json({ type: 'error', code: 'workspace_missing', message: 'The Codex session does not have a workspace path' } satisfies ForkCodexLocalSessionResponse, 409)
        }
        if (!machineCanUseLocalCodexSession(machine)) {
            return c.json({
                type: 'error',
                code: 'codex_home_unavailable',
                message: 'Selected runner does not advertise a Codex transcript home'
            } satisfies ForkCodexLocalSessionResponse, 409)
        }

        const spawn = await engine.spawnSession(
            machine.id,
            cwd,
            'codex',
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            summary.id
        )
        if (spawn.type !== 'success') {
            return c.json({ type: 'error', code: 'fork_spawn_failed', message: spawn.message } satisfies ForkCodexLocalSessionResponse, 502)
        }

        const forkedSession = engine.getSessionByNamespace(spawn.sessionId, namespace)
        if (forkedSession?.metadata) {
            const metadata = {
                ...forkedSession.metadata,
                name: `${summary.title} (fork)`,
                codexFork: {
                    sourceCodexSessionId: summary.id,
                    createdAt: Date.now(),
                    mode: 'native_fork' as const
                }
            }
            const updated = options.store.sessions.updateSessionMetadata(
                spawn.sessionId,
                metadata,
                forkedSession.metadataVersion,
                namespace
            )
            if (updated.result === 'success') {
                engine.handleRealtimeEvent({ type: 'session-updated', sessionId: spawn.sessionId })
            }
        }

        if (localSession.data.importedMessages.length) {
            for (const message of localSession.data.importedMessages) {
                options.store.messages.addMessage(spawn.sessionId, message)
            }
            engine.recordSessionActivity(spawn.sessionId, Date.now())
        }

        return c.json({
            type: 'success',
            sessionId: spawn.sessionId,
            session: engine.getSessionByNamespace(spawn.sessionId, namespace)
        } satisfies ForkCodexLocalSessionResponse)
    })

    app.post('/codex/sync-session', async (c) => {
        const codexStatus = getCodexDesktopStatus()
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            const { workspace } = getDirectImportRouteContext()
            appendScriptLog(workspace, 'sync', `FAILED: ${parsed.error}`)
            return c.json({
                success: false,
                error: parsed.error,
                cwd: workspace,
                codexDesktopRunning: codexStatus.running,
                codexClientAvailable: codexStatus.clientAvailable
            })
        }

        // 中文注释：这里直接读取本地 transcript 写入 Hapi store，不再启动隐藏 codex resume 进程，避免漏导入客户端新增内容。
        const result = await importSelectedCodexSessions({
            codexSessionIds: parsed.sessionIds,
            store: options.store,
            namespace: c.get('namespace'),
            getSyncEngine: options.getSyncEngine
        })
        return c.json({
            ...result,
            codexDesktopRunning: codexStatus.running,
            codexClientAvailable: codexStatus.clientAvailable
        })
    })

    app.post('/codex/duplicate-sessions', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            return c.json({
                success: false,
                error: parsed.error
            } satisfies CodexDuplicateSessionsResponse)
        }

        if (parsed.sessionIds.length === 0) {
            return c.json({
                success: false,
                error: NO_SYNC_SESSION_SELECTED_ERROR
            } satisfies CodexDuplicateSessionsResponse)
        }

        // 中文注释：这里只检查本次导入弹窗里勾选过的 codexSessionId；未选中的会话即使也有重复，也不参与本轮提示。
        const duplicates = listDuplicateCodexSessionGroups(
            options.store,
            c.get('namespace'),
            parsed.sessionIds,
            options.getSyncEngine
        ).map((group) => ({
            codexSessionId: group.codexSessionId,
            hapiSessionIds: group.sessions.map((session) => session.sessionId)
        }))

        return c.json({
            success: true,
            duplicates
        } satisfies CodexDuplicateSessionsResponse)
    })

    app.post('/codex/merge-duplicate-sessions', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = parseSyncSessionRequest(body)
        if (parsed.error) {
            return c.json({
                success: false,
                error: parsed.error
            } satisfies CodexMergeDuplicateSessionsResponse)
        }

        if (parsed.sessionIds.length === 0) {
            return c.json({
                success: false,
                error: NO_SYNC_SESSION_SELECTED_ERROR
            } satisfies CodexMergeDuplicateSessionsResponse)
        }

        const { workspace } = getDirectImportRouteContext()
        try {
            // 中文注释：真正执行合并时仍然只按这次选中的 codexSessionId 收口，防止顺手把别的会话历史也改掉。
            const result = await mergeDuplicateCodexSessionGroups({
                store: options.store,
                namespace: c.get('namespace'),
                codexSessionIds: parsed.sessionIds,
                getSyncEngine: options.getSyncEngine
            })
            appendScriptLog(
                workspace,
                'sync',
                `SUCCESS: merged duplicate Hapi sessions for selected codexSessionIds=${parsed.sessionIds.join(',')}`
            )
            return c.json(result satisfies CodexMergeDuplicateSessionsResponse)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            appendScriptLog(
                workspace,
                'sync',
                `FAILED: duplicate-session merge error=${message}; selectedCodexSessionIds=${parsed.sessionIds.join(',')}`
            )
            return c.json({
                success: false,
                error: message
            } satisfies CodexMergeDuplicateSessionsResponse)
        }
    })

    app.post('/codex/restart-desktop', async (c) => {
        const codexStatus = getCodexDesktopStatus()
        if (!codexStatus.clientAvailable) {
            const scriptPath = getRestartScriptPath()
            const workspace = getWorkspace(scriptPath)
            const error = CODEX_DESKTOP_NOT_FOUND_ERROR
            appendScriptLog(workspace, 'restart', `FAILED: ${error}; script=${scriptPath}`)
            return c.json({
                success: false,
                error,
                script: scriptPath,
                cwd: workspace,
                codexDesktopRunning: codexStatus.running,
                codexClientAvailable: codexStatus.clientAvailable
            })
        }

        const result = await launchRestartScript()
        return c.json({
            ...result,
            codexDesktopRunning: codexStatus.running,
            codexClientAvailable: codexStatus.clientAvailable
        })
    })

    return app
}
