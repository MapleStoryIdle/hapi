import { connect, type Socket } from 'node:net'
import {
    LOCAL_SERVICE_LEASE_MS, LOCAL_SERVICE_MAX_PER_MACHINE,
    LocalServiceTunnelRequestSchema, parseLocalServiceUrl,
    type LocalServiceTarget, type LocalServiceTunnelResponse
} from '@hapi/protocol/localServices'
import { LocalServicePeer, type LocalServiceWire } from '@hapi/protocol/localServiceTransport'

type Tunnel = { target: LocalServiceTarget; expiresAt: number }

/** Loopback access over the Runner's existing authenticated Hub socket. No SSH or public listener. */
export class LocalServiceTunnels {
    private readonly tunnels = new Map<string, Tunnel>()
    private timer: ReturnType<typeof setInterval> | null = null
    private peer: LocalServicePeer | null = null

    constructor(private readonly blockedPorts: () => number[] = () => []) {}

    attach(wire: LocalServiceWire): void {
        this.dispose()
        this.peer = new LocalServicePeer(wire, {
            open: (id, signal) => this.connectLocal(id, signal),
            release: (id) => this.tunnels.delete(id),
            disconnect: () => this.dispose(),
            activity: (id) => {
                const tunnel = this.tunnels.get(id)
                if (tunnel) tunnel.expiresAt = Date.now() + LOCAL_SERVICE_LEASE_MS
            }
        })
    }

    async open(raw: unknown): Promise<LocalServiceTunnelResponse> {
        const parsed = LocalServiceTunnelRequestSchema.safeParse(raw)
        if (!parsed.success) return { ok: false, error: 'Invalid local service tunnel request' }
        const request = parsed.data
        const target = parseLocalServiceUrl(request.targetUrl)!
        if (this.blockedPorts().includes(target.port)) return { ok: false, error: 'The runner control port cannot be forwarded' }
        if (request.expiresAt <= Date.now() || request.expiresAt > Date.now() + LOCAL_SERVICE_LEASE_MS + 60_000) {
            return { ok: false, error: 'Invalid local service lease' }
        }
        if (!this.peer?.connected) return { ok: false, error: 'The Hub connection is offline' }
        if (this.tunnels.has(request.id)) return { ok: false, error: 'Tunnel identity already exists' }
        if (this.tunnels.size >= LOCAL_SERVICE_MAX_PER_MACHINE) return { ok: false, error: 'Too many local service tunnels' }
        this.tunnels.set(request.id, { target, expiresAt: request.expiresAt })
        if (!this.timer) {
            this.timer = setInterval(() => {
                for (const [id, tunnel] of this.tunnels) if (tunnel.expiresAt <= Date.now()) this.peer?.release(id)
            }, 15_000)
            this.timer.unref()
        }
        return { ok: true }
    }

    private async connectLocal(id: string, signal: AbortSignal): Promise<Socket> {
        const tunnel = this.tunnels.get(id)
        if (!tunnel || tunnel.expiresAt <= Date.now() || this.blockedPorts().includes(tunnel.target.port)) throw new Error('Local service lease unavailable')
        const target = tunnel.target
        const hosts = target.hostname === '[::1]' ? ['::1'] : target.hostname === 'localhost' ? ['127.0.0.1', '::1'] : ['127.0.0.1']
        for (const host of hosts) {
            if (signal.aborted || this.tunnels.get(id) !== tunnel) break
            try {
                return await new Promise<Socket>((resolve, reject) => {
                    const socket = connect({ host, port: target.port, allowHalfOpen: true, signal })
                    const timeout = setTimeout(() => socket.destroy(new Error('Local connection timed out')), 5_000)
                    socket.once('close', () => clearTimeout(timeout))
                    socket.on('error', reject)
                    socket.once('connect', () => {
                        clearTimeout(timeout)
                        if (signal.aborted || this.tunnels.get(id) !== tunnel) {
                            socket.destroy(); reject(new Error('Local service lease closed')); return
                        }
                        tunnel.expiresAt = Date.now() + LOCAL_SERVICE_LEASE_MS
                        resolve(socket)
                    })
                })
            } catch { /* localhost can be served on IPv6 only; never resolve arbitrary hosts. */ }
        }
        throw new Error('Unable to connect to local service')
    }

    dispose(): void {
        const peer = this.peer
        this.peer = null
        peer?.dispose()
        this.tunnels.clear()
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }
}
