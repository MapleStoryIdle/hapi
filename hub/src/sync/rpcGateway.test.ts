import { describe, expect, it } from 'bun:test'
import type { Server } from 'socket.io'
import { MAX_UPLOAD_CHUNK_BYTES } from '@hapi/protocol'
import type { RpcRegistry } from '../socket/rpcRegistry'
import { RpcGateway, RpcTargetMissingError } from './rpcGateway'

function createGateway() {
    const timeouts: number[] = []
    const socket = {
        timeout(timeoutMs: number) {
            timeouts.push(timeoutMs)
            return {
                async emitWithAck(_event: string, payload: { method: string; params: string }) {
                    return JSON.stringify({
                        success: true,
                        method: payload.method,
                        params: JSON.parse(payload.params) as unknown
                    })
                }
            }
        }
    }

    const io = {
        of() {
            return {
                sockets: {
                    get() {
                        return socket
                    }
                }
            }
        }
    } as unknown as Server

    const rpcRegistry = {
        getSocketIdForMethod() {
            return 'socket-1'
        }
    } as unknown as RpcRegistry

    return {
        gateway: new RpcGateway(io, rpcRegistry),
        timeouts
    }
}

describe('RpcGateway RPC timeouts', () => {
    it('uses the default RPC timeout for regular machine RPCs', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listMachineDirectory('machine-1', 'C:\\workspace')

        expect(timeouts).toEqual([30_000])
    })

    it('uses an extended RPC timeout when listing Codex models', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCodexModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })

    it('uses an extended RPC timeout when listing Cursor models for a machine', async () => {
        const { gateway, timeouts } = createGateway()

        await gateway.listCursorModelsForMachine('machine-1')

        expect(timeouts).toEqual([120_000])
    })
})

