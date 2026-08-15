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
