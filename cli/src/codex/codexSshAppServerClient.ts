import { createHash, randomBytes } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import type {
    InitializeParams,
    InitializeResponse,
    ThreadResumeParams,
    ThreadResumeResponse,
    TurnInterruptParams,
    TurnInterruptResponse,
    TurnStartParams,
    TurnStartResponse
} from './appServerTypes'

const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HTTP_UPGRADE_BYTES = 16 * 1024
const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

type JsonRpcRequest = {
    id: number
    method: string
    params?: unknown
}

type JsonRpcNotification = {
    method: string
    params?: unknown
}

type JsonRpcError = {
    code?: number
    message?: string
    data?: unknown
}

type JsonRpcResponse = {
    id: number | string | null
    result?: unknown
    error?: JsonRpcError
}

type RequestHandler = (params: unknown) => Promise<unknown> | unknown

type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    cleanup: () => void
}

type ParsedWebSocketFrame = {
    final: boolean
    opcode: number
    payload: Buffer
}

type ParsedWebSocketFrameResult = {
    frame: ParsedWebSocketFrame
    consumed: number
}

export type CodexSshAppServerClientOptions = {
    socketPath: string
    connectTimeoutMs?: number
    requestTimeoutMs?: number
}

export type CodexSshAppServerRequestOptions = {
    signal?: AbortSignal
    timeoutMs?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function createAbortError(): Error {
    const error = new Error('Request aborted')
    error.name = 'AbortError'
    return error
}

function normalizeError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback)
}

function encodeClientWebSocketFrame(opcode: number, payload: Buffer): Buffer {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0x0f || payload.length > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new Error('Invalid WebSocket frame')
    }

    const mask = randomBytes(4)
    let header: Buffer
    if (payload.length <= 125) {
        header = Buffer.allocUnsafe(2)
        header[1] = 0x80 | payload.length
    } else if (payload.length <= 0xffff) {
        header = Buffer.allocUnsafe(4)
        header[1] = 0x80 | 126
        header.writeUInt16BE(payload.length, 2)
    } else {
        header = Buffer.allocUnsafe(10)
        header[1] = 0x80 | 127
        header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    header[0] = 0x80 | opcode

    const maskedPayload = Buffer.allocUnsafe(payload.length)
    for (let index = 0; index < payload.length; index += 1) {
        maskedPayload[index] = payload[index]! ^ mask[index % mask.length]!
    }
    return Buffer.concat([header, mask, maskedPayload])
}

function parseServerWebSocketFrame(buffer: Buffer): ParsedWebSocketFrameResult | null {
    if (buffer.length < 2) return null

    const first = buffer[0]!
    const second = buffer[1]!
    if ((first & 0x70) !== 0) {
        throw new Error('Unsupported WebSocket extension')
    }

    const final = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let payloadLength = second & 0x7f
    let offset = 2

    if (payloadLength === 126) {
        if (buffer.length < offset + 2) return null
        payloadLength = buffer.readUInt16BE(offset)
        offset += 2
    } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return null
        const declaredLength = buffer.readBigUInt64BE(offset)
        if (declaredLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
            throw new Error('WebSocket message is too large')
        }
        payloadLength = Number(declaredLength)
        offset += 8
    }

    if (payloadLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new Error('WebSocket message is too large')
    }
    if (opcode >= 0x08 && (!final || payloadLength > 125)) {
        throw new Error('Invalid WebSocket control frame')
    }

    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + payloadLength) return null
    const mask = masked ? buffer.subarray(offset, offset + 4) : null
    offset += maskLength
    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength))
    if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = payload[index]! ^ mask[index % mask.length]!
        }
    }

    return {
        frame: { final, opcode, payload },
        consumed: offset + payloadLength
    }
}

function createWebSocketUpgradeRequest(key: string): Buffer {
    return Buffer.from([
        'GET / HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        '',
        ''
    ].join('\r\n'), 'utf8')
}

function hasHttpToken(value: string | undefined, expected: string): boolean {
    return value?.split(',').some((token) => token.trim().toLowerCase() === expected) ?? false
}

function isValidWebSocketUpgrade(headers: Buffer, key: string): boolean {
    const lines = headers.toString('latin1').split('\r\n')
    if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines[0] ?? '')) return false

    const responseHeaders = new Map<string, string>()
    for (const line of lines.slice(1)) {
        const separator = line.indexOf(':')
        if (separator < 1) continue
        const name = line.slice(0, separator).trim().toLowerCase()
        const value = line.slice(separator + 1).trim()
        const previous = responseHeaders.get(name)
        responseHeaders.set(name, previous ? previous + ',' + value : value)
    }

    const expectedAccept = createHash('sha1')
        .update(key + WEBSOCKET_ACCEPT_GUID)
        .digest('base64')
    return hasHttpToken(responseHeaders.get('upgrade'), 'websocket')
        && hasHttpToken(responseHeaders.get('connection'), 'upgrade')
        && responseHeaders.get('sec-websocket-accept') === expectedAccept
}

