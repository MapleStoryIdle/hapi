/**
 * 同一 Hub / namespace 内的 Agent-to-Agent 会话协作。
 *
 * `pingPeer` 负责必要时唤醒目标会话并投递消息；`inspectPeer` 只读取元数据
 * 与近期可见文本，绝不会唤醒目标。CLI 与 MCP 共用这一个实现，避免绕过同域
 * 认证或让模型自行拼 JWT + curl。
 */

import axios, { type AxiosInstance } from 'axios'
import { extractAssistantPlainText, isObject } from '@hapi/protocol'
import { normalizeSessionIdPrefix } from '@hapi/protocol/sessionCitation'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'

export type PingPeerErrorCode =
    | 'bad_args'
    | 'auth_failed'
    | 'not_found'
    | 'ambiguous'
    | 'resume_failed'
    | 'timeout'
    | 'send_failed'

export class PingPeerError extends Error {
    readonly code: PingPeerErrorCode

    constructor(code: PingPeerErrorCode, message: string) {
        super(message)
        this.name = 'PingPeerError'
        this.code = code
    }
}

export type PingPeerSessionSummary = {
    id: string
    active: boolean
    thinking?: boolean
    updatedAt?: number
    metadata?: {
        name?: string
        flavor?: string | null
        path?: string | null
        lifecycleState?: string | null
        piSessionId?: string
        summary?: { text?: string } | null
    } | null
}

export type PingPeerOptions = {
    sessionIdPrefix: string
    message: string
    /** Optional test/embedding override; normal Agent calls use HAPI_SESSION_ID. */
    callerSessionId?: string
    waitActiveSecs?: number
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    onProgress?: (message: string) => void
}

export type PingPeerResult = {
    sessionId: string
    name: string
    resumed: boolean
}

export type ListPeerSessionsOptions = {
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
    limit?: number
    order?: 'updatedAt'
}

const DEFAULT_WAIT_ACTIVE_SECS = 60
const POLL_ACTIVE_MS = 2_000
const POLL_PI_READY_MS = 1_000
const AUTH_RECOVERY_HINT =
    'On a remote runner, set HAPI_API_URL to the runner hub and configure CLI_API_TOKEN with `shapi auth login`. '
    + 'Inside a SHAPI session, prefer MCP list_peers / inspect_peer / ping_peer.'

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveApiUrl(apiUrl?: string): string {
    const raw = (apiUrl ?? configuration.apiUrl).trim().replace(/\/+$/, '')
    if (!raw) {
        throw new PingPeerError('bad_args', `SHAPI API URL is empty. ${AUTH_RECOVERY_HINT}`)
    }
    // 安全边界：MCP 参数不能指定任意主机，只能访问已配置的同一个 Hub。
    return raw
}

function resolveAccessToken(accessToken?: string): string {
    let token = ''
    try {
        token = (accessToken ?? getAuthToken()).trim()
    } catch {
        token = (accessToken ?? '').trim()
    }
    if (!token) {
        throw new PingPeerError('bad_args', `CLI_API_TOKEN is required. ${AUTH_RECOVERY_HINT}`)
    }
    return token
}

function authHeaders(jwt: string): Record<string, string> {
    return buildHubRequestHeaders({
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
    })
}

async function exchangeJwt(apiUrl: string, accessToken: string, http: AxiosInstance): Promise<string> {
    try {
        const response = await http.post(
            `${apiUrl}/api/auth`,
            { accessToken },
            {
                headers: buildHubRequestHeaders({ 'Content-Type': 'application/json' }),
                timeout: 10_000,
                validateStatus: () => true
            }
        )
        const token = typeof response.data?.token === 'string' ? response.data.token : ''
        if (response.status < 200 || response.status >= 300 || !token) {
            const detail = typeof response.data?.error === 'string'
                ? response.data.error
                : `HTTP ${response.status}`
            throw new PingPeerError('auth_failed', `failed to exchange access token for JWT (${detail}). ${AUTH_RECOVERY_HINT}`)
        }
        return token
    } catch (error) {
        if (error instanceof PingPeerError) throw error
        const detail = error instanceof Error ? error.message : String(error)
        throw new PingPeerError('auth_failed', `failed to exchange access token for JWT (${detail}). ${AUTH_RECOVERY_HINT}`)
    }
}

