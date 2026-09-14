import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    OpenVikingContextListRequestSchema,
    OpenVikingContextReadRequestSchema,
    OpenVikingSearchRequestSchema,
    type OpenVikingContextEntry,
    type OpenVikingContextListRequest,
    type OpenVikingContextListResponse,
    type OpenVikingContextReadRequest,
    type OpenVikingContextReadResponse,
    type OpenVikingMetricsResponse,
    type OpenVikingQualityIssue,
    type OpenVikingQualityResponse,
    type OpenVikingSearchHit,
    type OpenVikingSearchRequest,
    type OpenVikingSearchResponse,
    type OpenVikingStatusResponse
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

const OPEN_VIKING_ORIGIN = 'http://127.0.0.1:1933'
const OPEN_VIKING_TIMEOUT_MS = 12_000

type OpenVikingCredentials = {
    apiKey?: string
    bearerToken?: string
    account?: string
    user?: string
}

function getStringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function getRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function firstEnvironmentValue(names: string[]): string | undefined {
    for (const name of names) {
        const value = getStringValue(process.env[name])
        if (value) return value
    }
    return undefined
}

async function readOpenVikingClientConfig(): Promise<Record<string, unknown>> {
    const path = getStringValue(process.env.OPENVIKING_CLI_CONFIG_FILE)
        ?? join(homedir(), '.openviking', 'ovcli.conf')
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        return getRecord(parsed) ?? {}
    } catch {
        return {}
    }
}

async function resolveOpenVikingCredentials(): Promise<OpenVikingCredentials> {
    const config = await readOpenVikingClientConfig()
    return {
        apiKey: firstEnvironmentValue(['HAPI_OPENVIKING_API_KEY', 'OPENVIKING_API_KEY'])
            ?? getStringValue(config.api_key),
        bearerToken: firstEnvironmentValue(['HAPI_OPENVIKING_BEARER_TOKEN', 'OPENVIKING_BEARER_TOKEN']),
        account: firstEnvironmentValue(['HAPI_OPENVIKING_ACCOUNT', 'OPENVIKING_ACCOUNT'])
            ?? getStringValue(config.account),
        user: firstEnvironmentValue(['HAPI_OPENVIKING_USER', 'OPENVIKING_USER'])
            ?? getStringValue(config.user)
    }
}

function openVikingHeaders(credentials: OpenVikingCredentials, includeIdentity: boolean): Headers {
    const headers = new Headers({ accept: 'application/json' })
    if (credentials.bearerToken) {
        headers.set('authorization', `Bearer ${credentials.bearerToken}`)
    } else if (credentials.apiKey) {
        headers.set('x-api-key', credentials.apiKey)
    }
    if (includeIdentity) {
        if (credentials.account) headers.set('x-openviking-account', credentials.account)
        if (credentials.user) headers.set('x-openviking-user', credentials.user)
    }
    return headers
}

function withTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timeout)
    }
}

function normalizeError(error: unknown): string {
    if (error instanceof Error) {
        return error.name === 'AbortError' ? 'OpenViking request timed out' : error.message
    }
    return String(error)
}

function openVikingUrl(path: string, uri?: string): string {
    const url = new URL(path, OPEN_VIKING_ORIGIN)
    if (uri) url.searchParams.set('uri', uri)
    return url.toString()
}

async function fetchOpenViking(url: string, credentials: OpenVikingCredentials, signal: AbortSignal, init?: RequestInit): Promise<Response> {
    const includeIdentity = Boolean(credentials.account || credentials.user)
    const request = (withIdentity: boolean) => {
        const headers = openVikingHeaders(credentials, withIdentity)
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
        return fetch(url, { ...init, method: init?.method ?? 'GET', headers, signal })
    }

    const initial = await request(includeIdentity)
    // OpenViking API-key mode rejects trusted identity headers. A retry without
    // them keeps the runner compatible with both documented auth modes.
    if (initial.status === 400 && includeIdentity && (credentials.apiKey || credentials.bearerToken)) {
        return await request(false)
    }
    return initial
}

