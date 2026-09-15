import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { configuration } from '@/configuration'

const publicJwkSchema = z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(1),
    y: z.string().min(1)
}).strict()

const privateJwkSchema = publicJwkSchema.extend({
    d: z.string().min(1)
}).strict()

const pendingCredentialSchema = z.object({
    version: z.literal(1),
    status: z.literal('pending'),
    hubUrl: z.string().url(),
    runnerToken: z.string().regex(/^spr[A-Za-z0-9_-]{43}$/),
    machineId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(100),
    publicJwk: publicJwkSchema,
    privateJwk: privateJwkSchema,
    publicKeyThumbprint: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    deviceCode: z.string().min(32),
    userCode: z.string().min(1),
    expiresAt: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive()
}).strict()

const approvedCredentialSchema = pendingCredentialSchema.omit({
    deviceCode: true,
    userCode: true,
    expiresAt: true,
    pollIntervalMs: true,
    status: true
}).extend({
    status: z.literal('approved'),
    workspaceId: z.string().min(1),
    accessKeyId: z.string().min(1),
    approvedAt: z.number().int().positive()
}).strict()

export type RunnerPublicJwk = z.infer<typeof publicJwkSchema>
export type RunnerPrivateJwk = z.infer<typeof privateJwkSchema>
export type PendingRunnerCredential = z.infer<typeof pendingCredentialSchema>
export type ApprovedRunnerCredential = z.infer<typeof approvedCredentialSchema>
export type RunnerCredential = PendingRunnerCredential | ApprovedRunnerCredential

export function normalizeHubUrl(raw: string): string {
    const url = new URL(raw)
    if (url.username || url.password) throw new Error('Hub URL must not contain embedded credentials')
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('Auth-v2 requires HTTPS (HTTP is allowed only for localhost)')
    }
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
}

function credentialsDirectory(): string {
    return join(configuration.happyHomeDir, 'credentials-v2')
}

export function runnerCredentialPath(hubUrl: string): string {
    const hubId = createHash('sha256').update(normalizeHubUrl(hubUrl)).digest('hex')
    return join(credentialsDirectory(), `runner-${hubId}.json`)
}

export function generateRunnerKeyMaterial(): {
    runnerToken: string
    publicJwk: RunnerPublicJwk
    privateJwk: RunnerPrivateJwk
    publicKeyThumbprint: string
} {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicJwk = publicJwkSchema.parse(pair.publicKey.export({ format: 'jwk' }))
    const privateJwk = privateJwkSchema.parse(pair.privateKey.export({ format: 'jwk' }))
    const canonicalPublicJwk = JSON.stringify({
        crv: publicJwk.crv,
        kty: publicJwk.kty,
        x: publicJwk.x,
        y: publicJwk.y
    })
    return {
        runnerToken: `spr${randomBytes(32).toString('base64url')}`,
        publicJwk,
        privateJwk,
        publicKeyThumbprint: createHash('sha256').update(canonicalPublicJwk).digest('base64url')
    }
}

export async function readRunnerCredential(hubUrl: string): Promise<RunnerCredential | null> {
    try {
        const raw = await readFile(runnerCredentialPath(hubUrl), 'utf8')
        return z.union([pendingCredentialSchema, approvedCredentialSchema]).parse(JSON.parse(raw))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error(`Unable to read runner credential for ${normalizeHubUrl(hubUrl)}`, { cause: error })
    }
}

export async function writeRunnerCredential(credential: RunnerCredential): Promise<void> {
    const parsed = z.union([pendingCredentialSchema, approvedCredentialSchema]).parse(credential)
    const directory = credentialsDirectory()
    const path = runnerCredentialPath(parsed.hubUrl)
    const temporaryPath = `${path}.${process.pid}.tmp`
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: 0o700 })
    await chmod(configuration.happyHomeDir, 0o700).catch(() => {})
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700).catch(() => {})
    try {
        await writeFile(temporaryPath, JSON.stringify(parsed, null, 4), { mode: 0o600 })
        await chmod(temporaryPath, 0o600).catch(() => {})
        await rename(temporaryPath, path)
        await chmod(path, 0o600).catch(() => {})
    } finally {
        await unlink(temporaryPath).catch(() => {})
    }
}
