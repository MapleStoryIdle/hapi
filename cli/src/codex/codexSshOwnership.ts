import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { getCodexHomePath } from './codexHome'

const DEFAULT_CACHE_TTL_MS = 1_000
const DEFAULT_FAILURE_GRACE_MS = 3_000
const DEFAULT_TIMEOUT_MS = 750
const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HTTP_UPGRADE_BYTES = 16 * 1024
const MAX_WEBSOCKET_MESSAGE_BYTES = 1024 * 1024

export type CodexSshOwnershipProbeOptions = {
    /** Windows Desktop SSH does not expose this Unix-domain control endpoint. */
    platform?: NodeJS.Platform
    now?: () => number
    cacheTtlMs?: number
    failureGraceMs?: number
    timeoutMs?: number
    getSocketPath?: () => string
    socketExists?: (path: string) => boolean
    /** Test seam; `null` means the optional endpoint could not be read. */
    loadHeldSessionIds?: (input: { socketPath: string; timeoutMs: number }) => Promise<ReadonlySet<string> | null>
}

type OwnershipCache = {
    heldSessionIds: ReadonlySet<string>
    expiresAt: number
}

type LastSuccessfulOwnershipRead = {
    heldSessionIds: ReadonlySet<string>
    checkedAt: number
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

function emptySet(): ReadonlySet<string> {
    return new Set<string>()
}

function normalizeSessionIds(sessionIds: ReadonlySet<string>): ReadonlySet<string> {
    const normalized = new Set<string>()
    for (const sessionId of sessionIds) {
        const id = typeof sessionId === 'string' ? sessionId.trim() : ''
        if (id && id.length <= 512) normalized.add(id)
    }
    return normalized
}

export function getCodexSshControlSocketPath(): string {
    return join(getCodexHomePath(), 'app-server-control', 'app-server-control.sock')
}

/**
 * `thread/loaded/list` is intentionally the only Desktop SSH RPC used here.
 * Its result contains thread ids but no transcript body or control handle.
 */
export function parseCodexSshLoadedThreadIds(value: unknown): ReadonlySet<string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySet()
    const data = (value as { data?: unknown }).data
    if (!Array.isArray(data)) return emptySet()

    const ids = new Set<string>()
    for (const candidate of data) {
        if (typeof candidate !== 'string') continue
        const id = candidate.trim()
        if (id && id.length <= 512) ids.add(id)
    }
    return ids
}

function isLoadedThreadListResult(value: unknown): value is { data: unknown[] } {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { data?: unknown }).data))
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
 * Reads the optional Desktop SSH app-server without starting it. Bun's built-in
 * WebSocket compatibility layer does not honor Unix sockets, so this keeps the
 * bounded RFC6455 upgrade/frame path on raw net.
 */