function responseError(response: Response, body: unknown): string {
    const record = getRecord(body)
    const error = record?.error
    if (typeof error === 'string' && error.trim()) return error
    const nested = getRecord(error)
    const nestedMessage = getStringValue(nested?.message)
    if (nestedMessage) return nestedMessage
    const message = getStringValue(record?.message)
    return message ?? `OpenViking returned HTTP ${response.status}`
}

function nameFromContextUri(uri: string): string {
    const path = uri.slice('viking://'.length).replace(/\/+$/, '')
    return path.split('/').filter(Boolean).at(-1) ?? uri
}

function parseContextEntry(value: unknown): OpenVikingContextEntry | null {
    const entry = getRecord(value)
    const uri = getStringValue(entry?.uri)
    const name = getStringValue(entry?.name) ?? (uri ? nameFromContextUri(uri) : undefined)
    if (!name || !uri || typeof entry?.isDir !== 'boolean') return null

    const size = typeof entry.size === 'number' && Number.isFinite(entry.size)
        ? entry.size
        : undefined
    const modTime = getStringValue(entry.modTime)
    return {
        name,
        uri,
        isDir: entry.isDir,
        ...(size === undefined ? {} : { size }),
        ...(modTime ? { modTime } : {})
    }
}

async function getOpenVikingStatus(): Promise<OpenVikingStatusResponse> {
    const { signal, cleanup } = withTimeoutSignal(OPEN_VIKING_TIMEOUT_MS)
    try {
        const response = await fetch(openVikingUrl('/health'), {
            headers: { accept: 'application/json' },
            signal
        })
        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                error: `OpenViking returned HTTP ${response.status}`
            }
        }

        const data: unknown = await response.json().catch(() => null)
        const record = getRecord(data)
        return {
            ok: true,
            status: response.status,
            version: getStringValue(record?.version),
            authMode: getStringValue(record?.auth_mode)
        }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

async function listOpenVikingContext(rawRequest: unknown): Promise<OpenVikingContextListResponse> {
    const parsed = OpenVikingContextListRequestSchema.safeParse(rawRequest)
    if (!parsed.success) return { ok: false, error: 'Invalid OpenViking context URI' }

    const { signal, cleanup } = withTimeoutSignal(OPEN_VIKING_TIMEOUT_MS)
    try {
        const response = await fetchOpenViking(
            openVikingUrl('/api/v1/fs/ls', parsed.data.uri),
            await resolveOpenVikingCredentials(),
            signal
        )
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) return { ok: false, error: responseError(response, body) }

        const record = getRecord(body)
        if (record?.status !== 'ok' || !Array.isArray(record.result)) {
            return { ok: false, error: 'OpenViking returned an invalid context directory response' }
        }

        const entries = record.result
            .map(parseContextEntry)
            .filter((entry): entry is OpenVikingContextEntry => entry !== null)
            .sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
                return a.name.localeCompare(b.name)
            })
        return { ok: true, entries }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

