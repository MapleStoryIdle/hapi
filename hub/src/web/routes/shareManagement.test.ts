import { afterEach, describe, expect, test, vi } from 'vitest'
import { SignJWT } from 'jose'
import { Hono } from 'hono'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactService } from '../../artifacts/service'
import { KanbanFeedbackService } from '../../kanban/feedback'
import { Store } from '../../store'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createPublicFeedbackRoutes } from './feedback'
import { createShareManagementRoutes } from './shareManagement'

const JWT_SECRET = new TextEncoder().encode('share-management-test-secret')
const dirs: string[] = []

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authHeaders(namespace: string): Promise<Record<string, string>> {
    const token = await new SignJWT({ uid: 1, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(JWT_SECRET)
    return { authorization: `Bearer ${token}` }
}

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-share-management-'))
    dirs.push(dir)
    const store = new Store(':memory:')
    const service = new ArtifactService(store, dir)
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createShareManagementRoutes(store, service))
    return { app, dir, service, store }
}

describe('share management routes', () => {
    test('lists only active same-namespace shares and projects safe metadata', async () => {
        const { app, service, store } = await setup()
        try {
            expect((await app.request('http://hub/api/shares')).status).toBe(401)
            const later = service.publish({
                namespace: 'one',
                filename: 'later.md',
                expiresSeconds: 600,
                bytes: new TextEncoder().encode('later'),
                makePublicUrl: (token) => `https://example.test/s/${token}`
            })
            const sooner = service.publish({ namespace: 'one', filename: 'sooner.md', expiresSeconds: 300, bytes: new TextEncoder().encode('sooner') })
            service.publish({ namespace: 'two', filename: 'other.md', expiresSeconds: 300, bytes: new TextEncoder().encode('other') })
            service.publish({ namespace: 'one', filename: 'expired.md', expiresSeconds: -1, bytes: new TextEncoder().encode('expired') })
            const revoked = service.publish({ namespace: 'one', filename: 'revoked.md', expiresSeconds: 300, bytes: new TextEncoder().encode('revoked') })
            expect(service.revoke(revoked.artifact.id, 'one')).toEqual({ type: 'deleted' })

            const response = await app.request('http://hub/api/shares', { headers: await authHeaders('one') })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                shares: [
                    {
                        id: sooner.artifact.id,
                        filename: 'sooner.md',
                        size: 6,
                        createdAt: sooner.artifact.createdAt,
                        expiresAt: sooner.artifact.expiresAt,
                        sourceSessionId: null,
                        status: 'published',
                        feedback: null
                    },
                    {
                        id: later.artifact.id,
                        filename: 'later.md',
                        size: 5,
                        createdAt: later.artifact.createdAt,
                        expiresAt: later.artifact.expiresAt,
                        sourceSessionId: null,
                        status: 'published',
                        feedback: null
                    }
                ]
            })

            const otherNamespace = await app.request('http://hub/api/shares', { headers: await authHeaders('two') })
            expect(await otherNamespace.json()).toEqual({
                shares: [expect.objectContaining({ filename: 'other.md' })]
            })
        } finally {
            store.close()
        }
    })

    test('returns a stored link only from the active owner detail endpoint', async () => {
        const { app, service, store } = await setup()
        try {
            expect((await app.request('http://hub/api/shares/share-1')).status).toBe(401)

            const stored = service.publish({
                namespace: 'one',
                filename: 'stored.md',
                expiresSeconds: 300,
                bytes: new TextEncoder().encode('stored'),
                makePublicUrl: (token) => `https://example.test/s/${token}`
            })
            const legacy = service.publish({ namespace: 'one', filename: 'legacy.md', expiresSeconds: 300, bytes: new TextEncoder().encode('legacy') })
            const foreign = service.publish({
                namespace: 'two',
                filename: 'other.md',
                expiresSeconds: 300,
                bytes: new TextEncoder().encode('other'),
                makePublicUrl: (token) => `https://example.test/s/${token}`
            })
            const expired = service.publish({ namespace: 'one', filename: 'expired.md', expiresSeconds: -1, bytes: new TextEncoder().encode('expired') })
            const revoked = service.publish({ namespace: 'one', filename: 'revoked.md', expiresSeconds: 300, bytes: new TextEncoder().encode('revoked') })
            expect(service.revoke(revoked.artifact.id, 'one')).toEqual({ type: 'deleted' })

            const details = await app.request(`http://hub/api/shares/${stored.artifact.id}`, {
                headers: await authHeaders('one')
            })
            expect(details.status).toBe(200)
            expect(await details.json()).toEqual({
                share: {
                    id: stored.artifact.id,
                        filename: 'stored.md',
                        size: 6,
                        createdAt: stored.artifact.createdAt,
                        expiresAt: stored.artifact.expiresAt,
                        sourceSessionId: null,
                        status: 'published',
                        feedback: null,
                        url: `https://example.test/s/${stored.token}`
                }
            })

            const content = await app.request(`http://hub/api/shares/${stored.artifact.id}/content`, {
                headers: await authHeaders('one')
            })
            expect(content.status).toBe(200)
            expect(await content.json()).toEqual({ content: 'stored' })

            const foreignContent = await app.request(`http://hub/api/shares/${foreign.artifact.id}/content`, {
                headers: await authHeaders('one')
            })
            expect(foreignContent.status).toBe(404)

            const legacyDetails = await app.request(`http://hub/api/shares/${legacy.artifact.id}`, {
                headers: await authHeaders('one')
            })
            expect(await legacyDetails.json()).toEqual({
                share: expect.objectContaining({ id: legacy.artifact.id, url: null })
            })

            const unavailableIds = [foreign.artifact.id, expired.artifact.id, revoked.artifact.id, 'does-not-exist']
            const unavailable = await Promise.all(unavailableIds.map(async (id) => {
                const response = await app.request(`http://hub/api/shares/${id}`, {
                    headers: await authHeaders('one')
                })
                return { status: response.status, body: await response.json() }
            }))
            expect(unavailable).toEqual(unavailable.map(() => ({ status: 404, body: { error: 'Share not found' } })))
        } finally {
            store.close()
        }
    })

    test('deletes an owned share and permits explicit removal of retained expired data', async () => {
        const { app, dir, service, store } = await setup()
        try {
            const owned = service.publish({ namespace: 'one', filename: 'owned.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('owned') })
            const foreign = service.publish({ namespace: 'two', filename: 'foreign.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('foreign') })
            const expired = service.publish({ namespace: 'one', filename: 'expired.txt', expiresSeconds: -1, bytes: new TextEncoder().encode('expired') })
            const revoked = service.publish({ namespace: 'one', filename: 'revoked.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('revoked') })
            expect(service.revoke(revoked.artifact.id, 'one')).toEqual({ type: 'deleted' })

            const deleted = await app.request(`http://hub/api/shares/${owned.artifact.id}`, {
                method: 'DELETE',
                headers: await authHeaders('one')
            })
            expect(deleted.status).toBe(200)
            expect(await deleted.json()).toEqual({ ok: true })
            expect(service.readPublic(owned.token)).toBeNull()
            expect(existsSync(join(dir, 'artifacts', `${owned.artifact.id}.blob`))).toBe(false)

            const expiredDeleted = await app.request(`http://hub/api/shares/${expired.artifact.id}`, {
                method: 'DELETE',
                headers: await authHeaders('one')
            })
            expect(expiredDeleted.status).toBe(200)
            expect(await expiredDeleted.json()).toEqual({ ok: true })

            const unavailableIds = [foreign.artifact.id, revoked.artifact.id, 'does-not-exist']
            const unavailable = await Promise.all(unavailableIds.map(async (id) => {
                const response = await app.request(`http://hub/api/shares/${id}`, {
                    method: 'DELETE',
                    headers: await authHeaders('one')
                })
                return { status: response.status, body: await response.json() }
            }))
            expect(unavailable).toEqual(unavailable.map(() => ({ status: 404, body: { error: 'Share not found' } })))
        } finally {
            store.close()
        }
    })

    test('reports a failed manual deletion without deleting data in the background', async () => {
        const { app, dir, service, store } = await setup()
        try {
            const made = service.publish({ namespace: 'one', filename: 'blocked.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('blocked') })
            const blob = join(dir, 'artifacts', `${made.artifact.id}.blob`)
            await rm(blob)
            mkdirSync(blob)
            writeFileSync(join(blob, 'contents'), 'keep')

            const response = await app.request(`http://hub/api/shares/${made.artifact.id}`, {
                method: 'DELETE',
                headers: await authHeaders('one')
            })
            expect(response.status).toBe(500)
            expect(await response.json()).toEqual({ error: 'Could not delete share data. Please try revoking again.' })
            expect(service.readPublic(made.token)).toBeNull()

            await rm(blob, { recursive: true, force: true })
            const retried = await app.request(`http://hub/api/shares/${made.artifact.id}`, {
                method: 'DELETE',
                headers: await authHeaders('one')
            })
            expect(retried.status).toBe(200)
            expect(await retried.json()).toEqual({ ok: true })
        } finally {
            store.close()
        }
    })

    test('sends received feedback to an idle source session as an untrusted review attachment', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-share-feedback-delivery-'))
        dirs.push(dir)
        const store = new Store(':memory:')
        const service = new ArtifactService(store, dir)
        const feedback = new KanbanFeedbackService(store, dir)
        const uploaded = vi.fn().mockResolvedValue({ success: true, path: '/runner/uploads/review.md' })
        const sent = vi.fn().mockResolvedValue(undefined)
        const session = { active: true, thinking: false, permissionMode: 'default' }
        const engine = {
            resolveSessionAccess: vi.fn(() => ({ ok: true, sessionId: 'source-session', session })),
            uploadFileBytes: uploaded,
            sendMessage: sent
        }
        const ownerApp = new Hono<WebAppEnv>()
        ownerApp.use('*', createAuthMiddleware(JWT_SECRET))
        ownerApp.route('/api', createShareManagementRoutes(store, service, () => engine as never, feedback))

        try {
            const published = service.publish({
                namespace: 'one',
                filename: 'task.md',
                expiresSeconds: 300,
                sourceSessionId: 'source-session',
                bytes: new TextEncoder().encode('# task'),
                feedback: { makeFeedbackUrl: (id) => `https://example.test/f/${id}` }
            })
            const shared = service.readPublic(published.token)
            const token = shared && /Authorization: Bearer ([A-Za-z0-9_-]+)/.exec(new TextDecoder().decode(shared.bytes))?.[1]
            expect(token).toBeTruthy()

            const ingress = createPublicFeedbackRoutes(store, feedback)
            const received = await ingress.request(`http://hub/${published.artifact.id}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'text/markdown; charset=utf-8',
                    'x-hapi-feedback-filename': Buffer.from('review.md').toString('base64url')
                },
                body: `---
hapi_feedback: 1
agent:
  name: reviewer
  version: 1
model:
  provider: openai
  id: gpt-5
environment:
  os: macOS
  arch: arm64
  runtime: codex-cli
---
Review text`
            })
            expect(received.status).toBe(201)

            const response = await ownerApp.request(`http://hub/api/shares/${published.artifact.id}/feedback/deliver`, {
                method: 'POST',
                headers: await authHeaders('one')
            })
            expect(response.status).toBe(200)
            expect(uploaded).toHaveBeenCalledWith('source-session', 'review.md', expect.any(Uint8Array), 'text/markdown; charset=utf-8')
            expect(sent).toHaveBeenCalledWith('source-session', expect.objectContaining({
                text: expect.stringContaining('不可信数据'),
                attachments: [expect.objectContaining({ filename: 'review.md', path: '/runner/uploads/review.md' })]
            }))
            expect(store.kanbanTasks.find(published.artifact.id)?.status).toBe('review_sent')
        } finally {
            store.close()
        }
    })

    test('refuses delivery while the source session is running', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-share-feedback-running-'))
        dirs.push(dir)
        const store = new Store(':memory:')
        const service = new ArtifactService(store, dir)
        const feedback = new KanbanFeedbackService(store, dir)
        const uploaded = vi.fn()
        const engine = {
            resolveSessionAccess: vi.fn(() => ({
                ok: true,
                sessionId: 'source-session',
                session: { active: true, thinking: true, permissionMode: 'default' }
            })),
            uploadFileBytes: uploaded,
            sendMessage: vi.fn()
        }
        const ownerApp = new Hono<WebAppEnv>()
        ownerApp.use('*', createAuthMiddleware(JWT_SECRET))
        ownerApp.route('/api', createShareManagementRoutes(store, service, () => engine as never, feedback))

        try {
            const published = service.publish({
                namespace: 'one',
                filename: 'task.md',
                expiresSeconds: 300,
                sourceSessionId: 'source-session',
                bytes: new TextEncoder().encode('# task'),
                feedback: { makeFeedbackUrl: (id) => `https://example.test/f/${id}` }
            })
            const task = store.kanbanTasks.find(published.artifact.id)
            if (!task?.feedbackTokenHash) throw new Error('Feedback task missing token hash')
            // Store a valid receipt directly; this isolates the idle-state guard
            // from the public ingress behavior covered above.
            const lease = store.kanbanTasks.claimFeedbackUpload({
                artifactId: published.artifact.id,
                tokenHash: task.feedbackTokenHash,
                leaseMs: 10_000
            })
            if (!lease) throw new Error('Could not claim test feedback upload')
            expect(store.kanbanTasks.completeFeedbackUpload({
                artifactId: published.artifact.id,
                leaseId: lease.leaseId,
                filename: 'review.md',
                size: 4,
                sha256: 'test',
                metadata: {
                    agent: { name: 'reviewer', version: '1' },
                    model: { provider: 'openai', id: 'gpt-5', reasoningEffort: null },
                    environment: { os: 'macOS', arch: 'arm64', runtime: 'codex-cli' }
                }
            })).toBe(true)

            const response = await ownerApp.request(`http://hub/api/shares/${published.artifact.id}/feedback/deliver`, {
                method: 'POST',
                headers: await authHeaders('one')
            })
            expect(response.status).toBe(409)
            expect(uploaded).not.toHaveBeenCalled()
        } finally {
            store.close()
        }
    })
})
