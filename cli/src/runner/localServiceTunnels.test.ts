import { describe, expect, it } from 'vitest'
import { LOCAL_SERVICE_LEASE_MS } from '@hapi/protocol/localServices'
import { LocalServiceTunnels } from './localServiceTunnels'

function input() {
    return {
        id: 'a'.repeat(32), secret: 'b'.repeat(64), hostFingerprint: 'c'.repeat(64),
        sshHost: '127.0.0.1', sshPort: 8320, remotePort: 40000,
        targetUrl: 'http://localhost:8317', expiresAt: Date.now() + LOCAL_SERVICE_LEASE_MS
    }
}

describe('Runner local service guardrails', () => {
    it('refuses control ports before connecting to SSH or a local service', async () => {
        const runner = new LocalServiceTunnels(() => [8317])
        expect(await runner.open(input())).toEqual({ ok: false, error: 'The runner control port cannot be forwarded' })
        runner.dispose()
    })

    it.each(['http://10.0.0.1:3000', 'http://localhost.evil.example:3000', 'http://user@127.0.0.1:3000', 'ssh://localhost:22'])('refuses unsafe targets: %s', async (targetUrl) => {
        const runner = new LocalServiceTunnels()
        expect((await runner.open({ ...input(), targetUrl })).ok).toBe(false)
        runner.dispose()
    })

    it('refuses expired, overlong, and malformed leases without network access', async () => {
        const runner = new LocalServiceTunnels()
        for (const overrides of [{ expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + LOCAL_SERVICE_LEASE_MS * 2 }, { secret: 'short' }, { remotePort: 0 }]) {
            expect((await runner.open({ ...input(), ...overrides })).ok).toBe(false)
        }
        runner.dispose()
    })
})
