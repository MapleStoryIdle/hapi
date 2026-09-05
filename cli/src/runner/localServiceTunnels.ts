import { connect, type Socket } from 'node:net'
import { Client, type ClientChannel } from 'ssh2'
import {
    LOCAL_SERVICE_LEASE_MS,
    LOCAL_SERVICE_MAX_CONNECTIONS,
    LOCAL_SERVICE_MAX_PER_MACHINE,
    LocalServiceTunnelRequestSchema,
    parseLocalServiceUrl,
    type LocalServiceTunnelRequest,
    type LocalServiceTunnelResponse
} from '@hapi/protocol/localServices'

type Tunnel = {
    client: Client
    expiresAt: number
    sockets: Set<Socket>
    channels: Set<ClientChannel>
}

/** Dedicated forwarding clients, unrelated to interactive SSH/Codex processes. */
export class LocalServiceTunnels {
    private readonly tunnels = new Map<string, Tunnel>()
    private timer: ReturnType<typeof setInterval> | null = null

    constructor(private readonly blockedPorts: () => number[] = () => []) {}

    async open(raw: unknown): Promise<LocalServiceTunnelResponse> {
        const parsed = LocalServiceTunnelRequestSchema.safeParse(raw)
        if (!parsed.success) return { ok: false, error: 'Invalid local service tunnel request' }
        const request = parsed.data
        const target = parseLocalServiceUrl(request.targetUrl)!
        if (this.blockedPorts().includes(target.port)) {
            return { ok: false, error: 'The runner control port cannot be forwarded' }
        }
        if (request.expiresAt <= Date.now() || request.expiresAt > Date.now() + LOCAL_SERVICE_LEASE_MS + 60_000) {
            return { ok: false, error: 'Invalid local service lease' }
        }
        if (this.tunnels.has(request.id)) return { ok: false, error: 'Tunnel identity already exists' }
        if (this.tunnels.size >= LOCAL_SERVICE_MAX_PER_MACHINE) return { ok: false, error: 'Too many local service tunnels' }

        const client = new Client()
        const tunnel: Tunnel = { client, expiresAt: request.expiresAt, sockets: new Set(), channels: new Set() }
        this.tunnels.set(request.id, tunnel)
        this.startTimer()
        const touch = () => { tunnel.expiresAt = Date.now() + LOCAL_SERVICE_LEASE_MS }

        client.on('tcp connection', (details, accept, reject) => {
            if (this.tunnels.get(request.id) !== tunnel
                || tunnel.expiresAt <= Date.now()
                || details.destIP !== '127.0.0.1' || details.destPort !== request.remotePort
                || tunnel.sockets.size >= LOCAL_SERVICE_MAX_CONNECTIONS) {
                reject()
                return
            }
            // No DNS lookup of arbitrary hosts: localhost is explicitly mapped to loopback.
            const hosts = target.hostname === '[::1]' ? ['::1']
                : target.hostname === 'localhost' ? ['127.0.0.1', '::1'] : ['127.0.0.1']
            const attempt = (index: number) => {
                if (this.tunnels.get(request.id) !== tunnel) { reject(); return }
                const socket = connect({ host: hosts[index], port: target.port })
                tunnel.sockets.add(socket)
                socket.setTimeout(5_000, () => socket.destroy(new Error('Local service connection timed out')))
                let connected = false
                socket.once('connect', () => {
                    connected = true
                    socket.setTimeout(0)
                    if (this.tunnels.get(request.id) !== tunnel) { socket.destroy(); reject(); return }
                    const channel = accept()
                    tunnel.channels.add(channel)
                    touch()
                    socket.on('data', touch)
                    channel.on('data', touch)
                    channel.on('error', () => socket.destroy())
                    socket.on('error', () => channel.destroy())
                    channel.once('close', () => { tunnel.channels.delete(channel); socket.destroy() })
                    socket.once('close', () => channel.destroy())
                    socket.pipe(channel).pipe(socket)
                })
                socket.once('error', () => {
                    if (connected) return
                    if (index + 1 < hosts.length) attempt(index + 1)
                    else reject()
                })
                socket.once('close', () => tunnel.sockets.delete(socket))
            }
            attempt(0)
        })

        const result = await this.connect(client, request)
        if (!result.ok) this.close(request.id)
        return result
    }

    private connect(client: Client, request: LocalServiceTunnelRequest): Promise<LocalServiceTunnelResponse> {
        return new Promise((resolve) => {
            let settled = false
            const finish = (result: LocalServiceTunnelResponse) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                resolve(result)
            }
            const timeout = setTimeout(() => {
                finish({ ok: false, error: 'Local service tunnel connection timed out' })
                this.close(request.id)
            }, 12_000)
            client.on('error', () => finish({ ok: false, error: 'Could not establish the local service tunnel' }))
            client.once('close', () => {
                finish({ ok: false, error: 'Local service tunnel disconnected' })
                this.close(request.id)
            })
            client.once('ready', () => {
                client.forwardIn('127.0.0.1', request.remotePort, (error) => {
                    finish(error ? { ok: false, error: 'Local service forwarding was refused' } : { ok: true })
                })
            })
            try {
                client.connect({
                    host: request.sshHost,
                    port: request.sshPort,
                    username: request.id,
                    password: request.secret,
                    hostHash: 'sha256',
                    hostVerifier: (hash: string) => hash === request.hostFingerprint,
                    readyTimeout: 10_000,
                    keepaliveInterval: 15_000,
                    keepaliveCountMax: 3,
                    tryKeyboard: false
                })
            } catch {
                finish({ ok: false, error: 'Could not establish the local service tunnel' })
            }
        })
    }

    private startTimer(): void {
        if (this.timer) return
        this.timer = setInterval(() => {
            for (const [id, tunnel] of this.tunnels) {
                if (tunnel.expiresAt <= Date.now()) this.close(id)
            }
        }, 15_000)
        this.timer.unref()
    }

    private close(id: string): void {
        const tunnel = this.tunnels.get(id)
        if (!tunnel) return
        this.tunnels.delete(id)
        for (const socket of tunnel.sockets) socket.destroy()
        for (const channel of tunnel.channels) channel.destroy()
        tunnel.client.destroy()
        if (this.tunnels.size === 0 && this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    dispose(): void {
        for (const id of this.tunnels.keys()) this.close(id)
    }
}
