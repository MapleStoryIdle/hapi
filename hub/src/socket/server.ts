import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type DefaultEventsMap } from 'socket.io'
import type { Store } from '../store'
import { getConfiguration } from '../configuration'
import { registerCliHandlers } from './handlers/cli'
import { registerTerminalHandlers } from './handlers/terminal'
import { RpcRegistry } from './rpcRegistry'
import { SOCKET_MAX_HTTP_BUFFER_SIZE } from './socketLimits'
import type { SyncEvent } from '../sync/syncEngine'
import { TerminalRegistry } from './terminalRegistry'
import type { CliSocketWithData, SocketData, SocketServer } from './socketTypes'
import type { GeneratedImageStore } from '../generatedImages/store'
import type { ExternalCodexRequestPayload } from '@hapi/protocol'
import { DEVELOPMENT_WEB_SESSION_COOKIE, SECURE_WEB_SESSION_COOKIE, verifyWorkspaceJwt, WEB_SESSION_IDLE_TTL_MS } from '../web/middleware/auth'
import { getRunnerAuthService } from '../auth/runnerAuth'

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type SocketServerDeps = {
    store: Store
    jwtSecret: Uint8Array
    corsOrigins?: string[]
    getSession?: (sessionId: string) => { active: boolean; namespace: string } | null
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionReady?: (payload: { sid: string; time: number }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number; health?: unknown }) => void
    onExternalCodexRequest?: (payload: ExternalCodexRequestPayload & { namespace: string }) => void
    onBackgroundTaskDelta?: (sessionId: string, delta: { started: number; completed: number }) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onMessagesConsumed?: (sessionId: string) => void
    generatedImageStore?: GeneratedImageStore
}

