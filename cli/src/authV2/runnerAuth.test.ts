import { describe, expect, it, vi } from 'vitest'
import { DpopHubAuth } from './runnerAuth'
import { dpopAccessTokenHash } from './dpop'
import { generateRunnerKeyMaterial, type ApprovedRunnerCredential } from './credentials'

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
}

function decodePayload(proof: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
}

function approvedCredential(): ApprovedRunnerCredential {
    return {
        version: 1,
        status: 'approved',
        hubUrl: 'https://hub.example.test',
        ...generateRunnerKeyMaterial(),
        machineId: 'machine-1',
        displayName: 'Desk',
        workspaceId: 'workspace-1',
        accessKeyId: 'key-1',
        approvedAt: 1
    }
}

describe('DpopHubAuth', () => {
    it('exchanges spr once and creates fresh ath-bound REST proofs', async () => {
        const credential = approvedCredential()
        const fetcher = vi.fn(async () => response({
            accessToken: 'access-token-that-is-long-enough-123456',
            tokenType: 'DPoP',
            expiresIn: 300
        })) as unknown as typeof fetch
        const auth = new DpopHubAuth(credential, fetcher, () => 1_710_000_000_000)

        const first = await auth.restHeaders('GET', 'https://hub.example.test/cli/sessions?limit=1')
        const second = await auth.restHeaders('POST', 'https://hub.example.test/cli/machines')

        expect(fetcher).toHaveBeenCalledOnce()
        const [exchangeUrl, exchangeInit] = vi.mocked(fetcher).mock.calls[0]!
        expect(String(exchangeUrl)).toBe('https://hub.example.test/api/v2/runner/token')
        expect(exchangeInit?.headers).toMatchObject({ Authorization: `DPoP ${credential.runnerToken}` })
        expect(JSON.parse(String(exchangeInit?.body))).toEqual({ machineId: 'machine-1' })
        expect(decodePayload((exchangeInit?.headers as Record<string, string>).DPoP)).toMatchObject({
            htm: 'POST',
            htu: 'https://hub.example.test/api/v2/runner/token',
            ath: dpopAccessTokenHash(credential.runnerToken)
        })
        expect(first.Authorization).toBe('DPoP access-token-that-is-long-enough-123456')
        expect(decodePayload(first.DPoP)).toMatchObject({
            htm: 'GET',
            htu: 'https://hub.example.test/cli/sessions',
            ath: dpopAccessTokenHash('access-token-that-is-long-enough-123456')
        })
        expect(second.DPoP).not.toBe(first.DPoP)
    })

    it('requests a new one-time ticket for every socket auth callback', async () => {
        const credential = approvedCredential()
        let ticket = 0
        const fetcher = vi.fn(async (input: string | URL | Request) => {
            const url = String(input)
            if (url.endsWith('/runner/token')) {
                return response({
                    accessToken: 'access-token-that-is-long-enough-123456',
                    tokenType: 'DPoP',
                    expiresIn: 300
                })
            }
            ticket += 1
            return response({ ticket: `socket-ticket-${ticket}-${'x'.repeat(32)}`, expiresIn: 30 })
        }) as unknown as typeof fetch
        const auth = new DpopHubAuth(credential, fetcher)
        const socketAuth = auth.socketAuth({ clientType: 'machine-scoped', machineId: 'machine-1' })
        if (typeof socketAuth !== 'function') throw new Error('Expected asynchronous socket auth')

        const invoke = () => new Promise<Record<string, unknown>>(resolve => socketAuth(resolve))
        await expect(invoke()).resolves.toMatchObject({ ticket: `socket-ticket-1-${'x'.repeat(32)}` })
        await expect(invoke()).resolves.toMatchObject({ ticket: `socket-ticket-2-${'x'.repeat(32)}` })

        expect(fetcher).toHaveBeenCalledTimes(3)
        const ticketCalls = vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/runner/socket-tickets'))
        expect(ticketCalls).toHaveLength(2)
        for (const [, init] of ticketCalls) {
            expect(init?.headers).toMatchObject({ Authorization: 'DPoP access-token-that-is-long-enough-123456' })
            expect(decodePayload((init?.headers as Record<string, string>).DPoP).ath)
                .toBe(dpopAccessTokenHash('access-token-that-is-long-enough-123456'))
        }
    })
})
