import {
    LocalPreviewHttpRequestSchema,
    LocalPreviewProbeRequestSchema,
    type LocalPreviewHttpRequest,
    type LocalPreviewHttpResponse,
    type LocalPreviewProbeRequest,
    type LocalPreviewProbeResponse
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'

const LOCAL_PREVIEW_TIMEOUT_MS = 8_000
const LOCAL_PREVIEW_MAX_BYTES = 25 * 1024 * 1024
const LOCAL_PREVIEW_CHECK_MAX_TEXT_BYTES = 512 * 1024

const BLOCKED_PORTS = new Set([
    22,
    25,
    110,
    143,
    3306,
    5432,
    6379,
    9200,
    9300,
    11211,
    27017
])

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

function isBlockedLocalPreviewPort(port: number): boolean {
    return BLOCKED_PORTS.has(port)
}

function buildLocalPreviewUrl(request: Pick<LocalPreviewProbeRequest, 'protocol' | 'port' | 'path'>): string {
    const path = request.path.startsWith('/') ? request.path : `/${request.path}`
    return `${request.protocol}://127.0.0.1:${request.port}${path}`
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
        return error.name === 'AbortError' ? 'Local preview request timed out' : error.message
    }
    return String(error)
}

function filterRequestHeaders(headers: Record<string, string> | undefined): Headers {
    const filtered = new Headers()
    if (!headers) return filtered

    for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase()
        if (!FORWARDED_REQUEST_HEADERS.has(normalizedName)) continue
        filtered.set(normalizedName, value)
    }

    return filtered
}

function filterResponseHeaders(headers: Headers): Record<string, string> {
    const filtered: Record<string, string> = {}
    headers.forEach((value, name) => {
        const normalizedName = name.toLowerCase()
        if (BLOCKED_RESPONSE_HEADERS.has(normalizedName)) return
        filtered[normalizedName] = value
    })
    return filtered
}

function extractHtmlTitle(text: string): string | null {
    const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (!match) return null
    return match[1]
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || null
}

async function readPreviewBody(response: Response): Promise<Uint8Array> {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > LOCAL_PREVIEW_MAX_BYTES) {
        throw new Error('Local preview response is too large')
    }
    return bytes
}

async function checkLocalPreview(rawRequest: unknown): Promise<LocalPreviewProbeResponse> {
    const parsed = LocalPreviewProbeRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
        return { ok: false, error: 'Invalid local preview probe request' }
    }
    const request = parsed.data
    if (isBlockedLocalPreviewPort(request.port)) {
        return { ok: false, error: 'Port is not allowed for local preview' }
    }

    const { signal, cleanup } = withTimeoutSignal(LOCAL_PREVIEW_TIMEOUT_MS)
    try {
        const response = await fetch(buildLocalPreviewUrl(request), {
            method: 'GET',
            headers: {
                accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8'
            },
            signal,
            redirect: 'follow'
        })

        const contentType = response.headers.get('content-type')
        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                contentType,
                error: `Local preview returned HTTP ${response.status}`
            }
        }

        let title: string | null = null
        const contentLength = Number(response.headers.get('content-length') ?? '0')
        if (
            contentType?.toLowerCase().includes('text/html')
            && Number.isFinite(contentLength)
            && contentLength <= LOCAL_PREVIEW_CHECK_MAX_TEXT_BYTES
        ) {
            title = extractHtmlTitle(await response.text())
        }

        return {
            ok: true,
            status: response.status,
            contentType,
            title
        }
    } catch (error) {
        return { ok: false, error: normalizeError(error) }
    } finally {
        cleanup()
    }
}

async function proxyLocalPreviewRequest(rawRequest: unknown): Promise<LocalPreviewHttpResponse> {
    const parsed = LocalPreviewHttpRequestSchema.safeParse(rawRequest)
    if (!parsed.success) {
        return { ok: false, status: 400, headers: {}, bodyBase64: '', error: 'Invalid local preview request' }
    }
    const request = parsed.data as LocalPreviewHttpRequest
    if (isBlockedLocalPreviewPort(request.port)) {
        return { ok: false, status: 403, headers: {}, bodyBase64: '', error: 'Port is not allowed for local preview' }
    }

    const { signal, cleanup } = withTimeoutSignal(LOCAL_PREVIEW_TIMEOUT_MS)
    try {
        const method = request.method.toUpperCase()
        const bodyBase64 = !['GET', 'HEAD'].includes(method) ? request.bodyBase64 : undefined
        const response = await fetch(buildLocalPreviewUrl(request), {
            method,
            headers: filterRequestHeaders(request.headers),
            body: bodyBase64 ? Buffer.from(bodyBase64, 'base64') : undefined,
            redirect: 'manual',
            signal
        })
        const bytes = await readPreviewBody(response)

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

export function registerLocalPreviewHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<LocalPreviewProbeRequest, LocalPreviewProbeResponse>(
        RPC_METHODS.LocalPreviewCheck,
        checkLocalPreview
    )
    rpcHandlerManager.registerHandler<LocalPreviewHttpRequest, LocalPreviewHttpResponse>(
        RPC_METHODS.LocalPreviewHttpRequest,
        proxyLocalPreviewRequest
    )
}
