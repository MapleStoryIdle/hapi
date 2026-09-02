import { describe, expect, it } from 'bun:test'
import type { StoredMachine, Store } from '../../../store'
import type { CliSocketWithData } from '../../socketTypes'
import { registerMachineHandlers } from './machineHandlers'

class FakeSocket {
    readonly data: Record<string, unknown> = { namespace: 'team-a' }
    readonly handshake = { auth: { machineId: 'machine-1' } }
    readonly emitted: Array<{ event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    trigger(event: string, data: unknown): void {
        this.handlers.get(event)?.(data)
    }
}

describe('external Codex machine socket events', () => {
    it('forwards a valid request with the authenticated namespace', () => {
        const socket = new FakeSocket()
        const requests: unknown[] = []

        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store: {} as Store,
            resolveMachineAccess: () => ({ ok: true, value: {} as StoredMachine }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onExternalCodexRequest: (request) => requests.push(request)
        })

        socket.trigger('external-codex-request', {
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            requestId: 'turn-1:Bash',
            kind: 'permission',
            toolName: 'Bash'
        })

        expect(requests).toEqual([{
            namespace: 'team-a',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            requestId: 'turn-1:Bash',
            kind: 'permission',
            toolName: 'Bash'
        }])
    })

    it('rejects a request whose machine id differs from the machine socket identity', () => {
        const socket = new FakeSocket()
        const accessErrors: unknown[] = []
        const requests: unknown[] = []

        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store: {} as Store,
            resolveMachineAccess: () => ({ ok: true, value: {} as StoredMachine }),
            emitAccessError: (...args) => accessErrors.push(args),
            onExternalCodexRequest: (request) => requests.push(request)
        })

        socket.trigger('external-codex-request', {
            machineId: 'other-machine',
            codexSessionId: 'codex-thread-1',
            requestId: 'request-1',
            kind: 'permission'
        })

        expect(requests).toEqual([])
        expect(accessErrors).toEqual([['machine', 'other-machine', 'access-denied']])
    })
})

describe('native Codex transcript machine socket events', () => {
    it('publishes a namespaced lightweight invalidation event', () => {
        const socket = new FakeSocket()
        const events: unknown[] = []

        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store: {} as Store,
            resolveMachineAccess: () => ({ ok: true, value: {} as StoredMachine }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => events.push(event)
        })

        socket.trigger('codex-session-updated', {
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            modifiedAt: 1_725_000_000_000,
            summary: {
                id: 'codex-thread-1',
                title: 'Updated native task',
                cwd: '/workspace/project',
                modifiedAt: 1_725_000_000_000,
                runState: 'idle'
            }
        })

        expect(events).toEqual([{
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            modifiedAt: 1_725_000_000_000,
            summary: {
                id: 'codex-thread-1',
                title: 'Updated native task',
                cwd: '/workspace/project',
                modifiedAt: 1_725_000_000_000,
                runState: 'idle'
            },
            namespace: 'team-a'
        }])
    })

    it('forwards only the compact version/status snapshot', () => {
        const socket = new FakeSocket()
        const events: unknown[] = []

        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store: {} as Store,
            resolveMachineAccess: () => ({ ok: true, value: {} as StoredMachine }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => events.push(event)
        })

        socket.trigger('codex-session-updated', {
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 7 },
                revision: 7,
                status: { success: true, status: 'processing' },
                timing: { cache: 'hit', durationMs: 2 },
                importedMessages: [{ role: 'agent', content: 'must not pass through' }]
            }
        })

        expect(events).toEqual([{
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            namespace: 'team-a'
        }])
    })

    it('rejects a native event whose machine id differs from the socket identity', () => {
        const socket = new FakeSocket()
        const accessErrors: unknown[] = []
        const events: unknown[] = []

        registerMachineHandlers(socket as unknown as CliSocketWithData, {
            store: {} as Store,
            resolveMachineAccess: () => ({ ok: true, value: {} as StoredMachine }),
            emitAccessError: (...args) => accessErrors.push(args),
            onWebappEvent: (event) => events.push(event)
        })

        socket.trigger('codex-session-updated', {
            machineId: 'other-machine',
            codexSessionId: 'codex-thread-1'
        })

        expect(events).toEqual([])
        expect(accessErrors).toEqual([['machine', 'other-machine', 'access-denied']])
    })
})