async function readOpenVikingContext(rawRequest: unknown): Promise<OpenVikingContextReadResponse> {
    const parsed = OpenVikingContextReadRequestSchema.safeParse(rawRequest)
    if (!parsed.success) return { ok: false, error: 'Invalid OpenViking context URI' }

    const { signal, cleanup } = withTimeoutSignal(OPEN_VIKING_TIMEOUT_MS)
    try {
        const response = await fetchOpenViking(
            openVikingUrl('/api/v1/content/read', parsed.data.uri),
            await resolveOpenVikingCredentials(),
            signal
        )
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) return { ok: false, error: responseError(response, body) }

        const record = getRecord(body)
        if (record?.status !== 'ok' || typeof record.result !== 'string') {
            return { ok: false, error: 'OpenViking returned an invalid context content response' }
        }
        return { ok: true, content: record.result }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

type MetricSample = { labels: Record<string, string>; value: number }

function metricSamples(text: string, name: string): MetricSample[] {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^${escaped}(?:\\{([^}]*)\\})?\\s+([^\\s]+)$`)
    const samples: MetricSample[] = []
    for (const line of text.split('\n')) {
        const match = line.trim().match(pattern)
        if (!match) continue
        const value = Number(match[2])
        if (!Number.isFinite(value)) continue
        const labels: Record<string, string> = {}
        for (const label of (match[1] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g)) {
            labels[label[1]] = label[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        }
        samples.push({ labels, value })
    }
    return samples
}

function metricTotal(text: string, name: string): number {
    return metricSamples(text, name).reduce((total, sample) => total + sample.value, 0)
}

function histogramPercentile(text: string, name: string, percentile: number): number | undefined {
    const buckets = new Map<number, number>()
    for (const sample of metricSamples(text, `${name}_bucket`)) {
        const boundary = sample.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(sample.labels.le)
        if (!Number.isFinite(boundary) && boundary !== Number.POSITIVE_INFINITY) continue
        buckets.set(boundary, (buckets.get(boundary) ?? 0) + sample.value)
    }
    const ordered = [...buckets.entries()].sort(([left], [right]) => left - right)
    const count = ordered.at(-1)?.[1] ?? metricTotal(text, `${name}_count`)
    if (count <= 0) return undefined
    const target = count * percentile
    const match = ordered.find(([, value]) => value >= target)
    return match && Number.isFinite(match[0]) ? match[0] : undefined
}

async function getOpenVikingMetrics(): Promise<OpenVikingMetricsResponse> {
    const { signal, cleanup } = withTimeoutSignal(OPEN_VIKING_TIMEOUT_MS)
    try {
        const response = await fetchOpenViking(openVikingUrl('/metrics'), await resolveOpenVikingCredentials(), signal)
        const text = await response.text()
        if (!response.ok) return { ok: false, error: text.trim() || `OpenViking returned HTTP ${response.status}` }
        const retrievalRequests = metricTotal(text, 'openviking_retrieval_requests_total')
        const retrievalResults = metricTotal(text, 'openviking_retrieval_results_total')
        const zeroResults = metricTotal(text, 'openviking_retrieval_zero_result_total')
        const latencyCount = metricTotal(text, 'openviking_retrieval_latency_seconds_count')
        const latencySum = metricTotal(text, 'openviking_retrieval_latency_seconds_sum')
        const p95 = histogramPercentile(text, 'openviking_retrieval_latency_seconds', 0.95)
        return {
            ok: true,
            retrievalRequests,
            retrievalResults,
            zeroResults,
            zeroResultRate: retrievalRequests > 0 ? zeroResults / retrievalRequests : 0,
            averageLatencyMs: latencyCount > 0 ? latencySum / latencyCount * 1000 : undefined,
            p95LatencyMs: p95 === undefined ? undefined : p95 * 1000,
            rerankUses: metricTotal(text, 'openviking_retrieval_rerank_used_total'),
            rerankFallbacks: metricTotal(text, 'openviking_retrieval_rerank_fallback_total'),
            queuePending: metricTotal(text, 'openviking_queue_pending'),
            queueInProgress: metricTotal(text, 'openviking_queue_in_progress')
        }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

function parseSearchHit(value: unknown, fallbackType: OpenVikingSearchHit['contextType']): OpenVikingSearchHit | null {
    const record = getRecord(value)
    const uri = getStringValue(record?.uri)
    if (!uri) return null
    const rawType = getStringValue(record?.context_type)
    const contextType = rawType === 'memory' || rawType === 'resource' || rawType === 'skill' ? rawType : fallbackType
    return {
        uri,
        contextType,
        ...(typeof record?.level === 'number' ? { level: record.level } : {}),
        ...(typeof record?.score === 'number' ? { score: record.score } : {}),
        ...(getStringValue(record?.abstract) ? { abstract: getStringValue(record?.abstract) } : {}),
        ...(getStringValue(record?.match_reason) ? { matchReason: getStringValue(record?.match_reason) } : {})
    }
}

async function searchOpenViking(rawRequest: unknown): Promise<OpenVikingSearchResponse> {
    const parsed = OpenVikingSearchRequestSchema.safeParse(rawRequest)
    if (!parsed.success) return { ok: false, error: 'Invalid OpenViking search request' }
    const { signal, cleanup } = withTimeoutSignal(OPEN_VIKING_TIMEOUT_MS)
    const startedAt = performance.now()
    try {
        const response = await fetchOpenViking(
            openVikingUrl('/api/v1/search/find'),
            await resolveOpenVikingCredentials(),
            signal,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parsed.data) }
        )
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok) return { ok: false, durationMs: Math.round(performance.now() - startedAt), error: responseError(response, body) }
        const result = getRecord(getRecord(body)?.result)
        if (!result) return { ok: false, error: 'OpenViking returned an invalid search response' }
        const hits = ([
            ...(Array.isArray(result.memories) ? result.memories.map((item) => parseSearchHit(item, 'memory')) : []),
            ...(Array.isArray(result.resources) ? result.resources.map((item) => parseSearchHit(item, 'resource')) : []),
            ...(Array.isArray(result.skills) ? result.skills.map((item) => parseSearchHit(item, 'skill')) : [])
        ]).filter((hit): hit is OpenVikingSearchHit => hit !== null).sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
        return { ok: true, durationMs: Math.round(performance.now() - startedAt), total: hits.length, hits }
    } catch (error) {
        return { ok: false, durationMs: Math.round(performance.now() - startedAt), error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

function normalizedMemory(content: string): string {
    return content.toLowerCase().replace(/^---[\s\S]*?---/m, '').replace(/[`#*_>\-[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
}

