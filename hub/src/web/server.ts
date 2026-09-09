import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { serveStatic } from 'hono/bun'
import { getConfiguration } from '../configuration'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { buildGeminiLiveSetupMessage, QWEN_REALTIME_MODEL } from '@hapi/protocol/voice'
import { createQwenProxyWebSocketHandler } from './qwenProxyHandler'
import { decodeVoiceSystemPromptParam } from '../voiceSystemPromptParam'
import type { SyncEngine } from '../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from './middleware/auth'
import { createAuthRoutes } from './routes/auth'
import { createBindRoutes } from './routes/bind'
import { createEventsRoutes } from './routes/events'
import { createSessionsRoutes } from './routes/sessions'
import { createMessagesRoutes } from './routes/messages'
import { createPermissionsRoutes } from './routes/permissions'
import { createMachinesRoutes } from './routes/machines'
import { createGitRoutes } from './routes/git'
import { createLocalServiceRoutes } from './routes/localServices'
import { createWebReaderRoutes } from './routes/webReader'
import type { LocalServiceManager } from '../localServices/manager'
import type { LocalServiceHandler, LocalServiceWebSocket } from '../localServices/gateway'
import { createOpenVikingRoutes } from './routes/openViking'
import { createCliRoutes } from './routes/cli'
import { createCodexDesktopRoutes } from './routes/codexDesktop'
import { createPushRoutes } from './routes/push'
import { createVoiceRoutes } from './routes/voice'
import { createLegacyPublicShareTombstoneRoutes, createPublicShareRoutes } from './routes/shares'
import { createShareManagementRoutes } from './routes/shareManagement'
import { createPublicFeedbackRoutes } from './routes/feedback'
import { createMonitorRoutes, createMonitorWebhookRoutes } from './routes/monitors'
import type { MonitoringService } from '../monitoring/service'
import type { PushService } from '../push/pushService'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { Server as BunServer, ServerWebSocket } from 'bun'
import type { Server as SocketEngine } from '@socket.io/bun-engine'
import { jwtVerify } from 'jose'
import type { WebSocketData } from '@socket.io/bun-engine'
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'
import type { Store } from '../store'

// Normalise upstream close codes before forwarding to the browser client.
// Codes 1005/1006/1015 are reserved and cannot be sent in a close frame;
// abnormal upstream drops commonly produce 1006, which would throw on clientWs.close().
function toClientCloseCode(code: number): number {
    return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015
        ? code
        : 1011
}

function decodeWsText(message: string | ArrayBuffer | Uint8Array): string {
    if (typeof message === 'string') return message
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message)
    return new TextDecoder().decode(bytes)
}

function isGeminiSetupFrame(message: string | ArrayBuffer | Uint8Array): boolean {
    try {
        const parsed = JSON.parse(decodeWsText(message)) as unknown
        return parsed !== null && typeof parsed === 'object' && 'setup' in (parsed as object)
    } catch {
        return false
    }
}

function isGeminiSetupCompleteFrame(message: string | ArrayBuffer | Uint8Array): boolean {
    try {
        const parsed = JSON.parse(decodeWsText(message)) as unknown
        return parsed !== null && typeof parsed === 'object' && 'setupComplete' in (parsed as object)
    } catch {
        return false
    }
}

const MAX_GEMINI_PENDING_BYTES = 1024 * 1024 // 1 MiB — rejects setup-window floods
function frameByteSize(msg: string | ArrayBuffer | Uint8Array): number {
    return typeof msg === 'string' ? msg.length : (msg as ArrayBuffer | Uint8Array).byteLength
}