// tiann/hapi#916: rpcCall throws a typed `RpcTargetMissingError` when the
// target CLI is unreachable, so syncEngine.archiveSession can narrow on it
// and treat the kill as a benign no-op.
describe('RpcGateway no-target diagnostics (tiann/hapi#916)', () => {
    it('throws RpcTargetMissingError(handler-not-registered) when no socket is registered for the method', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('handler-not-registered')
    })

    it('throws RpcTargetMissingError(socket-disconnected) when the socket id is registered but no socket exists', async () => {
        const io = {
            of() {
                return {
                    sockets: {
                        get() { return undefined }
                    }
                }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const error = await gateway.killSession('session-1').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(RpcTargetMissingError)
        expect((error as RpcTargetMissingError).code).toBe('socket-disconnected')
    })
})

describe('RpcGateway file transfer channels', () => {
    it('reads uploaded file bytes through the owning machine socket', async () => {
        const events: Array<{ event: string; payload: unknown }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(event: string, payload: unknown) {
                        events.push({ event, payload })
                        return {
                            success: true,
                            bytes: new Uint8Array([1, 2, 3]),
                            mimeType: 'image/png',
                            fileName: 'shot.png'
                        }
                    }
                }
            }
        }
        const namespace = {
            adapter: { rooms: new Map([['machine:machine-1', new Set(['socket-1'])]]) },
            sockets: { get: () => socket }
        }
        const io = { of: () => namespace } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const result = await gateway.readUploadedFileBytes('machine-1', 'session-1', '/tmp/upload/shot.png')

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(Array.from(result.bytes)).toEqual([1, 2, 3])
        expect(events).toEqual([{
            event: 'file:read-bytes',
            payload: { type: 'uploaded-file', sessionId: 'session-1', path: '/tmp/upload/shot.png' }
        }])
    })

    it('reads generated image file bytes through the machine socket', async () => {
        const events: Array<{ event: string; payload: unknown }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(event: string, payload: unknown) {
                        events.push({ event, payload })
                        return {
                            success: true,
                            bytes: new Uint8Array([7, 8, 9]),
                            mimeType: 'image/png',
                            fileName: 'generated.png'
                        }
                    }
                }
            }
        }
        const namespace = {
            adapter: { rooms: new Map([['machine:machine-1', new Set(['socket-1'])]]) },
            sockets: { get: () => socket }
        }
        const io = { of: () => namespace } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const result = await gateway.readGeneratedImageFileBytes('machine-1', {
            path: '/tmp/generated.png',
            mimeType: 'image/png',
            size: 3,
            mtimeMs: 123,
            fileName: 'generated.png'
        })

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(Array.from(result.bytes)).toEqual([7, 8, 9])
        expect(events).toEqual([{
            event: 'file:read-bytes',
            payload: {
                type: 'generated-image-file',
                path: '/tmp/generated.png',
                mimeType: 'image/png',
                size: 3,
                mtimeMs: 123,
                fileName: 'generated.png'
            }
        }])
    })

    it('reads a completed session file through its machine socket', async () => {
        const events: Array<{ event: string; payload: unknown }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(event: string, payload: unknown) {
                        events.push({ event, payload })
                        return {
                            success: true,
                            bytes: new Uint8Array([4, 5, 6]),
                            mimeType: 'text/plain',
                            fileName: 'example.txt'
                        }
                    }
                }
            }
        }
        const namespace = {
            adapter: { rooms: new Map([['machine:machine-1', new Set(['socket-1'])]]) },
            sockets: { get: () => socket }
        }
        const io = { of: () => namespace } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return undefined }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        const result = await gateway.readMachineFileBytes('machine-1', '/work/project', 'src/example.txt')

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(Array.from(result.bytes)).toEqual([4, 5, 6])
        expect(events).toEqual([{
            event: 'file:read-bytes',
            payload: {
                type: 'machine-file',
                cwd: '/work/project',
                path: 'src/example.txt'
            }
        }])
    })

    it('uploads ordered base64 chunks through machine-scoped RPC', async () => {
        const events: Array<{ event: string; payload: unknown }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(event: string, payload: unknown) {
                        events.push({ event, payload })
                        const request = payload as { method: string; params: string }
                        if (request.method.endsWith(':uploadFileFinish')) {
                            return JSON.stringify({ success: true, path: '/tmp/upload/shot.png' })
                        }
                        return JSON.stringify({ success: true })
                    }
                }
            }
        }
        const namespace = {
            sockets: { get: () => socket }
        }
        const io = { of: () => namespace } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)
        const bytes = new Uint8Array([4, 5, 6])

        const result = await gateway.uploadFileBytes('machine-1', 'session-1', 'shot.png', bytes, 'image/png')

        expect(result).toEqual({ success: true, path: '/tmp/upload/shot.png' })
        const requests = events.map(({ event, payload }) => ({
            event,
            method: (payload as { method: string }).method,
            params: JSON.parse((payload as { params: string }).params) as Record<string, unknown>
        }))
        expect(requests.map((request) => request.event)).toEqual(['rpc-request', 'rpc-request', 'rpc-request'])
        expect(requests.map((request) => request.method)).toEqual([
            'machine-1:uploadFileStart',
            'machine-1:uploadFileChunk',
            'machine-1:uploadFileFinish'
        ])
        const uploadId = requests[0]!.params.uploadId
        expect(requests[0]!.params).toEqual({
            sessionId: 'session-1',
            uploadId,
            filename: 'shot.png',
            mimeType: 'image/png',
            size: 3
        })
        expect(requests[1]!.params).toEqual({
            sessionId: 'session-1',
            uploadId,
            offset: 0,
            content: 'BAUG'
        })
        expect(requests[2]!.params).toEqual({ sessionId: 'session-1', uploadId })
    })

    it('splits uploads at 512 KiB raw chunk boundaries', async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(_event: string, payload: unknown) {
                        const request = payload as { method: string; params: string }
                        requests.push({ method: request.method, params: JSON.parse(request.params) as Record<string, unknown> })
                        return JSON.stringify(request.method.endsWith(':uploadFileFinish')
                            ? { success: true, path: '/tmp/upload/large.bin' }
                            : { success: true })
                    }
                }
            }
        }
        const io = {
            of() {
                return { sockets: { get: () => socket } }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)
        const bytes = new Uint8Array(MAX_UPLOAD_CHUNK_BYTES + 1)

        await expect(gateway.uploadFileBytes('machine-1', 'session-1', 'large.bin', bytes, 'application/octet-stream'))
            .resolves.toEqual({ success: true, path: '/tmp/upload/large.bin' })

        expect(requests.map((request) => request.method)).toEqual([
            'machine-1:uploadFileStart',
            'machine-1:uploadFileChunk',
            'machine-1:uploadFileChunk',
            'machine-1:uploadFileFinish'
        ])
        expect(requests[1]!.params.offset).toBe(0)
        expect(requests[2]!.params.offset).toBe(MAX_UPLOAD_CHUNK_BYTES)
        expect(Buffer.from(requests[1]!.params.content as string, 'base64')).toHaveLength(MAX_UPLOAD_CHUNK_BYTES)
        expect(Buffer.from(requests[2]!.params.content as string, 'base64')).toHaveLength(1)
    })

    it('best-effort cancels a machine upload after a failed chunk', async () => {
        const requests: Array<{ method: string; params: Record<string, unknown> }> = []
        const socket = {
            timeout() {
                return {
                    async emitWithAck(_event: string, payload: unknown) {
                        const request = payload as { method: string; params: string }
                        const parsed = JSON.parse(request.params) as Record<string, unknown>
                        requests.push({ method: request.method, params: parsed })
                        if (request.method.endsWith(':uploadFileChunk')) {
                            return JSON.stringify({ success: false, error: 'disk full' })
                        }
                        return JSON.stringify({ success: true })
                    }
                }
            }
        }
        const io = {
            of() {
                return { sockets: { get: () => socket } }
            }
        } as unknown as Server
        const rpcRegistry = {
            getSocketIdForMethod() { return 'socket-1' }
        } as unknown as RpcRegistry
        const gateway = new RpcGateway(io, rpcRegistry)

        await expect(gateway.uploadFileBytes(
            'machine-1',
            'session-1',
            'shot.png',
            new Uint8Array([4, 5, 6]),
            'image/png'
        )).resolves.toEqual({ success: false, error: 'disk full' })

        expect(requests.map((request) => request.method)).toEqual([
            'machine-1:uploadFileStart',
            'machine-1:uploadFileChunk',
            'machine-1:uploadFileCancel'
        ])
        expect(requests[2]!.params).toEqual({
            sessionId: 'session-1',
            uploadId: requests[0]!.params.uploadId
        })
    })
})