/**
 * Transient client for the Unix-domain WebSocket exposed by Codex Desktop SSH.
 * It owns only this one connection: `disconnect` never signals, stops, or
 * otherwise changes the existing app-server daemon.
 */
export class CodexSshAppServerClient {
    private readonly socketPath: string
    private readonly connectTimeoutMs: number
    private readonly requestTimeoutMs: number
    private socket: Socket | null = null
    private connected = false
    private connecting: Promise<void> | null = null
    private connectResolve: (() => void) | null = null
    private connectReject: ((error: Error) => void) | null = null
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null
    private nextId = 1
    private received = Buffer.alloc(0)
    private upgraded = false
    private fragmentedOpcode: number | null = null
    private fragments: Buffer[] = []
    private fragmentedLength = 0
    private readonly pending = new Map<number, PendingRequest>()
    private readonly requestHandlers = new Map<string, RequestHandler>()
    private notificationHandler: ((method: string, params: unknown) => void) | null = null

    constructor(options: CodexSshAppServerClientOptions) {
        this.socketPath = options.socketPath
        this.connectTimeoutMs = Math.max(1, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
        this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    }

    async connect(): Promise<void> {
        if (this.connected) return
        if (this.connecting) return await this.connecting

        this.resetIncomingState()
        const websocketKey = randomBytes(16).toString('base64')
        this.websocketKey = websocketKey
        const request = new Promise<void>((resolve, reject) => {
            this.connectResolve = resolve
            this.connectReject = reject

            let socket: Socket
            try {
                socket = createConnection(this.socketPath)
            } catch (error) {
                this.failConnection(normalizeError(error, 'Failed to open Codex SSH app-server socket'))
                return
            }

            this.socket = socket
            socket.on('data', (chunk: Buffer) => this.consumeIncoming(socket, chunk))
            socket.on('error', (error) => this.failConnection(error, socket))
            socket.on('close', () => this.failConnection(new Error('Codex SSH app-server connection closed'), socket))
            socket.once('connect', () => {
                try {
                    socket.write(createWebSocketUpgradeRequest(websocketKey))
                } catch (error) {
                    this.failConnection(normalizeError(error, 'Failed to start Codex SSH WebSocket upgrade'), socket)
                }
            })
        })

        this.connecting = request
        this.connectionTimeout = setTimeout(() => {
            this.failConnection(new Error(`Timed out connecting to Codex SSH app-server after ${this.connectTimeoutMs}ms`))
        }, this.connectTimeoutMs)
        this.connectionTimeout.unref?.()

        try {
            await request
        } finally {
            if (this.connecting === request) {
                this.connecting = null
                if (!this.connected) this.clearConnectionTimeout()
            }
        }
    }

    async initialize(params: InitializeParams): Promise<InitializeResponse> {
        const response = await this.request<InitializeResponse>('initialize', params, { timeoutMs: this.requestTimeoutMs })
        this.sendNotification('initialized')
        return response
    }

    async resumeThread(params: ThreadResumeParams, options?: { signal?: AbortSignal }): Promise<ThreadResumeResponse> {
        return await this.request<ThreadResumeResponse>('thread/resume', params, {
            signal: options?.signal,
            timeoutMs: this.requestTimeoutMs
        })
    }

    async startTurn(params: TurnStartParams, options?: { signal?: AbortSignal }): Promise<TurnStartResponse> {
        return await this.request<TurnStartResponse>('turn/start', params, {
            signal: options?.signal,
            timeoutMs: this.requestTimeoutMs
        })
    }

    async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
        return await this.request<TurnInterruptResponse>('turn/interrupt', params, {
            timeoutMs: this.requestTimeoutMs
        })
    }

