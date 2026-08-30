import { afterEach, describe, expect, test } from 'vitest'
import { SignJWT } from 'jose'
import { Hono } from 'hono'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactService } from '../../artifacts/service'
import { Store } from '../../store'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
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
            expect(service.revoke(revoked.artifact.id, 'one')).toEqual({ type: 'revoked', cleanupPending: false })

            const response = await app.request('http://hub/api/shares', { headers: await authHeaders('one') })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                shares: [
                    {
                        id: sooner.artifact.id,
                        filename: 'sooner.md',
                        size: 6,
                        createdAt: sooner.artifact.createdAt,
                        expiresAt: sooner.artifact.expiresAt
                    },
                    {
                        id: later.artifact.id,
                        filename: 'later.md',
                        size: 5,
                        createdAt: later.artifact.createdAt,
                        expiresAt: later.artifact.expiresAt
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
            expect(service.revoke(revoked.artifact.id, 'one')).toEqual({ type: 'revoked', cleanupPending: false })

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
                    url: `https://example.test/s/${stored.token}`
                }
            })

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

    test('revokes an owned active share but keeps all unavailable cases indistinguishable', async () => {
        const { app, dir, service, store } = await setup()
        try {
            const owned = service.publish({ namespace: 'one', filename: 'owned.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('owned') })
            const foreign = service.publish({ namespace: 'two', filename: 'foreign.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('foreign') })
            const expired = service.publish({ namespace: 'one', filename: 'expired.txt', expiresSeconds: -1, bytes: new TextEncoder().encode('expired') })
            const revoked = service.publish({ namespace: 'one', filename: 'revoked.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('revoked') })
            expect(service.revoke(revoked.artifact.id, 'one')).toEqual({ type: 'revoked', cleanupPending: false })

            const deleted = await app.request(`http://hub/api/shares/${owned.artifact.id}`, {
                method: 'DELETE',
                headers: await authHeaders('one')
            })
            expect(deleted.status).toBe(200)
            expect(await deleted.json()).toEqual({ ok: true, cleanupPending: false })
            expect(service.readPublic(owned.token)).toBeNull()
            expect(existsSync(join(dir, 'artifacts', `${owned.artifact.id}.blob`))).toBe(false)

            const unavailableIds = [foreign.artifact.id, expired.artifact.id, revoked.artifact.id, 'does-not-exist']
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

    test('reports a pending cleanup without leaving the bearer URL usable', async () => {
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
            expect(response.status).toBe(202)
            expect(await response.json()).toEqual({ ok: true, cleanupPending: true })
            expect(service.readPublic(made.token)).toBeNull()
        } finally {
            store.close()
        }
    })
})
