import { describe, expect, it, vi } from 'vitest'
import {
    approveRunnerDeviceAuthorizationWithWebToken,
    createRunnerDeviceAuthorization,
    pollRunnerDeviceAuthorization,
    registerWorkspace
} from './client'

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })
}

describe('auth-v2 client', () => {
    it('uses the workspace registration contract', async () => {
        const fetcher = vi.fn(async () => jsonResponse({
            workspace: { id: 'w1', name: 'Home', dataNamespace: 'n1', createdAt: 1 }
        }, 201)) as unknown as typeof fetch

        await registerWorkspace(
            'https://hub.example.test/',
            { name: 'Home', webToken: `spw${'a'.repeat(43)}` },
            'enrollment-secret',
            fetcher
        )

        const [url, init] = vi.mocked(fetcher).mock.calls[0]!
        expect(String(url)).toBe('https://hub.example.test/api/v2/workspaces/register')
        expect(JSON.parse(String(init?.body))).toEqual({ name: 'Home', webToken: `spw${'a'.repeat(43)}` })
        expect(new Headers(init?.headers).get('x-hapi-registration-secret')).toBe('enrollment-secret')
    })

    it('serializes the public JWK expected by the Hub device endpoint', async () => {
        const fetcher = vi.fn(async () => jsonResponse({
            deviceCode: 'd'.repeat(43),
            userCode: '0123ABCD',
            verificationUri: 'https://hub.example.test/pair',
            expiresIn: 600,
            interval: 5
        }, 201)) as unknown as typeof fetch
        const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' }

        await createRunnerDeviceAuthorization('https://hub.example.test', {
            runnerToken: `spr${'a'.repeat(43)}`,
            machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb',
            displayName: 'runner',
            publicJwk,
            publicKeyThumbprint: 'b'.repeat(43)
        }, fetcher)

        const [, init] = vi.mocked(fetcher).mock.calls[0]!
        expect(JSON.parse(String(init?.body))).toMatchObject({ publicJwk: JSON.stringify(publicJwk) })
    })

    it('parses an approved device response', async () => {
        const fetcher = vi.fn(async () => jsonResponse({
            status: 'approved',
            workspaceId: 'w1',
            accessKeyId: 'k1',
            machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb'
        })) as unknown as typeof fetch

        await expect(pollRunnerDeviceAuthorization('https://hub.example.test', 'd'.repeat(43), fetcher))
            .resolves.toMatchObject({ status: 'approved', workspaceId: 'w1' })
    })

    it('approves installer pairing with the supplied Web credential', async () => {
        const fetcher = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch
        const webToken = `spw${'w'.repeat(43)}`

        await approveRunnerDeviceAuthorizationWithWebToken(
            'https://hub.example.test',
            '0123ABCD',
            webToken,
            fetcher
        )

        const [url, init] = vi.mocked(fetcher).mock.calls[0]!
        expect(String(url)).toBe('https://hub.example.test/api/v2/runner/device-authorizations/0123ABCD/approve-with-web-token')
        expect(JSON.parse(String(init?.body))).toEqual({ webToken })
    })
})
