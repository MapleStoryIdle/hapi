import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { Server as SshServer, utils, type Connection, type ServerChannel } from 'ssh2'
import {
    LOCAL_SERVICE_LEASE_MS, LOCAL_SERVICE_MAX_CONNECTIONS, LOCAL_SERVICE_MAX_PER_MACHINE,
    parseLocalServiceUrl,
    type LocalServiceSource, type LocalServiceTarget, type LocalServiceTunnelRequest, type LocalServiceTunnelResponse,
    type OpenLocalServiceResponse
} from '@hapi/protocol/localServices'

const TICKET_MS = 30_000
export const LOCAL_SERVICE_ACCESS_MS = 8 * 60 * 60 * 1_000

export class LocalServiceError extends Error {
    constructor(readonly code: string, message: string) { super(message) }
}

export type LocalServiceIdentity = { namespace: string; userId: number }
export type LocalServiceLease = {
    id: string
    key: string
    identity: LocalServiceIdentity
    machineId: string
    target: LocalServiceTarget
    origin: string
    expiresAt: number
    server: NetServer
    port: number
    client: Connection | null
    claimed: boolean
    secret: string
    authDeadline: number
    ready: Promise<boolean>
    resolveReady: (ready: boolean) => void
    sockets: Set<Socket>
    channels: Set<ServerChannel>
}
type Ticket = { leaseId: string; path: string; expiresAt: number }
type AccessConnection = { destroy: () => unknown; once: (event: 'close', listener: () => void) => unknown }
type Grant = { leaseId: string; expiresAt: number; connections: Set<AccessConnection> }

export type LocalServiceManagerOptions = {
    originTemplate: string
    appUrl: string
    sshHost: string
    sshListenHost: string
    sshPort: number
    openTunnel: (machineId: string, request: LocalServiceTunnelRequest) => Promise<LocalServiceTunnelResponse>
    canAccessMachine: (identity: LocalServiceIdentity, machineId: string) => boolean
}

export function validateLocalServiceOrigin(template: string, appUrl: string): void {
    const url = new URL(template.replace('{id}', 'a'.repeat(32)))
    const app = new URL(appUrl)
    const isLocalDev = ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)
        && url.hostname.endsWith('.localhost')
    if (!/^https?:\/\/\{id\}\./.test(template)
        || template.split('{id}').length !== 2 || url.pathname !== '/' || url.search || url.hash || url.username || url.password
        || (url.protocol !== 'https:' && !isLocalDev)
        || url.hostname === app.hostname
        || (!isLocalDev && (url.hostname.slice(33) === app.hostname || app.hostname.endsWith(`.${url.hostname.slice(33)}`)))) {
        throw new Error('Local service origin must be an isolated HTTPS {id}.<preview-domain> origin')
    }
}

/** Leases and one-use browser tickets only; no page bodies or credentials on disk. */
export class LocalServiceManager {
    private readonly leases = new Map<string, LocalServiceLease>()
    private readonly keys = new Map<string, Promise<LocalServiceLease>>()
    private readonly tickets = new Map<string, Ticket>()
    private readonly grants = new Map<string, Grant>()
    private readonly clients = new Set<Connection>()
    private readonly transports = new Map<Socket, ReturnType<typeof setTimeout>>()
    private readonly clientSockets = new Map<Connection, Socket>()
    private ssh: SshServer | null = null
    private timer: ReturnType<typeof setInterval> | null = null
    private sshPort = 0
    private fingerprint = ''
    private stopped = false

    constructor(private readonly options: LocalServiceManagerOptions) {
        validateLocalServiceOrigin(options.originTemplate, options.appUrl)
    }

