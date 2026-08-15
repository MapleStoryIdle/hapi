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
}

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

    return {
        id: sessionId,
        title: getCodexSessionTitle(cwd, sessionId, getLatestCodexChangedTitle(allLines), firstUserMessage),
        lastUserMessage: getLatestCodexUserMessage(allLines),
        cwd,
        file: filePath,
        modifiedAt,
        originator,
        cliVersion
    }
}

function listCodexTranscriptFilesByRecency(): CodexTranscriptFileCandidate[] {
    const files: CodexTranscriptFileCandidate[] = []
    collectJsonlFiles(join(getCodexHome(), 'sessions'), files)
    return files.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

export function listLocalCodexSessions(limit = DEFAULT_CODEX_SESSION_SCAN_LIMIT): CodexLocalSessionSummary[] {
    const sessions: CodexLocalSessionSummary[] = []
    const seenSessionIds = new Set<string>()
    for (const candidate of listCodexTranscriptFilesByRecency()) {
        const session = parseCodexLocalSession(candidate.file, candidate.modifiedAt)
        if (!session || seenSessionIds.has(session.id)) continue
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
    return { ...summary, messages }
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
