import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
    CodexSshSessionOwnershipProbe,
    loadCodexSshHeldSessionIds,
    parseCodexSshLoadedThreadIds
} from './codexSshOwnership'
import { CODEX_SSH_IGNORE_REQUEST, CodexSshAppServerClient } from './codexSshAppServerClient'
import type { NativeCodexAppServerClient } from './nativeSessionDirectSend'

const temporaryDirectories: string[] = []
const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true })
    }
})

function makeSocketPath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'hapi-codex-ssh-ownership-'))
    temporaryDirectories.push(directory)
    return join(directory, 'control.sock')
}

function encodeServerTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8')
    let header: Buffer
    if (payload.length <= 125) {
        header = Buffer.from([0x81, payload.length])
    } else if (payload.length <= 0xffff) {
        header = Buffer.allocUnsafe(4)
        header[0] = 0x81
        header[1] = 126
        header.writeUInt16BE(payload.length, 2)
    } else {
        header = Buffer.allocUnsafe(10)
        header[0] = 0x81
        header[1] = 127
        header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    return Buffer.concat([header, payload])
}

function parseMaskedClientTextFrame(buffer: Buffer): { consumed: number; text: string } | null {
    if (buffer.length < 2) return null
    const first = buffer[0]!
    const second = buffer[1]!
    if (first !== 0x81 || (second & 0x80) === 0) {
        throw new Error('Expected a masked final text WebSocket frame')
    }

    let payloadLength = second & 0x7f
    let offset = 2
    if (payloadLength === 126) {
        if (buffer.length < offset + 2) return null
        payloadLength = buffer.readUInt16BE(offset)
        offset += 2
    } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) return null
        const declared = buffer.readBigUInt64BE(offset)
        if (declared > 1024n * 1024n) throw new Error('Unexpected large frame')
        payloadLength = Number(declared)
        offset += 8
    }
    if (buffer.length < offset + 4 + payloadLength) return null

    const mask = buffer.subarray(offset, offset + 4)
    offset += 4
    const payload = Buffer.allocUnsafe(payloadLength)
    for (let index = 0; index < payloadLength; index += 1) {
        payload[index] = buffer[offset + index]! ^ mask[index % mask.length]!
    }
    return {
        consumed: offset + payloadLength,
        text: payload.toString('utf8')
    }
}

function createRawWebSocketServer(
    onText: (text: string, sendText: (text: string) => void) => void,
    onConnection?: () => void
): Server {
    return createServer((socket: Socket) => {
        onConnection?.()
        let upgraded = false
        let received = Buffer.alloc(0)
        const consume = () => {
            if (!upgraded) {
                const headerEnd = received.indexOf('\r\n\r\n')
                if (headerEnd < 0) return
                const headers = received.subarray(0, headerEnd + 4).toString('latin1')
                const key = headers.split('\r\n')
                    .map((line) => line.match(/^sec-websocket-key:\s*(.+)$/i)?.[1]?.trim())
                    .find((value): value is string => Boolean(value))
                if (!key) {
                    socket.destroy()
                    return
                }
                const accept = createHash('sha1').update(key + WEBSOCKET_ACCEPT_GUID).digest('base64')
                socket.write([
                    'HTTP/1.1 101 Switching Protocols',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    'Sec-WebSocket-Accept: ' + accept,
                    '',
                    ''
                ].join('\r\n'))
                received = received.subarray(headerEnd + 4)
                upgraded = true
            }

            while (upgraded && received.length > 0) {
                const frame = parseMaskedClientTextFrame(received)
                if (!frame) return
                received = received.subarray(frame.consumed)
                onText(frame.text, (text) => socket.write(encodeServerTextFrame(text)))
            }
        }

        socket.on('data', (chunk: Buffer) => {
            received = Buffer.concat([received, chunk])
            try {
                consume()
            } catch {
                socket.destroy()
            }
        })
        socket.on('error', () => {})
    })
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
            server.off('error', reject)
            resolve()
        })
    })
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
    })
}