    async start(): Promise<void> {
        const keys = utils.generateKeyPairSync('ed25519')
        this.fingerprint = createHash('sha256').update(Buffer.from(keys.public.split(' ')[1], 'base64')).digest('hex')
        const ssh = new SshServer({ hostKeys: [keys.private], greeting: '', ident: 'SHAPI-preview' }, (client) => {
            this.clients.add(client)
            // ssh2 1.17 exposes only graceful end() on server connections. Keep its
            // owned TCP transport for hard revocation and Bun-safe shutdown.
            const transport = (client as Connection & { _sock?: Socket })._sock
            if (!transport) { client.end(); return }
            this.clientSockets.set(client, transport)
            let lease: LocalServiceLease | undefined
            const authTimeout = setTimeout(() => transport.destroy(), 10_000)
            client.once('ready', () => { clearTimeout(authTimeout); clearTimeout(this.transports.get(transport)) })
            client.on('authentication', (auth) => {
                const candidate = this.leases.get(auth.username)
                const password = auth.method === 'password' ? auth.password : ''
                if (!candidate || candidate.claimed || candidate.authDeadline <= Date.now()
                    || !this.options.canAccessMachine(candidate.identity, candidate.machineId)
                    || !/^[a-f0-9]{64}$/.test(password)
                    || !timingSafeEqual(Buffer.from(password), Buffer.from(candidate.secret))) {
                    auth.reject(['password'])
                    return
                }
                // Consume before accepting; concurrent connections cannot claim the same lease.
                candidate.claimed = true
                candidate.client = client
                lease = candidate
                auth.accept()
            })
            client.on('session', (_accept, reject) => reject())
            client.on('tcpip', (_accept, reject) => reject())
            client.on('openssh.streamlocal', (_accept, reject) => reject())
            client.on('request', (accept, reject, name, info) => {
                if (!lease || !accept || name !== 'tcpip-forward'
                    || info.bindAddr !== '127.0.0.1' || info.bindPort !== lease.port
                    || this.leases.get(lease.id) !== lease) {
                    reject?.()
                    return
                }
                accept(lease.port)
                lease.resolveReady(true)
            })
            client.on('error', () => { if (lease) this.closeLease(lease.id) })
            client.once('close', () => {
                clearTimeout(authTimeout)
                this.clients.delete(client)
                this.clientSockets.delete(client)
                if (lease) this.closeLease(lease.id)
            })
        })
        ssh.maxConnections = 100
        // Bound pre-header/handshake connections too, before ssh2 emits its client event.
        // Kept alongside the _sock adapter above; covered by actual Bun SSH tests.
        const tcp = (ssh as SshServer & { _srv?: NetServer })._srv
        if (!tcp) throw new Error('Unsupported ssh2 server transport')
        tcp.on('connection', (socket: Socket) => {
            const deadline = setTimeout(() => socket.destroy(), 10_000)
            deadline.unref()
            this.transports.set(socket, deadline)
            socket.once('close', () => { clearTimeout(deadline); this.transports.delete(socket) })
        })
        await new Promise<void>((resolve, reject) => {
            ssh.once('error', reject)
            ssh.listen(this.options.sshPort, this.options.sshListenHost, () => {
                ssh.removeListener('error', reject)
                resolve()
            })
        })
        ssh.on('error', () => { for (const id of this.leases.keys()) this.closeLease(id) })
        this.ssh = ssh
        this.sshPort = (ssh.address() as { port: number }).port
        this.timer = setInterval(() => this.sweep(), 15_000)
        this.timer.unref()
    }

    async open(identity: LocalServiceIdentity, machineId: string, source: LocalServiceSource, url: string): Promise<OpenLocalServiceResponse> {
        if (!this.ssh || this.stopped) throw new LocalServiceError('local_service_unavailable', 'Local service access is unavailable')
        const target = parseLocalServiceUrl(url)
        if (!target) throw new LocalServiceError('local_service_invalid_url', 'Expected a loopback HTTP URL')
        if (!this.options.canAccessMachine(identity, machineId)) throw new LocalServiceError('local_service_offline', 'The runner is offline')
        const key = JSON.stringify([identity.namespace, identity.userId, machineId, source, target.origin])
        const lease = await this.acquireLease(key, identity, machineId, target)
        this.touch(lease)
        this.sweepTickets()
        if ([...this.tickets.values()].filter((ticket) => ticket.leaseId === lease.id).length >= 32 || this.grants.size >= 2_000) {
            throw new LocalServiceError('local_service_busy', 'Too many local service access requests')
        }
        const ticket = randomBytes(32).toString('hex')
        this.tickets.set(ticket, { leaseId: lease.id, path: target.path + target.hash, expiresAt: Date.now() + TICKET_MS })
        return { url: `${lease.origin}/__shapi_local/open#${ticket}`, expiresAt: lease.expiresAt }
    }