// Gemini Live WebSocket proxy — relays browser WS to Google, bypassing region restrictions
function createGeminiProxyWebSocketHandler() {
    const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
    const upstreamMap = new WeakMap<ServerWebSocket<unknown>, WebSocket>()
    // pendingMap holds queued client frames until Google acknowledges setup via setupComplete.
    // Flushed on setupComplete; until then message() queues rather than forwards.
    const pendingMap = new WeakMap<ServerWebSocket<unknown>, Array<string | ArrayBuffer | Uint8Array>>()
    const pendingBytesMap = new WeakMap<ServerWebSocket<unknown>, number>()

    return {
        open(clientWs: ServerWebSocket<unknown>) {
            const data = clientWs.data as {
                _geminiProxy: boolean
                apiKey: string
                language?: string
                voiceName?: string
                systemInstruction?: string
                affectiveDialog?: boolean
            }
            const upstreamUrl = `${process.env.GEMINI_LIVE_WS_URL || GEMINI_WS_BASE}?key=${encodeURIComponent(data.apiKey)}`
            const pending: Array<string | ArrayBuffer | Uint8Array> = []
            pendingMap.set(clientWs, pending)
            pendingBytesMap.set(clientWs, 0)

            const upstream = new WebSocket(upstreamUrl)
            upstreamMap.set(clientWs, upstream)

            upstream.onopen = () => {
                // Hub-owned setup only — never forward client setup (prevents generic Gemini proxy abuse).
                // Do NOT flush pending here: wait for Google's setupComplete before forwarding client frames.
                upstream.send(JSON.stringify(buildGeminiLiveSetupMessage(
                    data.language,
                    data.voiceName,
                    data.systemInstruction,
                    { affectiveDialog: data.affectiveDialog }
                )))
            }
            upstream.onmessage = (event) => {
                try {
                    if (clientWs.readyState === 1) {
                        clientWs.send(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer))
                    }
                } catch { /* client gone */ }
                // Flush queued client frames only after Google acknowledges setup.
                const pending = pendingMap.get(clientWs)
                if (pending && isGeminiSetupCompleteFrame(event.data as string | ArrayBuffer)) {
                    pendingMap.delete(clientWs)
                    pendingBytesMap.delete(clientWs)
                    for (const queued of pending) {
                        try { upstream.send(queued) } catch { /* upstream gone */ }
                    }
                }
            }
            upstream.onerror = () => {
                pendingMap.delete(clientWs)
                pendingBytesMap.delete(clientWs)
                try { clientWs.close(1011, 'Upstream error') } catch { /* */ }
            }
            upstream.onclose = (event) => {
                pendingMap.delete(clientWs)
                pendingBytesMap.delete(clientWs)
                try { clientWs.close(toClientCloseCode(event.code), event.reason || 'Upstream closed') } catch { /* client gone */ }
                upstreamMap.delete(clientWs)
            }
        },
        message(clientWs: ServerWebSocket<unknown>, message: string | ArrayBuffer | Uint8Array) {
            if (isGeminiSetupFrame(message)) {
                try { clientWs.close(1008, 'Client-provided Gemini setup is not allowed') } catch { /* */ }
                return
            }
            const upstream = upstreamMap.get(clientWs)
            const pending = pendingMap.get(clientWs)
            if (pending) {
                // Still awaiting setupComplete — queue, but cap to prevent setup-window floods.
                const total = (pendingBytesMap.get(clientWs) ?? 0) + frameByteSize(message)
                if (total > MAX_GEMINI_PENDING_BYTES) {
                    try { clientWs.close(1009, 'Setup-window frame budget exceeded') } catch { /* */ }
                    return
                }
                pendingBytesMap.set(clientWs, total)
                pending.push(message)
            } else if (upstream?.readyState === WebSocket.OPEN) {
                upstream.send(message)
            }
        },
        close(clientWs: ServerWebSocket<unknown>, code: number, reason: string) {
            const upstream = upstreamMap.get(clientWs)
            pendingMap.delete(clientWs)
            pendingBytesMap.delete(clientWs)
            if (upstream) {
                try { upstream.close(toClientCloseCode(code), (reason || 'Client closed').slice(0, 123)) } catch { /* */ }
                upstreamMap.delete(clientWs)
            }
        }
    }
}

