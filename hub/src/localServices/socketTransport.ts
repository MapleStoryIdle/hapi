import type { Socket } from 'socket.io'
import type { Duplex } from 'node:stream'
import { LOCAL_SERVICE_RPC, type LocalServiceTunnelRequest } from '@hapi/protocol/localServices'
import { LocalServicePeer, localServiceSocketWire } from '@hapi/protocol/localServiceTransport'

export type LocalServiceTunnel = {
    readonly closed: boolean
    connect: (stream: Duplex, activity: () => void) => void
    close: () => void
    onClose: (listener: () => void) => void
}

type LeaseCallbacks = { close: () => void; activity: () => void }
const peers = new WeakMap<Socket, { peer: LocalServicePeer; leases: Map<string, LeaseCallbacks> }>()

/** Pin every lease to the authenticated machine socket that accepted its RPC. */
export async function openLocalServiceSocketTunnel(socket: Socket, machineId: string, namespace: string, request: LocalServiceTunnelRequest): Promise<LocalServiceTunnel> {
    if (!socket.connected || socket.data.namespace !== namespace
        || socket.handshake.auth.clientType !== 'machine-scoped' || socket.handshake.auth.machineId !== machineId) {
        throw new Error('Local service machine connection unavailable')
    }
    let connection = peers.get(socket)
    if (!connection) {
        const leases = new Map<string, LeaseCallbacks>()
        const peer = new LocalServicePeer(localServiceSocketWire(socket), {
            release: (id) => leases.get(id)?.close(),
            activity: (id) => leases.get(id)?.activity(),
            disconnect: () => { for (const lease of [...leases.values()]) lease.close(); peers.delete(socket) }
        })
        connection = { peer, leases }
        peers.set(socket, connection)
    }
    const { peer, leases } = connection
    let closed = false
    const listeners = new Set<() => void>()
    const markClosed = () => {
        if (closed) return
        closed = true
        leases.delete(request.id)
        for (const listener of listeners) listener()
        listeners.clear()
    }
    if (leases.has(request.id)) throw new Error('Local service lease already exists')
    const callbacks: LeaseCallbacks = { close: markClosed, activity: () => {} }
    leases.set(request.id, callbacks)
    try {
        const raw: unknown = await socket.timeout(15_000).emitWithAck('rpc-request', {
            method: `${machineId}:${LOCAL_SERVICE_RPC}`, params: JSON.stringify(request)
        })
        const response: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || closed || !peer.connected) throw new Error('Runner refused local service tunnel')
    } catch (error) { peer.release(request.id); markClosed(); throw error }
    return {
        get closed() { return closed || !peer.connected },
        connect(stream, activity) {
            callbacks.activity = activity
            if (closed) stream.destroy(); else peer.connect(request.id, stream)
        },
        close() { if (!closed) peer.release(request.id); markClosed() },
        onClose(listener) { if (closed) listener(); else listeners.add(listener) }
    }
}
