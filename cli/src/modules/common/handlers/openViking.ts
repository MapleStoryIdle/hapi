import {
    OpenVikingHttpRequestSchema,
    type OpenVikingHttpRequest,
    type OpenVikingHttpResponse,
    type OpenVikingStatusResponse
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

const OPEN_VIKING_ORIGIN = 'http://127.0.0.1:1933'
const OPEN_VIKING_TIMEOUT_MS = 12_000
const OPEN_VIKING_MAX_BYTES = 25 * 1024 * 1024

const FORWARDED_REQUEST_HEADERS = new Set([
    'accept',
    'accept-language',
    'content-type',
    'range',
    'user-agent'
])

const BLOCKED_RESPONSE_HEADERS = new Set([
    'connection',
    'content-encoding',
    'content-length',
    'content-security-policy',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'referrer-policy',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-frame-options'
])

function resolveOpenVikingUrl(path: string): URL | null {
    try {
        const url = new URL(path, OPEN_VIKING_ORIGIN)
        return url.origin === OPEN_VIKING_ORIGIN ? url : null
    } catch {
        return null
    }
}

function isOpenVikingPath(path: string): boolean {
    const url = resolveOpenVikingUrl(path)
    if (!url) return false

    const pathname = url.pathname
    return pathname === '/health'
        || pathname === '/ready'
        || pathname === '/studio'
        || pathname.startsWith('/studio/')
        || pathname.startsWith('/api/')
        || pathname.startsWith('/bot/')
        || pathname.startsWith('/oauth/')
        || pathname.startsWith('/.well-known/')
}

function openVikingUrl(path: string): string {
    const url = resolveOpenVikingUrl(path)
    if (!url) {
        throw new Error('Invalid OpenViking URL')
    }
    return url.toString()
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

function filterRequestHeaders(headers: Record<string, string> | undefined): Headers {
    const filtered = new Headers()
    if (!headers) return filtered

    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase()
        if (FORWARDED_REQUEST_HEADERS.has(normalizedName)) {
            filtered.set(normalizedName, value)
        }
    }

    return filtered
}

function filterResponseHeaders(headers: Headers): Record<string, string> {
    const filtered: Record<string, string> = {}
    headers.forEach((value, name) => {
        if (!BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            filtered[name] = value
        }
    })
    return filtered
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
    const declaredSize = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredSize) && declaredSize > OPEN_VIKING_MAX_BYTES) {
        throw new Error('OpenViking response is too large')
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > OPEN_VIKING_MAX_BYTES) {
        throw new Error('OpenViking response is too large')
    }
    return bytes
}

function getStringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined
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
        const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
        return {
            ok: true,
            status: response.status,
            version: getStringValue(record.version),
            authMode: getStringValue(record.auth_mode)
        }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

async function proxyOpenVikingRequest(rawRequest: unknown): Promise<OpenVikingHttpResponse> {
    const parsed = OpenVikingHttpRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
        return { ok: false, status: 400, headers: {}, bodyBase64: '', error: 'Invalid OpenViking request' }
    }

    const request = parsed.data as OpenVikingHttpRequest
    if (!isOpenVikingPath(request.path)) {
        return { ok: false, status: 403, headers: {}, bodyBase64: '', error: 'OpenViking path is not allowed' }
    }

    const { signal, cleanup } = withTimeoutSignal(OPEN_VIKING_TIMEOUT_MS)
    try {
        const method = request.method.toUpperCase()
        const bodyBase64 = !['GET', 'HEAD'].includes(method) ? request.bodyBase64 : undefined
        const response = await fetch(openVikingUrl(request.path), {
            method,
            headers: filterRequestHeaders(request.headers),
            body: bodyBase64 ? Buffer.from(bodyBase64, 'base64') : undefined,
            redirect: 'manual',
            signal
        })
        const bytes = await readResponseBody(response)

        return {
            ok: true,
            status: response.status,
            statusText: response.statusText,
            headers: filterResponseHeaders(response.headers),
            bodyBase64: Buffer.from(bytes).toString('base64')
        }
    } catch (error) {
        return {
            ok: false,
            status: 502,
            headers: {},
            bodyBase64: '',
            error: normalizeError(error)
        }
    } finally {
        cleanup()
    }
}

export function registerOpenVikingHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<void, OpenVikingStatusResponse>(
        RPC_METHODS.OpenVikingStatus,
        getOpenVikingStatus
    )
    rpcHandlerManager.registerHandler<OpenVikingHttpRequest, OpenVikingHttpResponse>(
        RPC_METHODS.OpenVikingHttpRequest,
        proxyOpenVikingRequest
    )
}
