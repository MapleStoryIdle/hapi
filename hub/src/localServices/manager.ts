import { randomBytes } from 'node:crypto'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import type { LocalServiceTunnel } from './socketTransport'
import {
    LOCAL_SERVICE_LEASE_MS, LOCAL_SERVICE_MAX_CONNECTIONS, LOCAL_SERVICE_MAX_PER_MACHINE,
    parseLocalServiceUrl,
    type LocalServiceSource, type LocalServiceTarget, type LocalServiceTunnelRequest,
    type OpenLocalServiceResponse
} from '@hapi/protocol/localServices'

const TICKET_MS = 30_000
export const LOCAL_SERVICE_ACCESS_MS = 8 * 60 * 60 * 1_000
export const LOCAL_SERVICE_PATH_PREFIX = '/preview/'

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
    tunnel: LocalServiceTunnel | null
    sockets: Set<Socket>
}
type Ticket = { leaseId: string; path: string; expiresAt: number }
type AccessConnection = { destroy: () => unknown; once: (event: 'close', listener: () => void) => unknown }
type Grant = { presentation: 'tab' | 'embed'; leaseId: string; expiresAt: number; connections: Set<AccessConnection> }

export type LocalServiceManagerOptions = {
    mode?: 'domain' | 'path'
    originTemplate?: string
    appUrl: string
    frameOrigins?: readonly string[]
    openTunnel: (machineId: string, request: LocalServiceTunnelRequest, namespace: string) => Promise<LocalServiceTunnel>
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
    readonly mode: 'domain' | 'path'
    readonly frameOrigins: readonly string[]
    private readonly leases = new Map<string, LocalServiceLease>()
    private readonly keys = new Map<string, Promise<LocalServiceLease>>()
    private readonly tickets = new Map<string, Ticket>()
    private readonly grants = new Map<string, Grant>()
    private timer: ReturnType<typeof setInterval> | null = null
    private stopped = false

    constructor(private readonly options: LocalServiceManagerOptions) {
        this.mode = options.mode ?? 'domain'
        this.frameOrigins = [...new Set([new URL(options.appUrl).origin, ...(options.frameOrigins ?? [])].filter((origin) => {
            // Reuse only explicit trusted UI origins, never CORS wildcards or
            // user-controlled request Origin values in an embedding policy.
            try {
                const url = new URL(origin)
                return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.hostname.includes('*') && !url.username && !url.password
            } catch { return false }
        }))]
        if (this.mode === 'domain') {
            if (!options.originTemplate) throw new Error('Local service preview origin is required in domain mode')
            validateLocalServiceOrigin(options.originTemplate, options.appUrl)
        } else {
            const app = new URL(options.appUrl)
            if (app.username || app.password || app.pathname !== '/' || app.search || app.hash
                || (app.protocol !== 'https:' && !(app.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname)))) {
                throw new Error('Path previews require an HTTPS Hub origin (HTTP loopback is allowed for development)')
            }
        }
    }

    async start(): Promise<void> {
        if (this.timer) return
        this.timer = setInterval(() => this.sweep(), 15_000)
        this.timer.unref()
    }

    async open(identity: LocalServiceIdentity, machineId: string, source: LocalServiceSource, url: string, presentation: 'tab' | 'embed' = 'tab'): Promise<OpenLocalServiceResponse> {
        if (!this.timer || this.stopped) throw new LocalServiceError('local_service_unavailable', 'Local service access is unavailable')
        const target = parseLocalServiceUrl(url)
        if (!target) throw new LocalServiceError('local_service_invalid_url', 'Expected a loopback HTTP URL')
        if (!this.options.canAccessMachine(identity, machineId)) throw new LocalServiceError('local_service_offline', 'The runner is offline')
        // Domain embeds must not share an origin with cookie-authenticated tabs:
        // an iframe navigating outside its capability must never inherit a tab grant.
        const key = JSON.stringify([identity.namespace, identity.userId, machineId, source, target.origin, this.mode === 'domain' ? presentation : null])
        const lease = await this.acquireLease(key, identity, machineId, target)
        this.touch(lease)
        this.sweepTickets()
        const base = this.mode === 'path' ? `${LOCAL_SERVICE_PATH_PREFIX}${lease.id}` : ''
        if (presentation === 'embed') {
            // Reopening the same service must not accumulate orphan grants.
            // A grant already covers this lease's service, not a single path.
            let capability = [...this.grants].find(([, grant]) => grant.leaseId === lease.id && grant.presentation === 'embed')?.[0]
            if (!capability) {
                if (this.grants.size >= 2_000) throw new LocalServiceError('local_service_busy', 'Too many local service access requests')
                capability = randomBytes(32).toString('hex')
                this.grants.set(capability, { presentation, leaseId: lease.id, expiresAt: Date.now() + LOCAL_SERVICE_ACCESS_MS, connections: new Set() })
            }
            // Only the authenticated API issues this sandbox-only capability;
            // the iframe needs neither bootstrap nor third-party cookies.
            return { url: `${lease.origin}${base}/__shapi_local/embed/${capability}${target.path}${target.hash}`, expiresAt: lease.expiresAt }
        }
        if ([...this.tickets.values()].filter((ticket) => ticket.leaseId === lease.id).length >= 32 || this.grants.size >= 2_000) {
            throw new LocalServiceError('local_service_busy', 'Too many local service access requests')
        }
        const ticket = randomBytes(32).toString('hex')
        this.tickets.set(ticket, { leaseId: lease.id, path: target.path + target.hash, expiresAt: Date.now() + TICKET_MS })
        return { url: `${lease.origin}${base}/__shapi_local/open#${ticket}`, expiresAt: lease.expiresAt }
    }

    private async acquireLease(key: string, identity: LocalServiceIdentity, machineId: string, target: LocalServiceTarget): Promise<LocalServiceLease> {
        for (;;) {
            const existing = this.keys.get(key)
            if (existing) {
                const lease = await existing
                if (this.leases.has(lease.id) && !lease.tunnel?.closed && lease.expiresAt > Date.now()) return lease
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
        // Internal loopback adapter only. Public HTTP and WS still use the Hub's existing listener.
        const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => this.forwardSocket(id, socket))
        const lease: LocalServiceLease = {
            id, key, identity, machineId, target,
            origin: this.mode === 'path' ? new URL(this.options.appUrl).origin
                : new URL(this.options.originTemplate!.replace('{id}', id)).origin,
            expiresAt: Date.now() + LOCAL_SERVICE_LEASE_MS,
            server, port: 0, tunnel: null, sockets: new Set()
        }
        this.leases.set(id, lease)
        const timeout = setTimeout(() => this.closeLease(id), 15_000)
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject)
                server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
            })
            server.on('error', () => this.closeLease(id))
            lease.port = (server.address() as { port: number }).port
            const tunnel = await this.options.openTunnel(machineId, {
                id, targetUrl: target.origin, expiresAt: lease.expiresAt
            }, identity.namespace)
            lease.tunnel = tunnel
            if (tunnel.closed || !this.leases.has(id)) {
                tunnel.close()
                throw new LocalServiceError('local_service_connect_failed', 'Could not connect to the local service runner')
            }
            tunnel.onClose(() => this.closeLease(id))
            return lease
        } catch (error) {
            this.closeLease(id)
            if (error instanceof LocalServiceError) throw error
            throw new LocalServiceError('local_service_connect_failed', 'Could not connect to the local service runner')
        } finally { clearTimeout(timeout) }
    }

    private forwardSocket(id: string, socket: Socket): void {
        const lease = this.leases.get(id)
        if (!lease?.tunnel || lease.tunnel.closed || lease.expiresAt <= Date.now() || lease.sockets.size >= LOCAL_SERVICE_MAX_CONNECTIONS
            || !this.options.canAccessMachine(lease.identity, lease.machineId)) { socket.destroy(); return }
        lease.sockets.add(socket)
        this.touch(lease)
        socket.on('error', () => socket.destroy())
        socket.once('close', () => lease.sockets.delete(socket))
        lease.tunnel.connect(socket, () => this.touch(lease))
    }

    findHost(host: string | undefined): LocalServiceLease | null {
        if (this.mode !== 'domain') return null
        const id = /^([a-f0-9]{32})\./.exec(host ?? '')?.[1]
        const lease = id ? this.leases.get(id) : undefined
        if (!lease || new URL(lease.origin).host !== host?.toLowerCase() || lease.expiresAt <= Date.now()) return null
        if (!this.options.canAccessMachine(lease.identity, lease.machineId)) return null
        return lease
    }

    findPath(host: string | undefined, pathname: string): LocalServiceLease | null {
        if (this.mode !== 'path') return null
        const id = /^\/preview\/([a-f0-9]{32})\//.exec(pathname)?.[1]
        const lease = id ? this.leases.get(id) : undefined
        if (!lease || new URL(lease.origin).host !== host?.toLowerCase() || lease.expiresAt <= Date.now()
            || !this.options.canAccessMachine(lease.identity, lease.machineId)) return null
        return lease
    }

    redeem(lease: LocalServiceLease, ticket: string): { cookie: string; path: string } | null {
        const record = this.tickets.get(ticket)
        if (!record || record.leaseId !== lease.id || record.expiresAt <= Date.now() || !this.leases.has(lease.id) || this.grants.size >= 2_000) return null
        this.tickets.delete(ticket)
        const cookie = randomBytes(32).toString('hex')
        this.grants.set(cookie, { presentation: 'tab', leaseId: lease.id, expiresAt: Date.now() + LOCAL_SERVICE_ACCESS_MS, connections: new Set() })
        this.touch(lease)
        return { cookie, path: record.path }
    }

    authorize(lease: LocalServiceLease, cookie: string | undefined, connection?: AccessConnection, presentation: 'tab' | 'embed' = 'tab'): boolean {
        const grant = cookie ? this.grants.get(cookie) : undefined
        if (!grant || grant.presentation !== presentation || grant.leaseId !== lease.id || grant.expiresAt <= Date.now() || !this.leases.has(lease.id)) return false
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
        for (const socket of lease.sockets) socket.destroy()
        lease.tunnel?.close()
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
        this.timer = null
    }
}