export function resolveSessionByPrefix(
    sessions: PingPeerSessionSummary[],
    prefix: string
): PingPeerSessionSummary {
    const trimmed = prefix.trim()
    if (!trimmed) {
        throw new PingPeerError('bad_args', 'session id prefix is required')
    }

    const exact = sessions.filter((session) => session.id === trimmed)
    if (exact.length === 1) return exact[0]!

    const matches = sessions.filter((session) => session.id.startsWith(trimmed))
    if (matches.length === 0) {
        throw new PingPeerError('not_found', `no session matching prefix '${trimmed}'`)
    }
    if (matches.length > 1) {
        const sample = matches.slice(0, 5).map((session) => session.id.slice(0, 8)).join(', ')
        throw new PingPeerError(
            'ambiguous',
            `prefix '${trimmed}' matches ${matches.length} sessions (${sample}${matches.length > 5 ? ', ...' : ''}); use a longer prefix`
        )
    }
    return matches[0]!
}

async function listSessions(
    apiUrl: string,
    jwt: string,
    http: AxiosInstance,
    options: { limit?: number; order?: 'updatedAt' } = {}
): Promise<PingPeerSessionSummary[]> {
    const params: Record<string, string | number> = {}
    if (options.limit !== undefined) params.limit = options.limit
    if (options.order !== undefined) params.order = options.order

    const response = await http.get(`${apiUrl}/api/sessions`, {
        headers: authHeaders(jwt),
        ...(Object.keys(params).length > 0 ? { params } : {}),
        timeout: 15_000,
        validateStatus: () => true
    })
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new PingPeerError('auth_failed', `failed to list sessions (${detail}). ${AUTH_RECOVERY_HINT}`)
    }

    const body = response.data
    const sessions = Array.isArray(body?.sessions) ? body.sessions : Array.isArray(body) ? body : null
    if (!sessions) {
        throw new PingPeerError('auth_failed', 'failed to list sessions (unexpected response)')
    }
    return sessions as PingPeerSessionSummary[]
}

async function getSession(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    http: AxiosInstance
): Promise<PingPeerSessionSummary> {
    const response = await http.get(`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: authHeaders(jwt),
        timeout: 10_000,
        validateStatus: () => true
    })
    if (response.status < 200 || response.status >= 300 || !response.data?.session) {
        const detail = typeof response.data?.error === 'string'
            ? response.data.error
            : `HTTP ${response.status}`
        throw new PingPeerError('not_found', `failed to load session ${sessionId} (${detail})`)
    }
    return response.data.session as PingPeerSessionSummary
}

async function resumeSession(apiUrl: string, jwt: string, sessionId: string, http: AxiosInstance): Promise<void> {
    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/resume`,
        {},
        {
            headers: authHeaders(jwt),
            timeout: 30_000,
            validateStatus: () => true
        }
    )
    if (response.data?.type === 'success') return

    const detail = typeof response.data?.message === 'string'
        ? response.data.message
        : typeof response.data?.error === 'string'
            ? response.data.error
            : typeof response.data?.code === 'string'
                ? response.data.code
                : `HTTP ${response.status}`
    throw new PingPeerError('resume_failed', `resume failed: ${detail}`)
}

async function waitUntilActive(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    waitActiveSecs: number,
    http: AxiosInstance,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
    onProgress?: (message: string) => void
): Promise<void> {
    const deadline = now() + waitActiveSecs * 1000
    onProgress?.(`waiting up to ${waitActiveSecs}s for active state...`)
    while (now() < deadline) {
        if ((await getSession(apiUrl, jwt, sessionId, http)).active) return
        await sleep(POLL_ACTIVE_MS)
    }
    throw new PingPeerError('timeout', 'session did not become active before the timeout; runner may have failed to spawn')
}

