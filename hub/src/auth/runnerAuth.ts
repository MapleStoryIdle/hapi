import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import type { Store } from '../store'
import { constantTimeEquals } from '../utils/crypto'

const RUNNER_ACCESS_TTL_SECONDS = 5 * 60
const SOCKET_TICKET_TTL_SECONDS = 30
const DPOP_CLOCK_SKEW_SECONDS = 60

type RunnerIdentity = {
    workspaceId: string
    namespace: string
    accessKeyId: string
    machineId: string
    publicKeyThumbprint: string
}

export type RunnerAccessGrant = RunnerIdentity & {
    accessToken: string
    expiresIn: number
}

export type RunnerSocketTicket = {
    ticket: string
    expiresIn: number
}

type TicketRecord = RunnerIdentity & { expiresAt: number }

const proofPayloadSchema = z.object({
    htm: z.string(),
    htu: z.string(),
    iat: z.number().int(),
    jti: z.string().min(8).max(256),
    ath: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).passthrough()

const runnerAccessPayloadSchema = z.object({
    typ: z.literal('runner_access'),
    wid: z.string().min(1),
    ns: z.string().min(1),
    aid: z.string().min(1),
    mid: z.string().uuid(),
    cnf: z.object({ jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
})

type PublicEcJwk = {
    kty?: string
    crv?: string
    x?: string
    y?: string
    d?: string
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url')
}

function hashTicket(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex')
}

function normalizeHtu(value: string): string | null {
    try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.toString()
    } catch {
        return null
    }
}

function validatePublicJwk(value: unknown): {
    key: ReturnType<typeof createPublicKey>
    thumbprint: string
} | null {
    try {
        if (!value || typeof value !== 'object') return null
        const parsed = value as PublicEcJwk
        if (parsed.kty !== 'EC' || parsed.crv !== 'P-256'
            || typeof parsed.x !== 'string' || typeof parsed.y !== 'string'
            || parsed.d !== undefined) return null
        const key = createPublicKey({ key: parsed, format: 'jwk' })
        const exported = key.export({ format: 'jwk' })
        if (exported.kty !== 'EC' || exported.crv !== 'P-256'
            || typeof exported.x !== 'string' || typeof exported.y !== 'string') return null
        const canonical = JSON.stringify({
            crv: 'P-256',
            kty: 'EC',
            x: exported.x,
            y: exported.y,
        })
        return {
            key,
            thumbprint: createHash('sha256').update(canonical).digest('base64url'),
        }
    } catch {
        return null
    }
}

export class RunnerAuthService {
    private readonly proofReplay = new Map<string, number>()
    private readonly socketTickets = new Map<string, TicketRecord>()

    constructor(
        private readonly store: Store,
        private readonly jwtSecret: Uint8Array,
    ) {}

    async exchangeRunnerCredential(input: {
        runnerToken: string
        machineId: string
        proof: string
        method: string
        targetUrl: string
        legacyBaseToken: string
    }): Promise<RunnerAccessGrant | null> {
        const access = this.store.workspaces.authenticate(
            input.runnerToken,
            input.legacyBaseToken,
            'runner',
            input.machineId,
        )
        if (!access || access.kind !== 'runner') return null
        const binding = this.store.workspaces.getActiveRunnerKeyBinding(
            access.workspace.id,
            access.accessKeyId,
        )
        if (!binding || binding.boundMachineId !== input.machineId) return null
        const proofValid = await this.verifyProof({
            proof: input.proof,
            method: input.method,
            targetUrl: input.targetUrl,
            expectedThumbprint: binding.publicKeyThumbprint,
            accessToken: input.runnerToken,
        })
        if (!proofValid) return null
        const nowSeconds = Math.floor(Date.now() / 1000)
        const accessToken = await new SignJWT({
            typ: 'runner_access',
            wid: access.workspace.id,
            ns: access.workspace.dataNamespace,
            aid: access.accessKeyId,
            mid: binding.boundMachineId,
            cnf: { jkt: binding.publicKeyThumbprint },
        })
            .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
            .setIssuer('shapi-hub')
            .setAudience('shapi-runner')
            .setIssuedAt(nowSeconds)
            .setNotBefore(nowSeconds - 5)
            .setJti(randomUUID())
            .setExpirationTime(nowSeconds + RUNNER_ACCESS_TTL_SECONDS)
            .sign(this.jwtSecret)
        return {
            workspaceId: access.workspace.id,
            namespace: access.workspace.dataNamespace,
            accessKeyId: access.accessKeyId,
            machineId: binding.boundMachineId,
            publicKeyThumbprint: binding.publicKeyThumbprint,
            accessToken,
            expiresIn: RUNNER_ACCESS_TTL_SECONDS,
        }
    }

    async authenticateRunnerAccess(input: {
        accessToken: string
        proof: string
        method: string
        targetUrl: string
    }): Promise<RunnerIdentity | null> {
        try {
            if (decodeProtectedHeader(input.accessToken).typ !== 'at+jwt') return null
            const verified = await jwtVerify(input.accessToken, this.jwtSecret, {
                algorithms: ['HS256'],
                issuer: 'shapi-hub',
                audience: 'shapi-runner',
            })
            const parsed = runnerAccessPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) return null
            const binding = this.store.workspaces.getActiveRunnerKeyBinding(
                parsed.data.wid,
                parsed.data.aid,
            )
            if (!binding
                || binding.boundMachineId !== parsed.data.mid
                || !constantTimeEquals(binding.publicKeyThumbprint, parsed.data.cnf.jkt)) return null
            const workspace = this.store.workspaces.get(parsed.data.wid)
            if (!workspace || workspace.dataNamespace !== parsed.data.ns) return null
            const proofValid = await this.verifyProof({
                proof: input.proof,
                method: input.method,
                targetUrl: input.targetUrl,
                expectedThumbprint: binding.publicKeyThumbprint,
                accessToken: input.accessToken,
            })
            if (!proofValid) return null
            return {
                workspaceId: workspace.id,
                namespace: workspace.dataNamespace,
                accessKeyId: binding.accessKeyId,
                machineId: binding.boundMachineId,
                publicKeyThumbprint: binding.publicKeyThumbprint,
            }
        } catch {
            return null
        }
    }

    issueSocketTicket(identity: RunnerIdentity): RunnerSocketTicket {
        this.prune()
        const ticket = randomBytes(32).toString('base64url')
        this.socketTickets.set(hashTicket(ticket), {
            ...identity,
            expiresAt: Date.now() + SOCKET_TICKET_TTL_SECONDS * 1000,
        })
        return { ticket, expiresIn: SOCKET_TICKET_TTL_SECONDS }
    }

    consumeSocketTicket(ticket: string): RunnerIdentity | null {
        this.prune()
        const key = hashTicket(ticket)
        const record = this.socketTickets.get(key)
        this.socketTickets.delete(key)
        if (!record || record.expiresAt <= Date.now()) return null
        const binding = this.store.workspaces.getActiveRunnerKeyBinding(
            record.workspaceId,
            record.accessKeyId,
        )
        if (!binding
            || binding.boundMachineId !== record.machineId
            || !constantTimeEquals(binding.publicKeyThumbprint, record.publicKeyThumbprint)) return null
        return {
            workspaceId: record.workspaceId,
            namespace: record.namespace,
            accessKeyId: record.accessKeyId,
            machineId: record.machineId,
            publicKeyThumbprint: record.publicKeyThumbprint,
        }
    }

    private async verifyProof(input: {
        proof: string
        method: string
        targetUrl: string
        expectedThumbprint: string
        accessToken: string
    }): Promise<boolean> {
        try {
            const protectedHeader = decodeProtectedHeader(input.proof)
            if (protectedHeader.alg !== 'ES256'
                || protectedHeader.typ?.toLowerCase() !== 'dpop+jwt') return false
            const publicKey = validatePublicJwk(protectedHeader.jwk)
            if (!publicKey
                || !constantTimeEquals(publicKey.thumbprint, input.expectedThumbprint)) return false
            const verified = await jwtVerify(input.proof, publicKey.key, {
                algorithms: ['ES256'],
            })
            const payload = proofPayloadSchema.safeParse(verified.payload)
            if (!payload.success) return false
            const nowSeconds = Math.floor(Date.now() / 1000)
            if (Math.abs(payload.data.iat - nowSeconds) > DPOP_CLOCK_SKEW_SECONDS) return false
            if (payload.data.htm.toUpperCase() !== input.method.toUpperCase()) return false
            const proofHtu = normalizeHtu(payload.data.htu)
            const targetHtu = normalizeHtu(input.targetUrl)
            if (!proofHtu || !targetHtu || proofHtu !== targetHtu) return false
            if (!constantTimeEquals(payload.data.ath, hashToken(input.accessToken))) return false
            this.prune()
            const replayKey = `${publicKey.thumbprint}:${payload.data.jti}`
            if (this.proofReplay.has(replayKey)) return false
            this.proofReplay.set(
                replayKey,
                (payload.data.iat + DPOP_CLOCK_SKEW_SECONDS * 2) * 1000,
            )
            return true
        } catch {
            return false
        }
    }

    private prune(): void {
        const now = Date.now()
        for (const [key, expiresAt] of this.proofReplay) {
            if (expiresAt <= now) this.proofReplay.delete(key)
        }
        for (const [key, record] of this.socketTickets) {
            if (record.expiresAt <= now) this.socketTickets.delete(key)
        }
    }
}

const runnerAuthServices = new WeakMap<Store, RunnerAuthService>()

export function getRunnerAuthService(store: Store, jwtSecret: Uint8Array): RunnerAuthService {
    const existing = runnerAuthServices.get(store)
    if (existing) return existing
    const service = new RunnerAuthService(store, jwtSecret)
    runnerAuthServices.set(store, service)
    return service
}

export function buildRunnerDpopTarget(publicUrl: string, path: string): string {
    return normalizeHtu(new URL(path, publicUrl).toString())!
}
