import { afterEach, describe, expect, it } from 'bun:test'
import { LOCAL_SERVICE_LEASE_MS } from '@hapi/protocol/localServices'
import { localServiceSocketFixture, type LocalServiceSocketFixture } from './socketTransport.fixture'

let fixture: LocalServiceSocketFixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })
const request = () => ({ id: 'a'.repeat(32), targetUrl: 'http://127.0.0.1:1933', expiresAt: Date.now() + LOCAL_SERVICE_LEASE_MS })

describe('machine-bound local service socket', () => {
    it('rejects a different namespace, machine and non-machine client before issuing RPC', async () => {
        fixture = await localServiceSocketFixture()
        await expect(fixture.openTunnel('machine', request(), 'other')).rejects.toThrow('unavailable')
        await expect(fixture.openTunnel('other-machine', request())).rejects.toThrow('unavailable')
        fixture.serverSocket.handshake.auth.clientType = 'session-scoped'
        await expect(fixture.openTunnel('machine', request())).rejects.toThrow('unavailable')
    })

    it('releases Runner capacity immediately and rejects control-port forwarding', async () => {
        fixture = await localServiceSocketFixture('machine', () => [8318])
        await expect(fixture.openTunnel('machine', { ...request(), targetUrl: 'http://localhost:8318' })).rejects.toThrow('refused')
        for (let index = 0; index < 8; index++) {
            const tunnel = await fixture.openTunnel('machine', { ...request(), id: index.toString(16).padStart(32, '0') })
            tunnel.close()
            expect(tunnel.closed).toBe(true)
        }
    })

    it('rejects disconnected sockets and duplicate lease identities without replacing an open lease', async () => {
        fixture = await localServiceSocketFixture()
        const tunnel = await fixture.openTunnel('machine', request())
        await expect(fixture.openTunnel('machine', request())).rejects.toThrow('already exists')
        expect(tunnel.closed).toBe(false)
        const disconnected = new Promise<void>((resolve) => fixture!.serverSocket.once('disconnect', () => resolve()))
        fixture.client.disconnect()
        await disconnected
        expect(tunnel.closed).toBe(true)
        await expect(fixture.openTunnel('machine', request())).rejects.toThrow('unavailable')
    })
})