export async function loadCodexSshHeldSessionIds(input: {
    socketPath: string
    timeoutMs?: number
}): Promise<ReadonlySet<string> | null> {
    const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    return await new Promise<ReadonlySet<string> | null>((resolve) => {
        let socket: Socket | null = null
        let settled = false
        let upgraded = false
        let received = Buffer.alloc(0)
        let fragmentedOpcode: number | null = null
        let fragments: Buffer[] = []
        let fragmentedLength = 0
        let initialized = false
        const websocketKey = randomBytes(16).toString('base64')
        const timeout = setTimeout(() => finish(null), timeoutMs)
        timeout.unref?.()

        const finish = (result: ReadonlySet<string> | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (socket && !socket.destroyed) socket.destroy()
            resolve(result)
        }

        const sendFrame = (opcode: number, payload: Buffer): boolean => {
            if (!socket || socket.destroyed || !socket.writable) {
                finish(null)
                return false
            }
            try {
                socket.write(encodeClientWebSocketFrame(opcode, payload))
                return true
            } catch {
                finish(null)
                return false
            }
        }

        const sendJson = (payload: unknown): boolean => {
            try {
                return sendFrame(0x01, Buffer.from(JSON.stringify(payload), 'utf8'))
            } catch {
                finish(null)
                return false
            }
        }

        const handleJsonText = (payload: Buffer) => {
            let message: { id?: unknown; result?: unknown; error?: unknown }
            try {
                const parsed: unknown = JSON.parse(payload.toString('utf8'))
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
                message = parsed as { id?: unknown; result?: unknown; error?: unknown }
            } catch {
                return
            }

            if (message.id === 1) {
                if (initialized || message.error !== undefined) {
                    finish(null)
                    return
                }
                initialized = true
                if (!sendJson({ method: 'initialized' })) return
                sendJson({ id: 2, method: 'thread/loaded/list', params: {} })
                return
            }

            if (message.id === 2) {
                finish(message.error === undefined && isLoadedThreadListResult(message.result)
                    ? parseCodexSshLoadedThreadIds(message.result)
                    : null)
            }
        }

        const appendFragment = (payload: Buffer): boolean => {
            fragmentedLength += payload.length
            if (fragmentedLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
                finish(null)
                return false
            }
            fragments.push(payload)
            return true
        }

        const handleFrame = (frame: ParsedWebSocketFrame) => {
            if (settled) return
            if (frame.opcode === 0x00) {
                if (fragmentedOpcode === null || !appendFragment(frame.payload)) {
                    if (!settled) finish(null)
                    return
                }
                if (!frame.final) return
                const opcode = fragmentedOpcode
                const payload = Buffer.concat(fragments, fragmentedLength)
                fragmentedOpcode = null
                fragments = []
                fragmentedLength = 0
                if (opcode === 0x01) handleJsonText(payload)
                else finish(null)
                return
            }

            if (frame.opcode === 0x01 || frame.opcode === 0x02) {
                if (fragmentedOpcode !== null) {
                    finish(null)
                    return
                }
                if (frame.final) {
                    if (frame.opcode === 0x01) handleJsonText(frame.payload)
                    else finish(null)
                    return
                }
                fragmentedOpcode = frame.opcode
                appendFragment(frame.payload)
                return
            }

            if (frame.opcode === 0x08) {
                finish(null)
                return
            }
            if (frame.opcode === 0x09) {
                sendFrame(0x0a, frame.payload)
                return
            }
            if (frame.opcode === 0x0a) return
            finish(null)
        }

        const consumeFrames = () => {
            while (!settled) {
                let parsed: ParsedWebSocketFrameResult | null
                try {
                    parsed = parseServerWebSocketFrame(received)
                } catch {
                    finish(null)
                    return
                }
                if (!parsed) return
                received = received.subarray(parsed.consumed)
                handleFrame(parsed.frame)
            }
        }

        const consumeIncoming = (chunk: Buffer | Uint8Array) => {
            if (settled) return
            received = Buffer.concat([received, Buffer.from(chunk)])
            if (!upgraded) {
                const upgradeEnd = received.indexOf('\r\n\r\n')
                if (upgradeEnd < 0) {
                    if (received.length > MAX_HTTP_UPGRADE_BYTES) finish(null)
                    return
                }
                if (upgradeEnd + 4 > MAX_HTTP_UPGRADE_BYTES) {
                    finish(null)
                    return
                }
                const headers = received.subarray(0, upgradeEnd + 4)
                if (!isValidWebSocketUpgrade(headers, websocketKey)) {
                    finish(null)
                    return
                }
                upgraded = true
                received = received.subarray(upgradeEnd + 4)
                if (!sendJson({
                    id: 1,
                    method: 'initialize',
                    params: {
                        clientInfo: { name: 'hapi-ssh-ownership-probe', version: '1.0.0' },
                        capabilities: { experimentalApi: true }
                    }
                })) {
                    return
                }
            }
            consumeFrames()
        }

        try {
            socket = createConnection(input.socketPath)
        } catch {
            finish(null)
            return
        }
        socket.once('error', () => finish(null))
        socket.once('close', () => finish(null))
        socket.on('data', consumeIncoming)
        socket.once('connect', () => {
            try {
                socket?.write(createWebSocketUpgradeRequest(websocketKey))
            } catch {
                finish(null)
            }
        })
    })
}