// Qwen Realtime WebSocket proxy — bridges browser (no custom headers) to DashScope
// (requires Authorization header). Implementation extracted to `./qwenProxyHandler` so
// the ack-gating behaviour is unit-testable; `createQwenProxyWebSocketHandler` is imported above.

function findWebappDistDir(webappDistDir?: string): { distDir: string; indexHtmlPath: string } {
    if (webappDistDir) {
        return { distDir: webappDistDir, indexHtmlPath: join(webappDistDir, 'index.html') }
    }

    const candidates = [
        join(process.cwd(), '..', 'web', 'dist'),
        join(import.meta.dir, '..', '..', '..', 'web', 'dist'),
        join(process.cwd(), 'web', 'dist')
    ]

    for (const distDir of candidates) {
        const indexHtmlPath = join(distDir, 'index.html')
        if (existsSync(indexHtmlPath)) {
            return { distDir, indexHtmlPath }
        }
    }

    const distDir = candidates[0]
    return { distDir, indexHtmlPath: join(distDir, 'index.html') }
}

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const FONT_CACHE_CONTROL = 'public, max-age=2592000'
const NO_CACHE_CONTROL = 'no-cache'

function getWebAssetCacheControl(path: string): string | undefined {
    if (path === '/sw.js' || path.endsWith('.html')) {
        return NO_CACHE_CONTROL
    }

    if (path.startsWith('/assets/')) {
        return IMMUTABLE_ASSET_CACHE_CONTROL
    }

    if (path.startsWith('/fonts/')) {
        return FONT_CACHE_CONTROL
    }

    return undefined
}

function applyStaticCacheControl(c: Context, filePath: string): void {
    const cacheControl = getWebAssetCacheControl(c.req.path)
        ?? (filePath.endsWith('.html') ? NO_CACHE_CONTROL : undefined)

    if (cacheControl) {
        c.header('Cache-Control', cacheControl)
    }
}

function serveEmbeddedAsset(asset: EmbeddedWebAsset): Response {
    const cacheControl = getWebAssetCacheControl(asset.path)

    return new Response(Bun.file(asset.sourcePath), {
        headers: {
            'Content-Type': asset.mimeType,
            ...(cacheControl ? { 'Cache-Control': cacheControl } : {})
        }
    })
}

