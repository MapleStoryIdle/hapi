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
            expect(store.kanbanTasks.find(value.id)?.sourceContext).toBeNull()

            const revoked = await app.request(`/cli/shares/${value.id}`, { method: 'DELETE', headers: authHeaders() })
            expect(revoked.status).toBe(200)
            expect(await revoked.json()).toEqual({ ok: true })
            expect(service.readPublic(token!)).toBeNull()
            expect((await app.request('/cli/artifacts', { method: 'POST', headers })).status).toBe(404)
        } finally {
            store.close()
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('validates and stores the optional owner-only source context headers', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { Store } = await import('../../store')
        const { ArtifactService } = await import('../../artifacts/service')
        const dir = await mkdtemp(join(tmpdir(), 'hapi-share-source-context-route-'))
        const store = new Store(':memory:')
        const service = new ArtifactService(store, dir)
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => ({}) as SyncEngine, undefined, service))
        const baseHeaders = {
            ...authHeaders(),
            'content-type': 'application/octet-stream',
            'x-hapi-share-filename': Buffer.from('note.md', 'utf8').toString('base64url'),
            'x-hapi-share-expires': '300'
        }
        try {
            const response = await app.request('/cli/shares', {
                method: 'POST',
                headers: {
                    ...baseHeaders,
                    'x-hapi-share-source-directory': Buffer.from('cafe\u0301', 'utf8').toString('base64url'),
                    'x-hapi-share-source-branch': Buffer.from('feature/kanban-timeline', 'utf8').toString('base64url')
                },
                body: '# safe'
            })
            expect(response.status).toBe(201)
            const { id } = await response.json() as { id: string }
            expect(store.kanbanTasks.find(id)?.sourceContext).toEqual({
                directoryName: 'café',
                gitBranch: 'feature/kanban-timeline'
            })

            const branchWithoutDirectory = await app.request('/cli/shares', {
                method: 'POST',
                headers: {
                    ...baseHeaders,
                    'x-hapi-share-source-branch': Buffer.from('feature/allowed-slash', 'utf8').toString('base64url')
                },
                body: '# safe'
            })
            expect(branchWithoutDirectory.status).toBe(400)

            const invalidDirectory = await app.request('/cli/shares', {
                method: 'POST',
                headers: {
                    ...baseHeaders,
                    'x-hapi-share-source-directory': Buffer.from('nested/path', 'utf8').toString('base64url')
                },
                body: '# safe'
            })
            expect(invalidDirectory.status).toBe(400)
        } finally {
            store.close()
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('binds a feedback task to a verified original native Codex session when --machine is explicit', async () => {
        const { mkdtemp, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { Store } = await import('../../store')
        const { ArtifactService } = await import('../../artifacts/service')
        const dir = await mkdtemp(join(tmpdir(), 'hapi-native-share-cli-route-'))
        const store = new Store(':memory:')
        const service = new ArtifactService(store, dir)
        const machine = { id: 'machine-1', active: true, metadata: { codexHome: '/Users/test/.codex' } }
        const engine = {
            getMachineByNamespace: (id: string) => id === 'machine-1' ? machine : undefined,
            readCodexLocalSession: async () => ({
                success: true,
                data: { session: { id: 'native-1', originator: null }, importedMessages: [] }
            }),
            getSessionsByNamespace: () => []
        }
        const app = new Hono()
        app.route('/cli', createCliRoutes(() => engine as unknown as SyncEngine, store, service))
        const headers = {
            ...authHeaders(),
            'content-type': 'application/octet-stream',
            'x-hapi-share-filename': Buffer.from('task.md', 'utf8').toString('base64url'),
            'x-hapi-share-expires': '300',
            'x-hapi-share-source-session': Buffer.from('native-1', 'utf8').toString('base64url'),
            'x-hapi-share-source-machine': Buffer.from('machine-1', 'utf8').toString('base64url'),
            'x-hapi-share-feedback': '1'
        }
        try {
            const response = await app.request('/cli/shares', { method: 'POST', headers, body: '# task' })
            expect(response.status).toBe(201)
            const { id } = await response.json() as { id: string }
            expect(store.kanbanTasks.find(id)?.source).toEqual({
                type: 'native-codex',
                machineId: 'machine-1',
                codexSessionId: 'native-1'
            })
        } finally {
            store.close()
            await rm(dir, { recursive: true, force: true })
        }
    })
})
