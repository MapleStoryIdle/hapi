import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir(): string {
            return state.home
        }
    }
}))

import {
    generateRunnerKeyMaterial,
    normalizeHubUrl,
    readRunnerCredential,
    runnerCredentialPath,
    writeRunnerCredential
} from './credentials'

describe('auth-v2 runner credentials', () => {
    beforeEach(async () => {
        state.home = await mkdtemp(join(tmpdir(), 'hapi-auth-v2-'))
    })

    afterEach(async () => {
        await rm(state.home, { recursive: true, force: true })
    })

    it('generates a canonical P-256 identity and spr token', () => {
        const generated = generateRunnerKeyMaterial()

        expect(generated.runnerToken).toMatch(/^spr[A-Za-z0-9_-]{43}$/)
        expect(generated.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
        expect(generated.privateJwk.d).toBeTruthy()
        expect(generated.privateJwk.x).toBe(generated.publicJwk.x)
        expect(generated.privateJwk.y).toBe(generated.publicJwk.y)
        expect(generated.publicKeyThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('stores an approved credential in dedicated 0700/0600 paths', async () => {
        const hubUrl = 'https://hub.example.test/'
        const generated = generateRunnerKeyMaterial()
        const credential = {
            version: 1 as const,
            status: 'approved' as const,
            hubUrl: normalizeHubUrl(hubUrl),
            ...generated,
            machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb',
            displayName: 'test runner',
            workspaceId: 'workspace-1',
            accessKeyId: 'access-key-1',
            approvedAt: 1
        }

        await writeRunnerCredential(credential)

        const path = runnerCredentialPath(hubUrl)
        expect(await readRunnerCredential(hubUrl)).toEqual(credential)
        expect((await stat(join(state.home, 'credentials-v2'))).mode & 0o777).toBe(0o700)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect(await readFile(path, 'utf8')).toContain(generated.privateJwk.d)
    })

    it('rejects cleartext remote hubs but permits localhost development', () => {
        expect(() => normalizeHubUrl('http://hub.example.test')).toThrow('requires HTTPS')
        expect(normalizeHubUrl('http://127.0.0.1:8318/')).toBe('http://127.0.0.1:8318')
    })
})