async function waitForPiReady(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    waitActiveSecs: number,
    http: AxiosInstance,
    sleep: (ms: number) => Promise<void>,
    now: () => number
): Promise<void> {
    const deadline = now() + waitActiveSecs * 1000
    while (now() < deadline) {
        const session = await getSession(apiUrl, jwt, sessionId, http)
        if (session.metadata?.piSessionId) return
        await sleep(POLL_PI_READY_MS)
    }
    throw new PingPeerError('timeout', 'piSessionId never appeared before the timeout; refusing to send')
}

async function sendMessage(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    message: string,
    http: AxiosInstance
): Promise<void> {
    const response = await http.post(
        `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        { text: message },
        {
            headers: authHeaders(jwt),
            timeout: 30_000,
            validateStatus: () => true
        }
    )
    if (response.status >= 200 && response.status < 300 && response.data?.ok === true) return

    const detail = typeof response.data?.error === 'string'
        ? response.data.error
        : typeof response.data?.code === 'string'
            ? response.data.code
            : `HTTP ${response.status}`
    throw new PingPeerError('send_failed', `send failed: ${detail}`)
}

/** 读取同一 namespace 的近期会话，供 list_peers 和 CLI `--list` 使用。 */
export async function listPeerSessions(options: ListPeerSessionsOptions = {}): Promise<PingPeerSessionSummary[]> {
    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    return await listSessions(apiUrl, jwt, http, {
        limit: options.limit ?? 200,
        order: options.order ?? 'updatedAt'
    })
}

const MAX_PEER_LABEL_CHARS = 255

/** 名称 → 摘要 → 工作目录名 → ID 前缀的稳定会话标签。 */
export function resolvePeerSessionLabel(session: PingPeerSessionSummary): string {
    const meta = session.metadata
    const pathLabel = meta?.path?.split(/[\\/]/).filter(Boolean).pop()?.trim()
    const raw = meta?.name?.trim() || meta?.summary?.text?.trim() || pathLabel || session.id.slice(0, 8)
    const collapsed = raw.replace(/\s+/g, ' ').trim()
    if (!collapsed) return session.id.slice(0, 8)
    return collapsed.length > MAX_PEER_LABEL_CHARS ? collapsed.slice(0, MAX_PEER_LABEL_CHARS) : collapsed
}

export function peerListFetchLimit(requestedLimit: number, options?: { excludeCaller?: boolean }): number {
    const limit = Math.max(1, Math.floor(requestedLimit))
    const pad = options?.excludeCaller ? 2 : 1
    return Math.min(500, limit + pad)
}

export function formatPeerSessionsList(
    sessions: PingPeerSessionSummary[],
    options: { maxRows?: number; excludeSessionId?: string; hasMore?: boolean } = {}
): string {
    const maxRows = options.maxRows ?? 30
    const excludeSessionId = options.excludeSessionId?.trim()
    const filtered = excludeSessionId ? sessions.filter((session) => session.id !== excludeSessionId) : sessions
    if (filtered.length === 0) return 'No peer sessions found on this hub/namespace.'

    const sorted = [...filtered].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const rows = sorted.slice(0, Math.max(1, maxRows)).map((session) => {
        const flavor = session.metadata?.flavor ?? '?'
        return `  ${session.id}  active=${session.active}  flavor=${flavor}  ${resolvePeerSessionLabel(session)}`
    })
    const omitted = sorted.length - rows.length
    if (options.hasMore) rows.push('  … more sessions available (narrow with inspect_peer / ping_peer by id)')
    else if (omitted > 0) rows.push(`  … ${omitted} more (narrow with inspect_peer / ping_peer by id)`)
    return rows.join('\n')
}

/** 唤醒（若需要）并向一个唯一 ID 前缀对应的会话投递消息。 */
export async function pingPeer(options: PingPeerOptions): Promise<PingPeerResult> {
    const prefix = normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    const message = options.message ?? ''
    if (!prefix) throw new PingPeerError('bad_args', 'session id prefix is required')
    if (!message) throw new PingPeerError('bad_args', 'message is required')

    const waitActiveSecs = options.waitActiveSecs ?? DEFAULT_WAIT_ACTIVE_SECS
    if (!Number.isFinite(waitActiveSecs) || waitActiveSecs <= 0) {
        throw new PingPeerError('bad_args', 'waitActiveSecs must be a positive number')
    }

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const sleep = options.sleep ?? defaultSleep
    const now = options.now ?? Date.now
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const matched = resolveSessionByPrefix(await listSessions(apiUrl, jwt, http), prefix)
    const callerSessionId = (options.callerSessionId ?? process.env.HAPI_SESSION_ID ?? '').trim()
    if (callerSessionId && matched.id === callerSessionId) {
        throw new PingPeerError('bad_args', 'refusing to ping the current SHAPI session')
    }
    const name = resolvePeerSessionLabel(matched)
    options.onProgress?.(`resolved ${matched.id} active=${matched.active} name="${name}"`)

    let resumed = false
    const ensureActive = async (progress: string): Promise<PingPeerSessionSummary> => {
        const session = await getSession(apiUrl, jwt, matched.id, http)
        if (session.active) return session
        options.onProgress?.(progress)
        await resumeSession(apiUrl, jwt, matched.id, http)
        resumed = true
        await waitUntilActive(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now, options.onProgress)
        return await getSession(apiUrl, jwt, matched.id, http)
    }

    if (!matched.active) {
        await ensureActive('requesting resume...')
    }
    const live = await ensureActive('session went inactive before send; requesting resume...')
    if (live.metadata?.flavor === 'pi') {
        await waitForPiReady(apiUrl, jwt, matched.id, waitActiveSecs, http, sleep, now)
        await ensureActive('session went inactive while Pi initialized; requesting resume...')
    }

    options.onProgress?.(`sending message (${message.length} chars)...`)
    await sendMessage(apiUrl, jwt, matched.id, message, http)
    return { sessionId: matched.id, name, resumed }
}

export function exitCodeForPingPeerError(error: PingPeerError): number {
    switch (error.code) {
        case 'bad_args':
        case 'auth_failed':
        case 'not_found':
        case 'ambiguous':
            return 2
        case 'resume_failed':
            return 3
        case 'timeout':
        case 'send_failed':
            return 4
    }
}

export type InspectPeerMessage = {
    id: string
    role: string
    text: string
    createdAt: number | null
}

export type InspectPeerResult = {
    sessionId: string
    name: string
    active: boolean
    thinking: boolean
    flavor: string | null
    path: string | null
    lifecycleState: string | null
    updatedAt: number | null
    messages: InspectPeerMessage[]
}

export type InspectPeerOptions = {
    sessionIdPrefix: string
    messageLimit?: number
    apiUrl?: string
    accessToken?: string
    http?: AxiosInstance
}

const DEFAULT_INSPECT_MESSAGE_LIMIT = 30
const MAX_INSPECT_MESSAGE_LIMIT = 100
const MAX_SNIPPET_CHARS = 1_200

function clampInspectMessageLimit(raw: number | undefined): number {
    const value = raw ?? DEFAULT_INSPECT_MESSAGE_LIMIT
    if (!Number.isFinite(value)) {
        throw new PingPeerError('bad_args', 'messageLimit must be a number')
    }
    return Math.min(MAX_INSPECT_MESSAGE_LIMIT, Math.max(1, Math.floor(value)))
}

function extractUserPlainText(inner: unknown): string | null {
    if (typeof inner === 'string' && inner.trim()) return inner
    if (!isObject(inner)) return null
    if (typeof inner.text === 'string' && inner.text.trim()) return inner.text
    if (isObject(inner.content) && typeof inner.content.text === 'string' && inner.content.text.trim()) {
        return inner.content.text
    }
    return null
}

/** 从 Hub 消息行中提取可安全展示给另一个 Agent 的摘要。 */
export function extractInspectMessageSnippet(content: unknown): InspectPeerMessage | null {
    if (!isObject(content)) return null
    const role = typeof content.role === 'string' ? content.role : 'unknown'
    const inner = content.content
    const text = role === 'user'
        ? extractUserPlainText(inner)
        : extractAssistantPlainText(inner) ?? extractUserPlainText(inner)
    if (!text) return null
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) return null
    return {
        id: typeof content.id === 'string' ? content.id : '',
        role,
        text: normalized.length > MAX_SNIPPET_CHARS ? `${normalized.slice(0, MAX_SNIPPET_CHARS)}…` : normalized,
        createdAt: null
    }
}

async function fetchSessionMessages(
    apiUrl: string,
    jwt: string,
    sessionId: string,
    limit: number,
    http: AxiosInstance
): Promise<InspectPeerMessage[]> {
    const response = await http.get(`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: authHeaders(jwt),
        params: { limit },
        timeout: 20_000,
        validateStatus: () => true
    })
    if (response.status < 200 || response.status >= 300) {
        const detail = typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`
        throw new PingPeerError('not_found', `failed to load messages for ${sessionId} (${detail})`)
    }
    const rows = Array.isArray(response.data?.messages) ? response.data.messages : []
    const result: InspectPeerMessage[] = []
    for (const row of rows) {
        if (!isObject(row)) continue
        const snippet = extractInspectMessageSnippet(row.content)
        if (!snippet) continue
        result.push({
            ...snippet,
            id: typeof row.id === 'string' ? row.id : snippet.id,
            createdAt: typeof row.createdAt === 'number' ? row.createdAt : null
        })
    }
    return result
}

/** 只读地查看另一会话的元数据和近期对话文本，绝不 resume。 */
export async function inspectPeer(options: InspectPeerOptions): Promise<InspectPeerResult> {
    const prefix = normalizeSessionIdPrefix(options.sessionIdPrefix ?? '')
    if (!prefix) throw new PingPeerError('bad_args', 'session id prefix is required')

    const apiUrl = resolveApiUrl(options.apiUrl)
    const accessToken = resolveAccessToken(options.accessToken)
    const http = options.http ?? axios
    const jwt = await exchangeJwt(apiUrl, accessToken, http)
    const matched = resolveSessionByPrefix(await listSessions(apiUrl, jwt, http), prefix)
    const live = await getSession(apiUrl, jwt, matched.id, http)
    const metadata = live.metadata ?? matched.metadata ?? null
    const messages = await fetchSessionMessages(
        apiUrl,
        jwt,
        matched.id,
        clampInspectMessageLimit(options.messageLimit),
        http
    )

    return {
        sessionId: matched.id,
        name: resolvePeerSessionLabel({ ...matched, metadata }),
        active: live.active,
        thinking: Boolean(live.thinking),
        flavor: typeof metadata?.flavor === 'string' ? metadata.flavor : null,
        path: typeof metadata?.path === 'string' ? metadata.path : null,
        lifecycleState: typeof metadata?.lifecycleState === 'string' ? metadata.lifecycleState : null,
        updatedAt: typeof live.updatedAt === 'number'
            ? live.updatedAt
            : typeof matched.updatedAt === 'number'
                ? matched.updatedAt
                : null,
        messages
    }
}

/** MCP 和命令行共享的人类/模型可读 inspect 输出。 */
export function formatInspectPeerReport(result: InspectPeerResult): string {
    const lines = [
        `sessionId: ${result.sessionId}`,
        `path: /sessions/${result.sessionId}`,
        `name: ${result.name}`,
        `flavor: ${result.flavor ?? '(unknown)'}`,
        `active: ${result.active}`,
        `thinking: ${result.thinking}`,
        `lifecycle: ${result.lifecycleState ?? '(none)'}`,
        `cwd: ${result.path ?? '(unknown)'}`,
        `updatedAt: ${result.updatedAt ?? '(unknown)'}`,
        `messages (text snippets, newest page): ${result.messages.length}`
    ]
    if (result.messages.length === 0) {
        lines.push('(no extractable user/assistant text in this page)')
    } else {
        for (const message of result.messages) {
            lines.push(`[${message.role}] ${message.text}`)
        }
    }
    return lines.join('\n')
}
