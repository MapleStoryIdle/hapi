import { describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import type { LocalServiceManager } from '../../localServices/manager'
import { createLocalServiceRoutes } from './localServices'

function fixture(options: { sessionDenied?: boolean; machineNamespace?: string; offline?: boolean; nativeMissing?: boolean; disabled?: boolean } = {}) {
    const open = mock(async () => ({ url: 'https://id.preview.example.com/open#ticket', expiresAt: 123 }))
    const getCodexLocalSessionStatus = mock(async () => ({ success: !options.nativeMissing }))
    const engine = {
        resolveSessionAccess: () => options.sessionDenied ? { ok: false, reason: 'access-denied' }
            : { ok: true, sessionId: 'managed', session: { metadata: { machineId: 'bound-runner' } } },
        getMachine: (id: string) => ({ id, namespace: options.machineNamespace ?? 'owner', active: !options.offline }),
        getCodexLocalSessionStatus
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'owner'); c.set('userId', 7); await next() })
    app.route('/api', createLocalServiceRoutes(() => engine, () => options.disabled ? null : { open } as unknown as LocalServiceManager))
    const send = (source: unknown, url = 'http://localhost:54321/path?q=1#part') => app.request('/api/local-services/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, url })
    })
    return { send, open, getCodexLocalSessionStatus }
}

describe('local service API authorization', () => {
    it('binds managed links to the session runner, never a browser-selected machine', async () => {
        const f = fixture()
        expect((await f.send({ type: 'session', sessionId: 'managed' })).status).toBe(200)
        expect(f.open).toHaveBeenCalledWith({ namespace: 'owner', userId: 7 }, 'bound-runner', { type: 'session', sessionId: 'managed' }, 'http://localhost:54321/path?q=1#part')
        expect(f.getCodexLocalSessionStatus).not.toHaveBeenCalled()
        expect((await f.send({ type: 'session', sessionId: 'managed', machineId: 'wrong-runner' })).status).toBe(400)
    })

    it('verifies a native source without importing, resuming, or sending to Codex', async () => {
        const f = fixture()
        const source = { type: 'native-codex', sessionId: 'native', machineId: 'native-runner' }
        expect((await f.send(source)).status).toBe(200)
        expect(f.getCodexLocalSessionStatus).toHaveBeenCalledWith('native-runner', 'native')
        expect(f.open).toHaveBeenCalledWith({ namespace: 'owner', userId: 7 }, 'native-runner', source, 'http://localhost:54321/path?q=1#part')
    })

    it.each([
        [{ sessionDenied: true }, 403], [{ machineNamespace: 'someone-else' }, 403],
        [{ offline: true }, 409], [{ disabled: true }, 503]
    ] as const)('refuses invalid access before creating a tunnel: %j', async (options, status) => {
        const f = fixture(options)
        expect((await f.send({ type: 'session', sessionId: 'managed' })).status).toBe(status)
        expect(f.open).not.toHaveBeenCalled()
    })

    it('rejects missing native sessions, non-loopback URLs, and oversized payloads', async () => {
        const f = fixture({ nativeMissing: true })
        expect((await f.send({ type: 'native-codex', sessionId: 'missing', machineId: 'native-runner' })).status).toBe(404)
        expect((await f.send({ type: 'session', sessionId: 'managed' }, 'http://169.254.169.254/')).status).toBe(400)
        expect((await f.send({ type: 'session', sessionId: 'x'.repeat(20_000) })).status).toBe(413)
        expect(f.open).not.toHaveBeenCalled()
    })
})
