import { z } from 'zod'

export const LOCAL_SERVICE_LEASE_MS = 30 * 60 * 1_000
export const LOCAL_SERVICE_MAX_CONNECTIONS = 24
export const LOCAL_SERVICE_MAX_PER_MACHINE = 5

export type LocalServiceTarget = {
    protocol: 'http:' | 'https:'
    hostname: 'localhost' | '127.0.0.1' | '[::1]'
    port: number
    path: string
    hash: string
    origin: string
}

/** Literal loopback HTTP URLs only. Never resolve arbitrary hostnames or userinfo. */
export function parseLocalServiceUrl(value: string): LocalServiceTarget | null {
    if (value.length > 8_192 || /[\x00-\x20\x7f\\]/.test(value)) return null
    const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(?=[/?#]|$)/i.exec(value)
    if (!match) return null
    try {
        const url = new URL(value)
        const port = Number(match[3] ?? (url.protocol === 'https:' ? 443 : 80))
        if (port < 1 || port > 65_535 || url.username || url.password) return null
        return {
            protocol: url.protocol as LocalServiceTarget['protocol'],
            hostname: url.hostname as LocalServiceTarget['hostname'],
            port,
            path: `${url.pathname}${url.search}`,
            hash: url.hash,
            origin: url.origin
        }
    } catch {
        return null
    }
}

export const LocalServiceSourceSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('session'), sessionId: z.string().min(1).max(200) }).strict(),
    z.object({ type: z.literal('native-codex'), sessionId: z.string().min(1).max(200), machineId: z.string().min(1).max(200) }).strict()
])
export type LocalServiceSource = z.infer<typeof LocalServiceSourceSchema>

export const OpenLocalServiceSchema = z.object({
    source: LocalServiceSourceSchema,
    url: z.string().max(8_192).refine((value) => parseLocalServiceUrl(value) !== null, 'Expected a loopback HTTP URL')
}).strict()
export type OpenLocalServiceRequest = z.infer<typeof OpenLocalServiceSchema>
export type OpenLocalServiceResponse = { url: string; expiresAt: number }

export const LocalServiceTunnelRequestSchema = z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    secret: z.string().regex(/^[a-f0-9]{64}$/),
    sshHost: z.string().min(1).max(253),
    sshPort: z.number().int().min(1).max(65_535),
    remotePort: z.number().int().min(1).max(65_535),
    hostFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    targetUrl: z.string().max(8_192).refine((value) => parseLocalServiceUrl(value) !== null),
    expiresAt: z.number().int().positive()
}).strict()
export type LocalServiceTunnelRequest = z.infer<typeof LocalServiceTunnelRequestSchema>
export type LocalServiceTunnelResponse = { ok: true } | { ok: false; error: string }

export const LOCAL_SERVICE_RPC = 'localService.openTunnel'
