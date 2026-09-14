import { z } from 'zod'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { createDpopProof } from './dpop'
import {
    normalizeHubUrl,
    readRunnerCredential,
    type ApprovedRunnerCredential
} from './credentials'

const runnerAccessResponseSchema = z.object({
    accessToken: z.string().min(32),
    tokenType: z.literal('DPoP'),
    expiresIn: z.number().int().positive()
}).strict()

const socketTicketResponseSchema = z.object({
    ticket: z.string().min(32),
    expiresIn: z.number().int().positive()
}).strict()

export type SocketIdentity = {
    clientType: 'session-scoped' | 'machine-scoped'
    sessionId?: string
    machineId?: string
}

export type SocketAuth = Record<string, unknown> | ((callback: (auth: Record<string, unknown>) => void) => void)

export interface HubAuth {
    restHeaders(method: string, url: string): Promise<Record<string, string>>
    socketAuth(identity: SocketIdentity): SocketAuth
}

async function parseJsonResponse<T>(response: Response, schema: z.ZodType<T>, operation: string): Promise<T> {
    const raw = await response.text()
    if (!response.ok) {
        let message = raw || response.statusText || `HTTP ${response.status}`
        try {
            const parsed = JSON.parse(raw) as { error?: unknown }
            if (typeof parsed.error === 'string') message = parsed.error
        } catch {}
        throw new Error(`${operation} failed (${response.status}): ${message}`)
    }
    let body: unknown
    try {
        body = JSON.parse(raw)
    } catch {
        throw new Error(`${operation} returned invalid JSON`)
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new Error(`${operation} returned an invalid response`)
    return parsed.data
}

class LegacyHubAuth implements HubAuth {
    constructor(private readonly token: string) {}

    async restHeaders(): Promise<Record<string, string>> {
        return { Authorization: `Bearer ${this.token}` }
    }

    socketAuth(identity: SocketIdentity): SocketAuth {
        return { token: this.token, ...identity }
    }
}

class SprCompatibilityHubAuth implements HubAuth {
    constructor(private readonly token: string, private readonly machineId: string) {}

    async restHeaders(): Promise<Record<string, string>> {
        return {
            Authorization: `Bearer ${this.token}`,
            'x-hapi-auth-compat': 'spr',
            'x-hapi-machine-id': this.machineId
        }
    }

    socketAuth(identity: SocketIdentity): SocketAuth {
        return {
            token: this.token,
            ...identity,
            machineId: this.machineId,
            compatibility: 'spr'
        }
    }
}

export class DpopHubAuth implements HubAuth {
    private accessToken: { value: string; expiresAt: number } | null = null
    private exchangeInFlight: Promise<string> | null = null

    constructor(
        private readonly credential: ApprovedRunnerCredential,
        private readonly fetcher: typeof fetch = fetch,
        private readonly now: () => number = Date.now
    ) {}

    private endpoint(path: string): string {
        return new URL(path.replace(/^\/+/, ''), `${normalizeHubUrl(this.credential.hubUrl)}/`).toString()
    }

    private proof(method: string, url: string, token: string): string {
        return createDpopProof({
            method,
            url,
            accessToken: token,
            publicJwk: this.credential.publicJwk,
            privateJwk: this.credential.privateJwk,
            now: this.now()
        })
    }

    private async exchangeAccessToken(): Promise<string> {
        const url = this.endpoint('/api/v2/runner/token')
        const response = await this.fetcher(url, {
            method: 'POST',
            headers: buildHubRequestHeaders({
                Authorization: `DPoP ${this.credential.runnerToken}`,
                DPoP: this.proof('POST', url, this.credential.runnerToken),
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }),
            body: JSON.stringify({ machineId: this.credential.machineId })
        })
        const result = await parseJsonResponse(response, runnerAccessResponseSchema, 'Runner token exchange')
        this.accessToken = {
            value: result.accessToken,
            expiresAt: this.now() + result.expiresIn * 1_000
        }
        return result.accessToken
    }

    private async getAccessToken(): Promise<string> {
        if (this.accessToken && this.accessToken.expiresAt - this.now() > 15_000) {
            return this.accessToken.value
        }
        if (!this.exchangeInFlight) {
            this.exchangeInFlight = this.exchangeAccessToken().finally(() => {
                this.exchangeInFlight = null
            })
        }
        return await this.exchangeInFlight
    }

    async restHeaders(method: string, url: string): Promise<Record<string, string>> {
        const accessToken = await this.getAccessToken()
        return {
            Authorization: `DPoP ${accessToken}`,
            DPoP: this.proof(method, url, accessToken)
        }
    }

    private async createSocketTicket(): Promise<string> {
        const url = this.endpoint('/api/v2/runner/socket-tickets')
        const accessToken = await this.getAccessToken()
        const response = await this.fetcher(url, {
            method: 'POST',
            headers: buildHubRequestHeaders({
                Authorization: `DPoP ${accessToken}`,
                DPoP: this.proof('POST', url, accessToken),
                'Content-Type': 'application/json',
                Accept: 'application/json'
            }),
            body: '{}'
        })
        return (await parseJsonResponse(response, socketTicketResponseSchema, 'Socket ticket request')).ticket
    }

    socketAuth(identity: SocketIdentity): SocketAuth {
        return callback => {
            void this.createSocketTicket().then(
                ticket => callback({ ticket, ...identity }),
                () => callback({ ticket: '', ...identity })
            )
        }
    }
}

export function legacyHubAuth(token: string): HubAuth {
    return new LegacyHubAuth(token)
}

export function asHubAuth(value: string | HubAuth): HubAuth {
    return typeof value === 'string' ? legacyHubAuth(value) : value
}

export async function createHubAuth(token: string): Promise<HubAuth> {
    if (!/^spr[A-Za-z0-9_-]{43}$/.test(token)) return legacyHubAuth(token)
    const credential = await readRunnerCredential(configuration.apiUrl)
    if (credential?.status === 'approved' && credential.runnerToken === token) {
        configuration._setApiUrl(normalizeHubUrl(credential.hubUrl))
        return new DpopHubAuth(credential)
    }
    const machineId = (await readSettings()).machineId
    if (machineId) return new SprCompatibilityHubAuth(token, machineId)
    return legacyHubAuth(token)
}
