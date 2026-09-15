import { z } from 'zod'
import { buildHubRequestHeaders } from '@/api/hubExtraHeaders'
import { normalizeHubUrl, type RunnerPublicJwk } from './credentials'

const workspaceSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    dataNamespace: z.string().min(1),
    createdAt: z.number()
}).passthrough()

const registerResponseSchema = z.object({ workspace: workspaceSchema }).strict()

const deviceAuthorizationResponseSchema = z.object({
    deviceCode: z.string().min(32),
    userCode: z.string().min(1),
    verificationUri: z.string().url(),
    expiresIn: z.number().int().positive(),
    interval: z.number().positive()
}).strict()

const pollResponseSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('pending') }).passthrough(),
    z.object({ status: z.literal('slow_down'), retryAfter: z.number().positive().optional() }).passthrough(),
    z.object({
        status: z.literal('approved'),
        workspaceId: z.string().min(1),
        accessKeyId: z.string().min(1),
        machineId: z.string().min(1).max(256)
    }).passthrough(),
    z.object({ status: z.literal('denied') }).passthrough(),
    z.object({ status: z.literal('expired') }).passthrough()
])
const okResponseSchema = z.object({ ok: z.literal(true) }).strict()

export type WorkspaceRegistration = z.infer<typeof registerResponseSchema>
export type DeviceAuthorization = z.infer<typeof deviceAuthorizationResponseSchema>
export type DeviceAuthorizationPoll = z.infer<typeof pollResponseSchema>

async function postJson<T>(
    hubUrl: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    fetcher: typeof fetch,
    extraHeaders: Record<string, string> = {}
): Promise<T> {
    const normalizedHubUrl = normalizeHubUrl(hubUrl)
    const response = await fetcher(new URL(path.replace(/^\/+/, ''), `${normalizedHubUrl}/`), {
        method: 'POST',
        headers: buildHubRequestHeaders({
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...extraHeaders
        }),
        body: JSON.stringify(body)
    })
    const raw = await response.text()
    if (!response.ok) {
        let message = raw || response.statusText || `HTTP ${response.status}`
        try {
            const parsed = JSON.parse(raw) as { error?: unknown }
            if (typeof parsed.error === 'string') message = parsed.error
        } catch {}
        throw new Error(`Hub request failed (${response.status}): ${message}`)
    }
    let json: unknown
    try {
        json = JSON.parse(raw)
    } catch {
        throw new Error('Hub returned invalid JSON')
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new Error('Hub returned an invalid auth-v2 response')
    return parsed.data
}

export async function registerWorkspace(
    hubUrl: string,
    input: { name: string; webToken: string },
    registrationSecret?: string,
    fetcher: typeof fetch = fetch
): Promise<WorkspaceRegistration> {
    return await postJson(
        hubUrl,
        '/api/v2/workspaces/register',
        input,
        registerResponseSchema,
        fetcher,
        registrationSecret ? { 'x-hapi-registration-secret': registrationSecret } : {}
    )
}

export async function createRunnerDeviceAuthorization(
    hubUrl: string,
    input: {
        runnerToken: string
        machineId: string
        displayName: string
        publicJwk: RunnerPublicJwk
        publicKeyThumbprint: string
    },
    fetcher: typeof fetch = fetch
): Promise<DeviceAuthorization> {
    return await postJson(hubUrl, '/api/v2/runner/device-authorizations', {
        ...input,
        publicJwk: JSON.stringify(input.publicJwk)
    }, deviceAuthorizationResponseSchema, fetcher)
}

export async function pollRunnerDeviceAuthorization(
    hubUrl: string,
    deviceCode: string,
    fetcher: typeof fetch = fetch
): Promise<DeviceAuthorizationPoll> {
    return await postJson(hubUrl, '/api/v2/runner/device-authorizations/token', { deviceCode }, pollResponseSchema, fetcher)
}

export async function approveRunnerDeviceAuthorizationWithWebToken(
    hubUrl: string,
    userCode: string,
    webToken: string,
    fetcher: typeof fetch = fetch
): Promise<void> {
    await postJson(
        hubUrl,
        `/api/v2/runner/device-authorizations/${encodeURIComponent(userCode)}/approve-with-web-token`,
        { webToken },
        okResponseSchema,
        fetcher
    )
}