function similarityTokens(content: string): Set<string> {
    const normalized = normalizedMemory(content)
    const words = normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g) ?? []
    return new Set(words.flatMap((word) => /^[\u3400-\u9fff]+$/.test(word) && word.length > 2 ? [...word].map((_, index) => word.slice(index, index + 2)).filter((value) => value.length === 2) : [word]))
}

function jaccard(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) return 0
    let intersection = 0
    for (const token of left) if (right.has(token)) intersection += 1
    return intersection / (left.size + right.size - intersection)
}

function explicitFacts(content: string): Map<string, string> {
    const facts = new Map<string, string>()
    for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/^\s*[-*]\s*/, '').trim()
        const match = line.match(/^([^:#=：]{2,60}?)(?:\s*[:=：]\s*|\s+is\s+|\s*是\s*)(.{1,240})$/i)
        if (!match) continue
        const key = match[1].toLowerCase().replace(/\s+/g, ' ').trim()
        const value = match[2].toLowerCase().replace(/[。.!！\s]+$/g, '').replace(/\s+/g, ' ').trim()
        if (/^[\p{L}\p{N}_ /-]+$/u.test(key) && key && value) facts.set(key, value)
    }
    return facts
}

async function getOpenVikingQuality(): Promise<OpenVikingQualityResponse> {
    const { signal, cleanup } = withTimeoutSignal(30_000)
    const credentials = await resolveOpenVikingCredentials()
    const files: OpenVikingContextEntry[] = []
    let scanLimited = false
    try {
        const queue = ['viking://~/memories']
        while (queue.length > 0 && files.length < 120) {
            const uri = queue.shift()
            if (!uri) break
            const response = await fetchOpenViking(openVikingUrl('/api/v1/fs/ls', uri), credentials, signal)
            const body: unknown = await response.json().catch(() => null)
            if (!response.ok) {
                if (uri === 'viking://~/memories') {
                    return { ok: false, error: responseError(response, body) }
                }
                continue
            }
            const result = getRecord(body)?.result
            if (!Array.isArray(result)) continue
            for (const value of result) {
                const entry = parseContextEntry(value)
                if (!entry) continue
                if (entry.isDir) queue.push(entry.uri)
                else if (/\.(md|txt|json|ya?ml|toml)$/i.test(entry.name)) files.push(entry)
                if (files.length >= 120) { scanLimited = true; break }
            }
        }

        const documents: Array<{ entry: OpenVikingContextEntry; content: string; tokens: Set<string>; facts: Map<string, string> }> = []
        for (const entry of files) {
            const response = await fetchOpenViking(openVikingUrl('/api/v1/content/read', entry.uri), credentials, signal)
            const body: unknown = await response.json().catch(() => null)
            const content = getRecord(body)?.result
            if (response.ok && typeof content === 'string' && content.length <= 256_000) documents.push({ entry, content, tokens: similarityTokens(content), facts: explicitFacts(content) })
        }

        const issues: OpenVikingQualityIssue[] = []
        const duplicateMembers = new Set<string>()
        for (let left = 0; left < documents.length; left += 1) {
            for (let right = left + 1; right < documents.length; right += 1) {
                if (duplicateMembers.has(documents[right].entry.uri)) continue
                if (jaccard(documents[left].tokens, documents[right].tokens) >= 0.88) {
                    issues.push({ kind: 'duplicate', uris: [documents[left].entry.uri, documents[right].entry.uri], summary: `${documents[left].entry.name} · ${documents[right].entry.name}` })
                    duplicateMembers.add(documents[right].entry.uri)
                    break
                }
            }
            if (issues.filter((issue) => issue.kind === 'duplicate').length >= 12) break
        }

        const factIndex = new Map<string, Map<string, string[]>>()
        for (const document of documents) for (const [key, value] of document.facts) {
            const values = factIndex.get(key) ?? new Map<string, string[]>()
            values.set(value, [...(values.get(value) ?? []), document.entry.uri])
            factIndex.set(key, values)
        }
        for (const [key, values] of factIndex) {
            if (values.size < 2) continue
            const uris = [...new Set([...values.values()].flat())]
            if (uris.length < 2) continue
            issues.push({ kind: 'conflict', uris: uris.slice(0, 4), summary: key })
            if (issues.filter((issue) => issue.kind === 'conflict').length >= 12) break
        }

        const now = Date.now()
        const ages = documents.map(({ entry }) => entry.modTime ? Math.max(0, (now - Date.parse(entry.modTime)) / 86_400_000) : undefined).filter((age): age is number => age !== undefined && Number.isFinite(age))
        return {
            ok: true,
            scannedMemories: documents.length,
            scanLimited,
            totalMemories: files.length,
            stale7d: ages.filter((age) => age >= 7).length,
            stale30d: ages.filter((age) => age >= 30).length,
            oldestMemoryAgeDays: ages.length ? Math.round(Math.max(...ages)) : undefined,
            duplicateGroups: issues.filter((issue) => issue.kind === 'duplicate').length,
            conflictGroups: issues.filter((issue) => issue.kind === 'conflict').length,
            issues,
            checkedAt: Date.now()
        }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

export function registerOpenVikingHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<void, OpenVikingStatusResponse>(
        RPC_METHODS.OpenVikingStatus,
        getOpenVikingStatus
    )
    rpcHandlerManager.registerHandler<OpenVikingContextListRequest, OpenVikingContextListResponse>(
        RPC_METHODS.OpenVikingListContext,
        listOpenVikingContext
    )
    rpcHandlerManager.registerHandler<OpenVikingContextReadRequest, OpenVikingContextReadResponse>(
        RPC_METHODS.OpenVikingReadContext,
        readOpenVikingContext
    )
    rpcHandlerManager.registerHandler<void, OpenVikingMetricsResponse>(RPC_METHODS.OpenVikingMetrics, getOpenVikingMetrics)
    rpcHandlerManager.registerHandler<OpenVikingSearchRequest, OpenVikingSearchResponse>(RPC_METHODS.OpenVikingSearch, searchOpenViking)
    rpcHandlerManager.registerHandler<void, OpenVikingQualityResponse>(RPC_METHODS.OpenVikingQuality, getOpenVikingQuality)
}