export function createSocketServer(deps: SocketServerDeps): {
    io: SocketServer
    engine: Engine
    rpcRegistry: RpcRegistry
} {
    const configuration = getConfiguration()
    const runnerAuth = getRunnerAuthService(deps.store, deps.jwtSecret)
    const corsOrigins = deps.corsOrigins ?? configuration.corsOrigins
    const allowAllOrigins = corsOrigins.includes('*')
    const corsOriginOption = allowAllOrigins ? '*' : corsOrigins
    const corsOptions = {
        origin: corsOriginOption,
        methods: ['GET', 'POST'],
        credentials: false
    }

    const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>({
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE
    })

    const engine = new Engine({
        path: '/socket.io/',
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
        allowRequest: async (req) => {
            const origin = req.headers.get('origin')
            if (!origin || allowAllOrigins || corsOrigins.includes(origin)) {
                return
            }
            throw 'Origin not allowed'
        }
    })
    io.bind(engine)

    const rpcRegistry = new RpcRegistry()
    const idleTimeoutMs = resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
    const maxTerminals = resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
    const maxTerminalsPerSocket = maxTerminals
    const maxTerminalsPerSession = maxTerminals
    const cliNs = io.of('/cli')
    const terminalNs = io.of('/terminal')
    const terminalRegistry = new TerminalRegistry({
        idleTimeoutMs,
        onIdle: (entry) => {
            const terminalSocket = terminalNs.sockets.get(entry.socketId)
            terminalSocket?.emit('terminal:error', {
                terminalId: entry.terminalId,
                message: 'Terminal closed due to inactivity.'
            })
            const cliSocket = cliNs.sockets.get(entry.cliSocketId)
            cliSocket?.emit('terminal:close', {
                sessionId: entry.sessionId,
                terminalId: entry.terminalId
            })
        }
    })

    deps.store.workspaces.setAccessKeyRevokedHandler((accessKeyId) => {
        for (const socket of cliNs.sockets.values()) {
            if (socket.data.accessKeyId === accessKeyId) socket.disconnect(true)
        }
    })

    cliNs.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const ticket = typeof auth?.ticket === 'string' ? auth.ticket : null
        if (ticket) {
            const identity = runnerAuth.consumeSocketTicket(ticket)
            if (!identity) return next(new Error('Invalid socket ticket'))
            socket.data.namespace = identity.namespace
            socket.data.workspaceId = identity.workspaceId
            socket.data.accessKeyId = identity.accessKeyId
            socket.data.accessKind = 'runner'
            socket.data.boundMachineId = identity.machineId
            socket.data.authMode = 'ticket'
            next()
            return
        }
        const token = typeof auth?.token === 'string' ? auth.token : null
        const machineId = typeof auth?.machineId === 'string' ? auth.machineId : undefined
        const access = token ? deps.store.workspaces.authenticate(token, configuration.cliApiToken, 'runner', machineId) : null
        if (!access) {
            return next(new Error('Invalid token'))
        }
        if (access.kind === 'runner' && auth?.compatibility !== 'spr') {
            return next(new Error('Runner credentials require a socket ticket'))
        }
        socket.data.namespace = access.workspace.dataNamespace
        socket.data.workspaceId = access.workspace.id
        socket.data.accessKeyId = access.accessKeyId
        socket.data.accessKind = access.kind
        socket.data.boundMachineId = access.boundMachineId
        socket.data.authMode = 'compatibility'
        next()
    })
    cliNs.on('connection', (socket) => registerCliHandlers(socket as CliSocketWithData, {
        io,
        store: deps.store,
        rpcRegistry,
        terminalRegistry,
        onSessionAlive: deps.onSessionAlive,
        onSessionReady: deps.onSessionReady,
        onSessionEnd: deps.onSessionEnd,
        onMachineAlive: deps.onMachineAlive,
        onExternalCodexRequest: deps.onExternalCodexRequest,
        onWebappEvent: deps.onWebappEvent,
        onBackgroundTaskDelta: deps.onBackgroundTaskDelta,
        onSessionActivity: deps.onSessionActivity,
        onMessagesConsumed: deps.onMessagesConsumed,
        generatedImageStore: deps.generatedImageStore
    }))

    terminalNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        const cookies = new Map((socket.handshake.headers.cookie ?? '').split(';').map((part) => {
            const separator = part.indexOf('=')
            return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), part.slice(separator + 1)]
        }))
        const sessionToken = cookies.get(SECURE_WEB_SESSION_COOKIE) ?? cookies.get(DEVELOPMENT_WEB_SESSION_COOKIE)
        const session = sessionToken
            ? deps.store.workspaces.authenticateWebSession(sessionToken, WEB_SESSION_IDLE_TTL_MS)
            : null
        if (session) {
            const origin = socket.handshake.headers.origin
            const host = socket.handshake.headers.host
            try {
                const configuredOrigin = new URL(configuration.publicUrl).origin
                const sameHost = Boolean(host && new URL(origin ?? '').host === host)
                const explicitlyAllowed = Boolean(origin && origin === configuredOrigin && configuredOrigin !== 'null')
                if (!origin || (!sameHost && !explicitlyAllowed)) return next(new Error('Invalid origin'))
            } catch {
                return next(new Error('Invalid origin'))
            }
            socket.data.userId = 1
            socket.data.namespace = session.workspace.dataNamespace
            next()
            return
        }

        if (!token || token === '__cookie_session__') return next(new Error('Missing token'))

        try {
            const identity = await verifyWorkspaceJwt(token, deps.jwtSecret, deps.store)
            if (!identity) return next(new Error('Invalid token'))
            socket.data.userId = identity.userId
            socket.data.namespace = identity.namespace
            next()
            return
        } catch {
            return next(new Error('Invalid token'))
        }
    })
    terminalNs.on('connection', (socket) => registerTerminalHandlers(socket, {
        io,
        getSession: (sessionId) => {
            return deps.getSession?.(sessionId) ?? deps.store.sessions.getSession(sessionId)
        },
        terminalRegistry,
        maxTerminalsPerSocket,
        maxTerminalsPerSession
    }))

    return { io, engine, rpcRegistry }
}