export function createWebApp(options: {
    getMonitoring?: () => MonitoringService | null
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    jwtSecret: Uint8Array
    store: Store
    vapidPublicKey: string
    pushService: PushService
    corsOrigins?: string[]
    embeddedAssetMap: Map<string, EmbeddedWebAsset> | null
    webappDistDir?: string
    relayMode?: boolean
    officialWebUrl?: string
    getLocalServices?: () => LocalServiceManager | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/s/') || c.req.path.startsWith('/a/') || c.req.path.startsWith('/f/') || c.req.path.startsWith('/hooks/')) return await next()
        return await logger()(c, next)
    })

    // Health check endpoint (no auth required)
    app.get('/health', (c) => c.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION }))

    const configuration = getConfiguration()
    const corsOrigins = options.corsOrigins ?? configuration.corsOrigins
    const corsOriginOption = corsOrigins.includes('*') ? '*' : corsOrigins
    const corsMiddleware = cors({
        origin: corsOriginOption,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type']
    })
    app.use('/api/*', corsMiddleware)
    app.use('/cli/*', corsMiddleware)

    app.route('/cli', createCliRoutes(options.getSyncEngine, options.store))
    app.route('/s', createPublicShareRoutes(options.store))
    app.route('/f', createPublicFeedbackRoutes(options.store, undefined, options.pushService))
    app.route('/a', createLegacyPublicShareTombstoneRoutes())
    app.route('/hooks', createMonitorWebhookRoutes(options.getMonitoring ?? (() => null), options.store))

    app.route('/api', createAuthRoutes(options.jwtSecret, options.store))
    app.route('/api', createBindRoutes(options.jwtSecret, options.store))

    app.use('/api/*', createAuthMiddleware(options.jwtSecret))
    app.route('/api', createWebReaderRoutes())
    app.route('/api', createMonitorRoutes(options.store, options.getSyncEngine, options.getMonitoring ?? (() => null)))
    app.route('/api', createEventsRoutes(options.getSseManager, options.getSyncEngine, options.getVisibilityTracker))
    app.route('/api', createSessionsRoutes(options.getSyncEngine))
    app.route('/api', createMessagesRoutes(options.getSyncEngine))
    app.route('/api', createPermissionsRoutes(options.getSyncEngine))
    app.route('/api', createMachinesRoutes(options.getSyncEngine))
    app.route('/api', createGitRoutes(options.getSyncEngine))
    app.route('/api', createLocalServiceRoutes(options.getSyncEngine, options.getLocalServices ?? (() => null)))
    app.route('/api', createOpenVikingRoutes(options.getSyncEngine))
    app.route('/api', createShareManagementRoutes(options.store, undefined, options.getSyncEngine))
    // 中文注释：这里提供两类 Codex 辅助能力：扫描本地 transcript 以导入到 SHAPI，以及按需重启 Codex Desktop 客户端。
    app.route('/api', createCodexDesktopRoutes({
        store: options.store,
        getSyncEngine: options.getSyncEngine
    }))
    app.route('/api', createPushRoutes(options.store, options.vapidPublicKey))
    app.route('/api', createVoiceRoutes())

    // Skip static serving in relay mode, show helpful message on root
    if (options.relayMode) {
        const officialUrl = options.officialWebUrl || 'https://maplestoryidle.github.io/shapi'
        app.get('/', (c) => {
            return c.html(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>SHAPI Hub</title></head>
<body style="font-family: system-ui; padding: 2rem; max-width: 600px;">
<h1>SHAPI Hub</h1>
<p>This hub is running in relay mode. Please use the configured web app:</p>
<p><a href="${officialUrl}">${officialUrl}</a></p>
<details>
<summary>Why am I seeing this?</summary>
<p style="margin-top: 0.5rem; color: #666;">
When relay mode is enabled, all traffic flows through our relay infrastructure with end-to-end encryption.
To reduce bandwidth and improve performance, the frontend is served separately
from GitHub Pages instead of through the relay tunnel.
</p>
</details>
</body>
</html>`)
        })
        return app
    }

    if (options.embeddedAssetMap) {
        const embeddedAssetMap = options.embeddedAssetMap
        const indexHtmlAsset = embeddedAssetMap.get('/index.html')

        if (!indexHtmlAsset) {
            app.get('*', (c) => {
                return c.text(
                    'Embedded Mini App is missing index.html. Rebuild the executable after running bun run build:web.',
                    503
                )
            })
            return app
        }

        app.use('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                return await next()
            }

            if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
                return await next()
            }

            const asset = embeddedAssetMap.get(c.req.path)
            if (asset) {
                return serveEmbeddedAsset(asset)
            }

            return await next()
        })

        app.all('/assets', (c) => c.notFound())
        app.all('/assets/*', (c) => c.notFound())

        app.get('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                await next()
                return
            }

            return serveEmbeddedAsset(indexHtmlAsset)
        })

        return app
    }

    const { distDir, indexHtmlPath } = findWebappDistDir(options.webappDistDir)

    if (!existsSync(indexHtmlPath)) {
        app.get('/', (c) => {
            return c.text(
                'Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n',
                503
            )
        })
        return app
    }

    const staticFiles = serveStatic({
        root: distDir,
        onFound: (path, c) => applyStaticCacheControl(c, path)
    })
    const indexHtml = serveStatic({
        root: distDir,
        path: 'index.html',
        onFound: (path, c) => applyStaticCacheControl(c, path)
    })

    app.use('/assets/*', staticFiles)
    app.all('/assets', (c) => c.notFound())
    app.all('/assets/*', (c) => c.notFound())

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await staticFiles(c, next)
    })

    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await indexHtml(c, next)
    })

    return app
}

export async function startWebServer(options: {
    getMonitoring?: () => MonitoringService | null
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    jwtSecret: Uint8Array
    store: Store
    vapidPublicKey: string
    pushService: PushService
    socketEngine: SocketEngine
    corsOrigins?: string[]
    relayMode?: boolean
    officialWebUrl?: string
    getLocalServices?: () => LocalServiceManager | null
    getLocalServiceHandler?: () => LocalServiceHandler | null
}): Promise<BunServer<WebSocketData>> {
    const isCompiled = isBunCompiled()
    const embeddedAssetMap = isCompiled ? await loadEmbeddedAssetMap() : null
    const app = createWebApp({
        getMonitoring: options.getMonitoring,
        getSyncEngine: options.getSyncEngine,
        getSseManager: options.getSseManager,
        getVisibilityTracker: options.getVisibilityTracker,
        jwtSecret: options.jwtSecret,
        store: options.store,
        vapidPublicKey: options.vapidPublicKey,
        pushService: options.pushService,
        corsOrigins: options.corsOrigins,
        embeddedAssetMap,
        relayMode: options.relayMode,
        officialWebUrl: options.officialWebUrl,
        getLocalServices: options.getLocalServices
    })

    const configuration = getConfiguration()
    const socketHandler = options.socketEngine.handler()

    // Wrap socket.io websocket handler to also support Gemini/Qwen proxy connections
    const originalWsHandler = socketHandler.websocket
    const geminiProxyHandler = createGeminiProxyWebSocketHandler()
    const qwenProxyHandler = createQwenProxyWebSocketHandler()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (Bun.serve as any)({
        hostname: configuration.listenHost,
        port: configuration.listenPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        maxRequestBodySize: Math.max(socketHandler.maxRequestBodySize, 68 * 1024 * 1024),
        websocket: {
            ...originalWsHandler,
            open(ws: unknown) {
                const wsAny = ws as ServerWebSocket<{ _qwenProxy?: boolean; _geminiProxy?: boolean }>
                if ((ws as ServerWebSocket<Partial<LocalServiceWebSocket>>).data?._localService) {
                    options.getLocalServiceHandler?.()?.websocket.open(ws as ServerWebSocket<LocalServiceWebSocket>)
                } else if (wsAny.data?._geminiProxy) {
                    geminiProxyHandler.open(wsAny)
                } else if (wsAny.data?._qwenProxy) {
                    qwenProxyHandler.open(wsAny)
                } else {
                    originalWsHandler.open?.(ws as never)
                }
            },
            message(ws: unknown, message: unknown) {
                const wsAny = ws as ServerWebSocket<{ _qwenProxy?: boolean; _geminiProxy?: boolean }>
                if ((ws as ServerWebSocket<Partial<LocalServiceWebSocket>>).data?._localService) {
                    // Enforce the preview-specific limits rather than increasing
                    // Socket.IO / voice limits on this shared listener.
                    const data = message as string | Buffer
                    if (Buffer.byteLength(data) > 8 * 1024 * 1024) {
                        (ws as ServerWebSocket<LocalServiceWebSocket>).data.lifetime.destroy()
                    } else options.getLocalServiceHandler?.()?.websocket.message(ws as ServerWebSocket<LocalServiceWebSocket>, data)
                } else if (wsAny.data?._geminiProxy) {
                    geminiProxyHandler.message(wsAny, message as string)
                } else if (wsAny.data?._qwenProxy) {
                    qwenProxyHandler.message(wsAny, message as string)
                } else {
                    originalWsHandler.message?.(ws as never, message as never)
                }
            },
            close(ws: unknown, code: number, reason: string) {
                const wsAny = ws as ServerWebSocket<{ _qwenProxy?: boolean; _geminiProxy?: boolean }>
                if ((ws as ServerWebSocket<Partial<LocalServiceWebSocket>>).data?._localService) {
                    options.getLocalServiceHandler?.()?.websocket.close(ws as ServerWebSocket<LocalServiceWebSocket>)
                } else if (wsAny.data?._geminiProxy) {
                    geminiProxyHandler.close(wsAny, code, reason)
                } else if (wsAny.data?._qwenProxy) {
                    qwenProxyHandler.close(wsAny, code, reason)
                } else {
                    originalWsHandler.close?.(ws as never, code as never, reason as never)
                }
            }
        },
        fetch: async (req: Request, server: BunServer<LocalServiceWebSocket>) => {
            const url = new URL(req.url)
            // Before the app logger, API middleware and SPA/static fallback:
            // preview paths must neither enter the asset cache nor be logged.
            if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
                const handler = options.getLocalServiceHandler?.()
                if (handler) return handler.fetch(req, server)
                return new Response('Local service path access is not enabled / 未启用本地服务路径访问。', {
                    status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
                })
            }
            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, server as never)
            }

            // Voice WebSocket proxies — require JWT auth via query param
            // (browser WebSocket API cannot set custom headers)
            if (url.pathname === '/api/voice/gemini-ws' || url.pathname === '/api/voice/qwen-ws') {
                const token = url.searchParams.get('token')
                if (!token) {
                    return new Response('Missing authorization token', { status: 401 })
                }
                try {
                    await jwtVerify(token, options.jwtSecret, { algorithms: ['HS256'] })
                } catch {
                    return new Response('Invalid token', { status: 401 })
                }
            }

            // Gemini Live WebSocket proxy
            if (url.pathname === '/api/voice/gemini-ws') {
                const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
                if (!apiKey) {
                    return new Response('Gemini API key not configured', { status: 400 })
                }
                const language = url.searchParams.get('language') ?? undefined
                const voiceParam = url.searchParams.get('voice')?.trim() || undefined
                const systemInstruction = decodeVoiceSystemPromptParam(url.searchParams.get('systemPrompt'))
                const affectiveDialog = url.searchParams.get('affectiveDialog') === '1'
                const upgraded = (server as unknown as { upgrade: (req: Request, opts: unknown) => boolean }).upgrade(req, {
                    data: { _geminiProxy: true, apiKey, language, voiceName: voiceParam, systemInstruction, affectiveDialog }
                })
                if (!upgraded) {
                    return new Response('WebSocket upgrade failed', { status: 500 })
                }
                return undefined as unknown as Response
            }
            // Qwen Realtime WebSocket proxy
            if (url.pathname === '/api/voice/qwen-ws') {
                const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
                const model = QWEN_REALTIME_MODEL
                const language = url.searchParams.get('language') ?? undefined
                const voiceParam = url.searchParams.get('voice')?.trim() || undefined
                const systemInstruction = decodeVoiceSystemPromptParam(url.searchParams.get('systemPrompt'))
                if (!apiKey) {
                    return new Response('DashScope API key not configured', { status: 400 })
                }
                const upgraded = (server as unknown as { upgrade: (req: Request, opts: unknown) => boolean }).upgrade(req, {
                    data: { _qwenProxy: true, apiKey, model, language, voiceName: voiceParam, systemInstruction }
                })
                if (!upgraded) {
                    return new Response('WebSocket upgrade failed', { status: 500 })
                }
                return undefined as unknown as Response
            }

            return app.fetch(req)
        }
    })

    console.log(`[Web] hub listening on ${configuration.listenHost}:${configuration.listenPort}`)
    console.log(`[Web] public URL: ${configuration.publicUrl}`)

    return server
}
