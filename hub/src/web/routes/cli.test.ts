import { beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import { createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'

function createApp(engine: Partial<SyncEngine>) {
    const app = new Hono()
    app.route('/cli', createCliRoutes(() => engine as SyncEngine))
    return app
}

function authHeaders() {
    return {
        authorization: 'Bearer test-token'
    }
}

beforeAll(async () => {
    const config = await createConfiguration()
    config._setCliApiToken('test-token', 'env', false)
})

describe('cli resume routes', () => {
    it('returns local resumable sessions', async () => {
        const app = createApp({
            listLocalResumableSessions: () => [{
                sessionId: 'session-1',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 123
            }]
        } as never)

        const response = await app.request('/cli/sessions/resumable?machineId=machine-1', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            sessions: [{
                sessionId: 'session-1',
                flavor: 'codex',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: 'codex-thread-1',
                updatedAt: 123
            }]
        })
    })

    it('returns a local resume target', async () => {
        const app = createApp({
            resolveLocalResumeTarget: () => ({
                type: 'success',
                target: {
                    sessionId: 'session-1',
                    flavor: 'claude',
                    directory: '/tmp/project',
                    machineId: 'machine-1',
                    active: false,
                    thinking: false,
                    controlledByUser: false,
                    agentSessionId: '11111111-1111-4111-8111-111111111111'
                }
            })
        } as never)

        const response = await app.request('/cli/sessions/session-1/resume-target', {
            headers: authHeaders()
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            target: {
                sessionId: 'session-1',
                flavor: 'claude',
                directory: '/tmp/project',
                machineId: 'machine-1',
                active: false,
                thinking: false,
                controlledByUser: false,
                agentSessionId: '11111111-1111-4111-8111-111111111111'
            }
        })
    })

    it('returns handoff errors with status codes', async () => {
        const app = createApp({
            handoffSessionToLocal: async () => ({
                type: 'error',
                message: 'Session is already controlled by a local terminal',
                code: 'already_local'
            })
        } as never)

        const response = await app.request('/cli/sessions/session-1/handoff-local', {
            method: 'POST',
            headers: authHeaders()
        })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({
            error: 'Session is already controlled by a local terminal',
            code: 'already_local'
        })
    })
})

describe('cli public share routes', () => {
    it('publishes on the share endpoint and revokes it without retaining the artifact endpoint', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { Store } = await import('../../store')
        const { ArtifactService } = await import('../../artifacts/service')

        const dir = await mkdtemp(join(tmpdir(), 'hapi-share-cli-route-'))
        const store = new Store(':memory:')
        const service = new ArtifactService(store, dir)
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => ({}) as SyncEngine, undefined, service))
        const headers = {
            ...authHeaders(),
            'content-type': 'application/octet-stream',
            'x-hapi-share-filename': Buffer.from('note.md', 'utf8').toString('base64url'),
            'x-hapi-share-expires': '300'
        }

        try {
            const published = await app.request('/cli/shares', { method: 'POST', headers, body: '# safe' })
            expect(published.status).toBe(201)
            const value = await published.json() as { id: string; url: string }
            expect(value.url).toContain('/s/')
            const token = new URL(value.url).pathname.split('/').at(-1)
            expect(token).toBeTruthy()
            expect(service.readPublic(token!)).not.toBeNull()
            expect(store.artifacts.findActive(value.id, 'default')?.publicUrl).toBe(value.url)

            const revoked = await app.request(`/cli/shares/${value.id}`, { method: 'DELETE', headers: authHeaders() })
            expect(revoked.status).toBe(200)
            expect(await revoked.json()).toEqual({ ok: true, cleanupPending: false })
            expect(service.readPublic(token!)).toBeNull()
            expect((await app.request('/cli/artifacts', { method: 'POST', headers })).status).toBe(404)
        } finally {
            store.close()
            await rm(dir, { recursive: true, force: true })
        }
    })
})