/**
 * Short-lived ownership cache. A missing optional endpoint releases a stale
 * lock; a transient failed read preserves the most recently observed lock for
 * a bounded grace period so an SSH-controlled thread is never spuriously
 * re-enabled during a local socket hiccup.
 */
export class CodexSshSessionOwnershipProbe {
    private readonly platform: NodeJS.Platform
    private readonly now: () => number
    private readonly cacheTtlMs: number
    private readonly failureGraceMs: number
    private readonly timeoutMs: number
    private readonly getSocketPath: () => string
    private readonly socketExists: (path: string) => boolean
    private readonly loadHeldSessionIds: (input: { socketPath: string; timeoutMs: number }) => Promise<ReadonlySet<string> | null>
    private cache: OwnershipCache | null = null
    private lastSuccessfulRead: LastSuccessfulOwnershipRead | null = null
    private inFlight: Promise<ReadonlySet<string>> | null = null

    constructor(options: CodexSshOwnershipProbeOptions = {}) {
        this.platform = options.platform ?? process.platform
        this.now = options.now ?? Date.now
        this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)
        this.failureGraceMs = Math.max(0, options.failureGraceMs ?? Math.max(DEFAULT_FAILURE_GRACE_MS, this.cacheTtlMs * 3))
        this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        this.getSocketPath = options.getSocketPath ?? getCodexSshControlSocketPath
        this.socketExists = options.socketExists ?? existsSync
        this.loadHeldSessionIds = options.loadHeldSessionIds ?? loadCodexSshHeldSessionIds
    }

    getCachedHeldSessionIds(): ReadonlySet<string> {
        return new Set(this.cache?.heldSessionIds ?? [])
    }

    async isHeld(sessionId: string, options: { forceRefresh?: boolean } = {}): Promise<boolean> {
        const id = sessionId.trim()
        if (!id) return false
        return (await this.getHeldSessionIds(options)).has(id)
    }

    async getHeldSessionIds(options: { forceRefresh?: boolean } = {}): Promise<ReadonlySet<string>> {
        const now = this.now()
        if (!options.forceRefresh && this.cache && this.cache.expiresAt > now) {
            return new Set(this.cache.heldSessionIds)
        }
        if (this.inFlight) return await this.inFlight

        const request = this.refresh()
        this.inFlight = request
        try {
            return await request
        } finally {
            if (this.inFlight === request) this.inFlight = null
        }
    }

    private setCache(heldSessionIds: ReadonlySet<string>): ReadonlySet<string> {
        const normalized = normalizeSessionIds(heldSessionIds)
        this.cache = {
            heldSessionIds: normalized,
            expiresAt: this.now() + this.cacheTtlMs
        }
        return new Set(normalized)
    }

    private async refresh(): Promise<ReadonlySet<string>> {
        let result: ReadonlySet<string> | null = null
        let definitive = false

        if (this.platform === 'win32') {
            result = emptySet()
            definitive = true
        } else {
            try {
                const socketPath = this.getSocketPath()
                if (!socketPath || !this.socketExists(socketPath)) {
                    // Absence is a real release signal, unlike a failed read.
                    result = emptySet()
                    definitive = true
                } else {
                    result = await this.loadHeldSessionIds({ socketPath, timeoutMs: this.timeoutMs })
                    definitive = result !== null
                }
            } catch {
                // The optional endpoint is versioned separately. Preserve a
                // recent known lock rather than falsely re-enabling a session.
            }
        }

        if (definitive && result !== null) {
            const normalized = normalizeSessionIds(result)
            this.lastSuccessfulRead = {
                heldSessionIds: normalized,
                checkedAt: this.now()
            }
            return this.setCache(normalized)
        }

        const now = this.now()
        const preserved = this.lastSuccessfulRead
            && now - this.lastSuccessfulRead.checkedAt <= this.failureGraceMs
            ? this.lastSuccessfulRead.heldSessionIds
            : emptySet()
        return this.setCache(preserved)
    }
}