    private async acquireLease(key: string, identity: LocalServiceIdentity, machineId: string, target: LocalServiceTarget): Promise<LocalServiceLease> {
        for (;;) {
            const existing = this.keys.get(key)
            if (existing) {
                const lease = await existing
                if (this.leases.has(lease.id) && lease.expiresAt > Date.now()) return lease
                // Another opener may already be rebuilding this expired tunnel.
                if (this.keys.get(key) !== existing) continue
                this.closeLease(lease.id)
                this.keys.delete(key)
            }
            const pending = this.createLease(key, identity, machineId, target)
            this.keys.set(key, pending)
            try { return await pending } catch (error) {
                if (this.keys.get(key) === pending) this.keys.delete(key)
                throw error
            }
        }
    }

    private async createLease(key: string, identity: LocalServiceIdentity, machineId: string, target: LocalServiceTarget): Promise<LocalServiceLease> {
        if ([...this.leases.values()].filter((lease) => lease.machineId === machineId && lease.identity.namespace === identity.namespace).length >= LOCAL_SERVICE_MAX_PER_MACHINE
            || this.leases.size >= 100) {
            throw new LocalServiceError('local_service_busy', 'Too many local service tunnels')
        }
        const id = randomBytes(16).toString('hex')
        let resolveReady!: (ready: boolean) => void
        const ready = new Promise<boolean>((resolve) => { resolveReady = resolve })
        const server = createServer({ pauseOnConnect: true }, (socket) => this.forwardSocket(id, socket))
        const lease: LocalServiceLease = {
            id, key, identity, machineId, target,
            origin: new URL(this.options.originTemplate.replace('{id}', id)).origin,
            expiresAt: Date.now() + LOCAL_SERVICE_LEASE_MS,
            server, port: 0, client: null, claimed: false,
            secret: randomBytes(32).toString('hex'), authDeadline: Date.now() + 15_000,
            ready, resolveReady, sockets: new Set(), channels: new Set()
        }
        this.leases.set(id, lease)
        const timeout = setTimeout(() => { resolveReady(false); this.closeLease(id) }, 15_000)
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
            })
            server.on('error', () => this.closeLease(id))
            lease.port = (server.address() as { port: number }).port
            const result = await this.options.openTunnel(machineId, {
                id, secret: lease.secret,
                sshHost: this.options.sshHost, sshPort: this.sshPort, remotePort: lease.port,
                hostFingerprint: this.fingerprint, targetUrl: target.origin, expiresAt: lease.expiresAt
            })
            if (!result.ok || !await ready || !this.leases.has(id)) {
                throw new LocalServiceError('local_service_connect_failed', 'Could not connect to the local service runner')
            }
            return lease
        } catch (error) {
            this.closeLease(id)
            if (error instanceof LocalServiceError) throw error
            throw new LocalServiceError('local_service_connect_failed', 'Could not connect to the local service runner')
        } finally { clearTimeout(timeout) }
    }

    private forwardSocket(id: string, socket: Socket): void {
        const lease = this.leases.get(id)
        if (!lease?.client || lease.expiresAt <= Date.now() || lease.sockets.size >= LOCAL_SERVICE_MAX_CONNECTIONS
            || !this.options.canAccessMachine(lease.identity, lease.machineId)) { socket.destroy(); return }
        lease.sockets.add(socket)
        socket.on('error', () => socket.destroy())
        socket.once('close', () => lease.sockets.delete(socket))
        const timeout = setTimeout(() => socket.destroy(), 5_000)
        lease.client.forwardOut('127.0.0.1', lease.port, '127.0.0.1', socket.remotePort ?? 0, (error, channel) => {
            clearTimeout(timeout)
            if (error || !channel || socket.destroyed || !this.leases.has(id)) { socket.destroy(); channel?.destroy(); return }
            lease.channels.add(channel)
            const touch = () => this.touch(lease)
            touch()
            socket.on('data', touch)
            channel.on('data', touch)
            channel.on('error', () => socket.destroy())
            channel.once('close', () => { lease.channels.delete(channel); socket.destroy() })
            socket.once('close', () => channel.destroy())
            socket.pipe(channel).pipe(socket)
        })
    }

    findHost(host: string | undefined): LocalServiceLease | null {
        const id = /^([a-f0-9]{32})\./.exec(host ?? '')?.[1]
        const lease = id ? this.leases.get(id) : undefined
        if (!lease || new URL(lease.origin).host !== host?.toLowerCase() || lease.expiresAt <= Date.now()) return null
        if (!this.options.canAccessMachine(lease.identity, lease.machineId)) return null
        return lease
    }

    redeem(lease: LocalServiceLease, ticket: string): { cookie: string; path: string } | null {
        const record = this.tickets.get(ticket)
        if (!record || record.leaseId !== lease.id || record.expiresAt <= Date.now() || !this.leases.has(lease.id) || this.grants.size >= 2_000) return null
        this.tickets.delete(ticket)
        const cookie = randomBytes(32).toString('hex')
        this.grants.set(cookie, { leaseId: lease.id, expiresAt: Date.now() + LOCAL_SERVICE_ACCESS_MS, connections: new Set() })
        this.touch(lease)
        return { cookie, path: record.path }
    }

    authorize(lease: LocalServiceLease, cookie: string | undefined, connection?: AccessConnection): boolean {
        const grant = cookie ? this.grants.get(cookie) : undefined
        if (!grant || grant.leaseId !== lease.id || grant.expiresAt <= Date.now() || !this.leases.has(lease.id)) return false
        if (connection) {
            grant.connections.add(connection)
            connection.once('close', () => grant.connections.delete(connection))
        }
        this.touch(lease)
        return true
    }

    private touch(lease: LocalServiceLease): void { lease.expiresAt = Date.now() + LOCAL_SERVICE_LEASE_MS }

    private sweepTickets(): void {
        const now = Date.now()
        for (const [key, record] of this.tickets) if (record.expiresAt <= now) this.tickets.delete(key)
        for (const [key, record] of this.grants) if (record.expiresAt <= now) {
            for (const connection of record.connections) connection.destroy()
            this.grants.delete(key)
        }
    }

    sweep(): void {
        this.sweepTickets()
        for (const [id, lease] of this.leases) {
            if (lease.expiresAt <= Date.now() || !this.options.canAccessMachine(lease.identity, lease.machineId)) this.closeLease(id)
        }
    }

    closeLease(id: string): void {
        const lease = this.leases.get(id)
        if (!lease) return
        this.leases.delete(id)
        this.keys.delete(lease.key)
        lease.resolveReady(false)
        for (const socket of lease.sockets) socket.destroy()
        for (const channel of lease.channels) channel.destroy()
        lease.client?.end()
        if (lease.client) this.clientSockets.get(lease.client)?.destroy()
        lease.server.close()
        for (const [key, record] of this.tickets) if (record.leaseId === id) this.tickets.delete(key)
        for (const [key, record] of this.grants) if (record.leaseId === id) {
            for (const connection of record.connections) connection.destroy()
            this.grants.delete(key)
        }
    }

    async stop(): Promise<void> {
        this.stopped = true
        if (this.timer) clearInterval(this.timer)
        for (const id of this.leases.keys()) this.closeLease(id)
        for (const client of this.clients) client.end()
        for (const socket of this.clientSockets.values()) socket.destroy()
        for (const socket of this.transports.keys()) socket.destroy()
        if (this.ssh) await new Promise<void>((resolve) => this.ssh!.close(() => resolve()))
        this.ssh = null
    }
}