async function runBunProbe(scriptPath: string, socketPath: string): Promise<{
    exitCode: number | null
    stderr: string
    stdout: string
}> {
    const executable = process.env.BUN_INSTALL
        ? join(process.env.BUN_INSTALL, 'bin', 'bun')
        : 'bun'
    return await new Promise((resolve, reject) => {
        const child = spawn(executable, [scriptPath, socketPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => { stdout += chunk })
        child.stderr.on('data', (chunk: string) => { stderr += chunk })
        child.once('error', reject)
        child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
    })
}

function respondToOwnershipProbe(
    received: Array<{ id?: number; method?: string }>,
    text: string,
    sendText: (text: string) => void,
    ids = ['desktop-thread-a', 'desktop-thread-b']
): void {
    const message = JSON.parse(text) as { id?: number; method?: string }
    received.push(message)
    if (message.id === 1) {
        sendText(JSON.stringify({ id: 1, result: {} }))
    } else if (message.id === 2 && message.method === 'thread/loaded/list') {
        sendText(JSON.stringify({ id: 2, result: { data: ids, nextCursor: null } }))
    }
}

describe('CodexSshSessionOwnershipProbe', () => {
    it('parses only valid loaded native thread ids', () => {
        expect([...parseCodexSshLoadedThreadIds({
            data: [' thread-a ', '', 42, 'thread-b', 'thread-a']
        })]).toEqual(['thread-a', 'thread-b'])
        expect([...parseCodexSshLoadedThreadIds({ data: 'not-an-array' })]).toEqual([])
    })

    it.runIf(process.platform !== 'win32')('uses raw WebSocket frames over a Unix socket and never resumes a thread while probing', async () => {
        const socketPath = makeSocketPath()
        const received: Array<{ id?: number; method?: string }> = []
        const server = createRawWebSocketServer((text, sendText) => {
            respondToOwnershipProbe(received, text, sendText)
        })
        await listenOnSocket(server, socketPath)

        try {
            await expect(loadCodexSshHeldSessionIds({ socketPath, timeoutMs: 1_000 })).resolves.toEqual(
                new Set(['desktop-thread-a', 'desktop-thread-b'])
            )
            expect(received).toEqual([
                expect.objectContaining({ id: 1, method: 'initialize' }),
                expect.objectContaining({ method: 'initialized' }),
                expect.objectContaining({ id: 2, method: 'thread/loaded/list' })
            ])
            expect(received.some((message) => message.method === 'thread/resume')).toBe(false)
        } finally {
            await closeServer(server)
        }
    })

    it.runIf(process.platform !== 'win32')('probes the Unix socket successfully from a real Bun child process', async () => {
        const socketPath = makeSocketPath()
        const received: Array<{ id?: number; method?: string }> = []
        const server = createRawWebSocketServer((text, sendText) => {
            respondToOwnershipProbe(received, text, sendText, ['bun-thread-a', 'bun-thread-b'])
        })
        const scriptDirectory = mkdtempSync(join(tmpdir(), 'hapi-codex-ssh-bun-smoke-'))
        temporaryDirectories.push(scriptDirectory)
        const scriptPath = join(scriptDirectory, 'probe.ts')
        const ownershipModuleUrl = pathToFileURL(
            fileURLToPath(new URL('./codexSshOwnership.ts', import.meta.url))
        ).href
        writeFileSync(scriptPath, [
            'import { loadCodexSshHeldSessionIds } from ' + JSON.stringify(ownershipModuleUrl),
            'const ids = await loadCodexSshHeldSessionIds({ socketPath: process.argv[2], timeoutMs: 1000 })',
            'process.stdout.write(JSON.stringify(ids === null ? null : Array.from(ids)))'
        ].join('\n'))
        await listenOnSocket(server, socketPath)

        try {
            const result = await runBunProbe(scriptPath, socketPath)
            expect(result.exitCode, result.stderr).toBe(0)
            expect(JSON.parse(result.stdout)).toEqual(['bun-thread-a', 'bun-thread-b'])
            expect(received.some((message) => message.method === 'thread/resume')).toBe(false)
        } finally {
            await closeServer(server)
        }
    })

    it('retains a recent observed owner for transient probe failure, but clears it on an explicit release', async () => {
        let now = 0
        let response: ReadonlySet<string> | null = new Set(['desktop-thread'])
        const loadHeldSessionIds = vi.fn(async () => response)
        const probe = new CodexSshSessionOwnershipProbe({
            now: () => now,
            cacheTtlMs: 5,
            failureGraceMs: 20,
            socketExists: () => true,
            getSocketPath: () => '/tmp/codex-control.sock',
            loadHeldSessionIds
        })

        await expect(probe.isHeld('desktop-thread', { forceRefresh: true })).resolves.toBe(true)
        now = 6
        response = null
        await expect(probe.isHeld('desktop-thread', { forceRefresh: true })).resolves.toBe(true)

        now = 30
        await expect(probe.isHeld('desktop-thread', { forceRefresh: true })).resolves.toBe(false)

        response = new Set(['desktop-thread'])
        now = 31
        await expect(probe.isHeld('desktop-thread', { forceRefresh: true })).resolves.toBe(true)
        response = new Set()
        now = 32
        await expect(probe.isHeld('desktop-thread', { forceRefresh: true })).resolves.toBe(false)
        expect(loadHeldSessionIds).toHaveBeenCalled()
    })

    it('does not claim a thread on Windows', async () => {
        const loadHeldSessionIds = vi.fn(async () => new Set(['desktop-thread']))
        const probe = new CodexSshSessionOwnershipProbe({
            platform: 'win32',
            socketExists: () => true,
            loadHeldSessionIds
        })

        await expect(probe.isHeld('desktop-thread', { forceRefresh: true })).resolves.toBe(false)
        expect(loadHeldSessionIds).not.toHaveBeenCalled()
    })
})

describe('CodexSshAppServerClient', () => {
    it.runIf(process.platform !== 'win32')('suppresses a late answer after another client resolves the exact request', async () => {
        const socketPath = makeSocketPath()
        const received: Array<Record<string, unknown>> = []
        let send: ((text: string) => void) | undefined
        let answer: ((value: unknown) => void) | undefined
        const server = createRawWebSocketServer((text, sendText) => {
            send = sendText
            const message = JSON.parse(text) as Record<string, unknown>
            received.push(message)
            if (message.method) sendText(JSON.stringify({ id: message.id, result: {} }))
        })
        await listenOnSocket(server, socketPath)
        const client = new CodexSshAppServerClient({ socketPath, connectTimeoutMs: 1_000 })
        const contexts: unknown[] = []
        const notifications = vi.fn()
        client.setNotificationHandler(notifications)
        client.registerRequestHandler('item/tool/requestUserInput', (_params, context) => {
            contexts.push(context)
            return new Promise(resolve => { answer = resolve })
        })
        try {
            await client.connect()
            await client.initialize({ clientInfo: { name: 'test', version: '1' }, capabilities: { experimentalApi: true } })
            send!(JSON.stringify({ id: 'rpc-1', method: 'item/tool/requestUserInput', params: { threadId: 'thread-a', itemId: 'item-1' } }))
            await vi.waitFor(() => expect(contexts).toEqual([{ requestId: 'rpc-1' }]))
            send!(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 'rpc-1' } }))
            await vi.waitFor(() => expect(notifications).toHaveBeenCalled())
            answer!({ answers: { choice: { answers: ['Yes'] } } })
            await client.request('thread/loaded/list')
            expect(received.filter(message => message.id === 'rpc-1')).toEqual([])
        } finally { await client.disconnect(); await closeServer(server) }
    })
    it.runIf(process.platform !== 'win32')('explicitly ignores desktop questions or approvals while observing a shared connection', async () => {
        const socketPath = makeSocketPath()
        const received: Array<Record<string, unknown>> = []
        const server = createRawWebSocketServer((text, sendText) => {
            const message = JSON.parse(text) as Record<string, unknown>
            received.push(message)
            if (message.method === 'initialize') {
                for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/commandExecution/requestApproval']) {
                    sendText(JSON.stringify({ id: `desktop:${method}`, method, params: { threadId: 'desktop-thread' } }))
                }
                sendText(JSON.stringify({ id: message.id, result: {} }))
            } else if (message.method === 'thread/loaded/list') {
                sendText(JSON.stringify({ id: message.id, result: { data: ['desktop-thread'] } }))
            }
        })
        await listenOnSocket(server, socketPath)
        const client = new CodexSshAppServerClient({ socketPath, connectTimeoutMs: 1_000 })
        for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/commandExecution/requestApproval']) {
            client.registerRequestHandler(method, () => CODEX_SSH_IGNORE_REQUEST)
        }
        try {
            await client.connect()
            await client.initialize({ clientInfo: { name: 'hapi-observer-test', version: '1' }, capabilities: { experimentalApi: true } })
            await expect(client.request('thread/loaded/list')).resolves.toEqual({ data: ['desktop-thread'] })
            expect(received.filter((message) => String(message.id).startsWith('desktop:'))).toEqual([])
        } finally {
            await client.disconnect()
            await closeServer(server)
        }
    })

    it.runIf(process.platform !== 'win32')('uses the existing app-server connection for resume, turn notifications, and server requests', async () => {
        const socketPath = makeSocketPath()
        const received: Array<Record<string, unknown>> = []
        let receiveServerRequestResponse: ((value: Record<string, unknown>) => void) | null = null
        const serverRequestResponse = new Promise<Record<string, unknown>>((resolve) => {
            receiveServerRequestResponse = resolve
        })
        const server = createRawWebSocketServer((text, sendText) => {
            const message = JSON.parse(text) as Record<string, unknown>
            received.push(message)
            if (message.id === 1 && message.method === 'initialize') {
                sendText(JSON.stringify({ id: 1, result: { userAgent: 'codex-ssh' } }))
                return
            }
            if (message.id === 2 && message.method === 'thread/resume') {
                sendText(JSON.stringify({ id: 2, result: { thread: { id: 'thread-a' }, model: 'gpt-5.6' } }))
                return
            }
            if (message.id === 3 && message.method === 'turn/start') {
                sendText(JSON.stringify({ id: 3, result: { turn: { id: 'turn-a', status: 'inProgress' } } }))
                sendText(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } }))
                sendText(JSON.stringify({
                    id: 'input-a',
                    method: 'item/tool/requestUserInput',
                    params: { threadId: 'thread-a', itemId: 'item-a' }
                }))
                sendText(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } } }))
                return
            }
            if (message.id === 'input-a') receiveServerRequestResponse?.(message)
        })
        await listenOnSocket(server, socketPath)

        try {
            const client = new CodexSshAppServerClient({ socketPath, connectTimeoutMs: 1_000 })
            const nativeClient: NativeCodexAppServerClient = client
            const notifications: Array<{ method: string; params: unknown }> = []
            client.setNotificationHandler((method, params) => notifications.push({ method, params }))
            client.registerRequestHandler('item/tool/requestUserInput', () => ({ decision: 'cancel' }))

            await nativeClient.connect()
            await nativeClient.initialize({
                clientInfo: { name: 'hapi-test', version: '1.0.0' },
                capabilities: { experimentalApi: true }
            })
            await expect(nativeClient.resumeThread({ threadId: 'thread-a' })).resolves.toMatchObject({
                thread: { id: 'thread-a' }
            })
            await expect(nativeClient.startTurn({
                threadId: 'thread-a',
                input: [{ type: 'text', text: 'Hello from SHAPI' }]
            })).resolves.toMatchObject({ turn: { id: 'turn-a' } })
            await expect(serverRequestResponse).resolves.toEqual({ id: 'input-a', result: { decision: 'cancel' } })
            expect(notifications).toEqual([
                { method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } },
                { method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } } }
            ])
            expect(received).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 1, method: 'initialize' }),
                expect.objectContaining({ method: 'initialized' }),
                expect.objectContaining({ id: 2, method: 'thread/resume' }),
                expect.objectContaining({ id: 3, method: 'turn/start' })
            ]))
            await nativeClient.disconnect()
        } finally {
            await closeServer(server)
        }
    })

    it.runIf(process.platform !== 'win32')('disconnects only its own socket so the SSH app-server accepts a later connection', async () => {
        const socketPath = makeSocketPath()
        let connections = 0
        const server = createRawWebSocketServer((text, sendText) => {
            const message = JSON.parse(text) as { id?: number; method?: string }
            if (message.id === 1 && message.method === 'initialize') {
                sendText(JSON.stringify({ id: 1, result: {} }))
            }
        }, () => { connections += 1 })
        await listenOnSocket(server, socketPath)

        try {
            const first = new CodexSshAppServerClient({ socketPath, connectTimeoutMs: 1_000 })
            await first.connect()
            await first.initialize({
                clientInfo: { name: 'hapi-test', version: '1.0.0' },
                capabilities: { experimentalApi: true }
            })
            await first.disconnect()

            const second = new CodexSshAppServerClient({ socketPath, connectTimeoutMs: 1_000 })
            await second.connect()
            await second.initialize({
                clientInfo: { name: 'hapi-test', version: '1.0.0' },
                capabilities: { experimentalApi: true }
            })
            expect(connections).toBe(2)
            await second.disconnect()
        } finally {
            await closeServer(server)
        }
    })
})
