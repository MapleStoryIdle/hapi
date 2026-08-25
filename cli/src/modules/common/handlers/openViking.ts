import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
    OpenVikingContextListRequestSchema,
    OpenVikingContextReadRequestSchema,
    type OpenVikingContextEntry,
    type OpenVikingContextListRequest,
    type OpenVikingContextListResponse,
    type OpenVikingContextReadRequest,
    type OpenVikingContextReadResponse,
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

async function fetchOpenViking(url: string, credentials: OpenVikingCredentials, signal: AbortSignal): Promise<Response> {
    const includeIdentity = Boolean(credentials.account || credentials.user)
    const request = (withIdentity: boolean) => fetch(url, {
        method: 'GET',
        headers: openVikingHeaders(credentials, withIdentity),
        signal
    })

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
}