    async request<T = unknown>(
        method: string,
        params?: unknown,
        options: CodexSshAppServerRequestOptions = {}
    ): Promise<T> {
        if (!this.connected) await this.connect()
        if (!this.socket || this.socket.destroyed || !this.socket.writable) {
            throw new Error('Codex SSH app-server is not connected')
        }

        const id = this.nextId++
        const timeoutMs = Math.max(1, options.timeoutMs ?? this.requestTimeoutMs)
        return await new Promise<T>((resolve, reject) => {
            let timeout: ReturnType<typeof setTimeout> | null = null
            let aborted = false

            const cleanup = () => {
                if (timeout) clearTimeout(timeout)
                if (options.signal) options.signal.removeEventListener('abort', onAbort)
            }

            const onAbort = () => {
                if (aborted) return
                aborted = true
                this.pending.delete(id)
                cleanup()
                reject(createAbortError())
            }

            if (options.signal) {
                if (options.signal.aborted) {
                    onAbort()
                    return
                }
                options.signal.addEventListener('abort', onAbort, { once: true })
            }

            timeout = setTimeout(() => {
                if (!this.pending.has(id)) return
                this.pending.delete(id)
                cleanup()
                reject(new Error(`Codex SSH app-server request '${method}' timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            timeout.unref?.()

            this.pending.set(id, {
                resolve: (value) => {
                    cleanup()
                    resolve(value as T)
                },
                reject: (error) => {
                    cleanup()
                    reject(error)
                },
                cleanup
            })

            try {
                this.writePayload({ id, method, params })
            } catch (error) {
                this.pending.delete(id)
                cleanup()
                reject(normalizeError(error, `Failed to send Codex SSH app-server request '${method}'`))
            }
        })
    }

    setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
        this.notificationHandler = handler
    }

    registerRequestHandler(method: string, handler: RequestHandler): void {
        this.requestHandlers.set(method, handler)
    }

    async disconnect(): Promise<void> {
        const socket = this.socket
        if (!socket) return
        const close = socket.destroyed
            ? Promise.resolve()
            : new Promise<void>((resolve) => socket.once('close', resolve))
        this.failConnection(new Error('Codex SSH app-server client disconnected'), socket)
        await close
    }

    private websocketKey: string | null = null

    private completeConnection(socket: Socket): void {
        if (this.socket !== socket || this.connected) return
        this.connected = true
        this.clearConnectionTimeout()
        const resolve = this.connectResolve
        this.connectResolve = null
        this.connectReject = null
        resolve?.()
    }

    private failConnection(error: Error, socket?: Socket): void {
        if (socket && this.socket !== socket) return

        const activeSocket = this.socket
        this.socket = null
        this.connected = false
        this.clearConnectionTimeout()
        this.resetIncomingState()

        const reject = this.connectReject
        this.connectResolve = null
        this.connectReject = null
        reject?.(error)
        this.rejectAllPending(error)

        if (activeSocket && !activeSocket.destroyed) activeSocket.destroy()
    }

    private clearConnectionTimeout(): void {
        if (!this.connectionTimeout) return
        clearTimeout(this.connectionTimeout)
        this.connectionTimeout = null
    }

    private consumeIncoming(socket: Socket, chunk: Buffer | Uint8Array): void {
        if (this.socket !== socket) return
        this.received = Buffer.concat([this.received, Buffer.from(chunk)])

        if (!this.upgraded) {
            const upgradeEnd = this.received.indexOf('\r\n\r\n')
            if (upgradeEnd < 0) {
                if (this.received.length > MAX_HTTP_UPGRADE_BYTES) {
                    this.failConnection(new Error('Codex SSH WebSocket upgrade response is too large'), socket)
                }
                return
            }
            if (upgradeEnd + 4 > MAX_HTTP_UPGRADE_BYTES || !this.websocketKey) {
                this.failConnection(new Error('Invalid Codex SSH WebSocket upgrade response'), socket)
                return
            }

            const headers = this.received.subarray(0, upgradeEnd + 4)
            if (!isValidWebSocketUpgrade(headers, this.websocketKey)) {
                this.failConnection(new Error('Codex SSH app-server rejected the WebSocket upgrade'), socket)
                return
            }

            this.upgraded = true
            this.received = this.received.subarray(upgradeEnd + 4)
            this.completeConnection(socket)
        }

        this.consumeFrames(socket)
    }

    private consumeFrames(socket: Socket): void {
        while (this.socket === socket) {
            let parsed: ParsedWebSocketFrameResult | null
            try {
                parsed = parseServerWebSocketFrame(this.received)
            } catch (error) {
                this.failConnection(normalizeError(error, 'Invalid Codex SSH WebSocket frame'), socket)
                return
            }
            if (!parsed) return
            this.received = this.received.subarray(parsed.consumed)
            this.handleFrame(parsed.frame, socket)
        }
    }

    private handleFrame(frame: ParsedWebSocketFrame, socket: Socket): void {
        if (frame.opcode === 0x00) {
            if (this.fragmentedOpcode === null || !this.appendFragment(frame.payload)) {
                this.failConnection(new Error('Invalid fragmented Codex SSH WebSocket message'), socket)
                return
            }
            if (!frame.final) return
            const opcode = this.fragmentedOpcode
            const payload = Buffer.concat(this.fragments, this.fragmentedLength)
            this.fragmentedOpcode = null
            this.fragments = []
            this.fragmentedLength = 0
            if (opcode === 0x01) this.handleJson(payload, socket)
            else this.failConnection(new Error('Unsupported Codex SSH WebSocket binary message'), socket)
            return
        }

        if (frame.opcode === 0x01 || frame.opcode === 0x02) {
            if (this.fragmentedOpcode !== null) {
                this.failConnection(new Error('Invalid overlapping Codex SSH WebSocket fragments'), socket)
                return
            }
            if (frame.final) {
                if (frame.opcode === 0x01) this.handleJson(frame.payload, socket)
                else this.failConnection(new Error('Unsupported Codex SSH WebSocket binary message'), socket)
                return
            }
            this.fragmentedOpcode = frame.opcode
            if (!this.appendFragment(frame.payload)) {
                this.failConnection(new Error('Codex SSH WebSocket message is too large'), socket)
            }
            return
        }

        if (frame.opcode === 0x08) {
            this.failConnection(new Error('Codex SSH app-server closed the WebSocket connection'), socket)
            return
        }
        if (frame.opcode === 0x09) {
            try {
                this.writeFrame(0x0a, frame.payload)
            } catch (error) {
                this.failConnection(normalizeError(error, 'Failed to respond to Codex SSH WebSocket ping'), socket)
            }
            return
        }
        if (frame.opcode !== 0x0a) {
            this.failConnection(new Error('Unsupported Codex SSH WebSocket frame'), socket)
        }
    }

    private appendFragment(payload: Buffer): boolean {
        this.fragmentedLength += payload.length
        if (this.fragmentedLength > MAX_WEBSOCKET_MESSAGE_BYTES) return false
        this.fragments.push(payload)
        return true
    }

    private handleJson(payload: Buffer, socket: Socket): void {
        let message: Record<string, unknown> | null
        try {
            message = asRecord(JSON.parse(payload.toString('utf8')))
        } catch (error) {
            this.failConnection(normalizeError(error, 'Invalid JSON from Codex SSH app-server'), socket)
            return
        }
        if (!message) {
            this.failConnection(new Error('Invalid JSON-RPC message from Codex SSH app-server'), socket)
            return
        }

        if (typeof message.method === 'string') {
            const params = 'params' in message ? message.params : null
            if ('id' in message && message.id !== undefined) {
                void this.handleIncomingRequest(message.id, message.method, params)
                return
            }
            this.notificationHandler?.(message.method, params)
            return
        }

        if ('id' in message) this.handleResponse(message as JsonRpcResponse)
    }

    private async handleIncomingRequest(id: unknown, method: string, params: unknown): Promise<void> {
        const responseId = typeof id === 'number' || typeof id === 'string' ? id : null
        const handler = this.requestHandlers.get(method)
        if (!handler) {
            this.tryWritePayload({
                id: responseId,
                error: { code: -32601, message: `Method not found: ${method}` }
            })
            return
        }

        try {
            const result = await handler(params)
            this.tryWritePayload({ id: responseId, result })
        } catch (error) {
            this.tryWritePayload({
                id: responseId,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : 'Internal error'
                }
            })
        }
    }

    private handleResponse(response: JsonRpcResponse): void {
        if (typeof response.id !== 'number') return
        const pending = this.pending.get(response.id)
        if (!pending) return
        this.pending.delete(response.id)

        if (response.error) {
            pending.reject(new Error(response.error.message || 'Codex SSH app-server request failed'))
            return
        }
        pending.resolve(response.result)
    }

    private sendNotification(method: string, params?: unknown): void {
        this.writePayload({ method, params })
    }

    private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
        this.writeFrame(0x01, Buffer.from(JSON.stringify(payload), 'utf8'))
    }

    /** A server request can finish after our transient socket has closed. */
    private tryWritePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
        try {
            this.writePayload(payload)
        } catch {
            // Closing this response never changes or stops the shared daemon.
        }
    }

    private writeFrame(opcode: number, payload: Buffer): void {
        const socket = this.socket
        if (!this.connected || !socket || socket.destroyed || !socket.writable) {
            throw new Error('Codex SSH app-server is not connected')
        }
        socket.write(encodeClientWebSocketFrame(opcode, payload))
    }

    private rejectAllPending(error: Error): void {
        for (const { reject, cleanup } of this.pending.values()) {
            cleanup()
            reject(error)
        }
        this.pending.clear()
    }

    private resetIncomingState(): void {
        this.received = Buffer.alloc(0)
        this.upgraded = false
        this.websocketKey = null
        this.fragmentedOpcode = null
        this.fragments = []
        this.fragmentedLength = 0
    }
}
