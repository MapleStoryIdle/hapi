import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../store'
import { ArtifactService } from '../../artifacts/service'
import { createLegacyPublicShareTombstoneRoutes, createPublicShareRoutes } from './shares'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-share-route-')); dirs.push(dir)
    const store = new Store(':memory:'); const service = new ArtifactService(store, dir)
    return { store, service, app: createPublicShareRoutes(store, service) }
}
describe('public share route', () => {
    test('serves GET and HEAD with private safe headers and no CORS', async () => {
        const { app, service, store } = await setup()
        const made = service.publish({ namespace: 'one', filename: 'note.md', expiresSeconds: 300, bytes: new TextEncoder().encode('# safe'), sourceContext: { directoryName: 'private-workspace', gitBranch: 'feature/private' } })
        const get = await app.request(`http://hub/${made.token}`)
        expect(get.status).toBe(200); expect(await get.text()).toBe('# safe')
        expect(get.headers.get('content-type')).toBe('text/plain; charset=utf-8')
        expect(get.headers.get('cache-control')).toBe('no-store'); expect(get.headers.get('cdn-cache-control')).toBe('no-store')
        expect(get.headers.get('x-content-type-options')).toBe('nosniff'); expect(get.headers.get('referrer-policy')).toBe('no-referrer')
        expect(get.headers.get('x-hapi-share-source-directory')).toBeNull(); expect(get.headers.get('x-hapi-share-source-branch')).toBeNull()
        expect(get.headers.get('x-frame-options')).toBe('SAMEORIGIN')
        expect(get.headers.get('content-security-policy')).toContain('sandbox')
        expect(get.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
        expect(get.headers.get('access-control-allow-origin')).toBeNull()
        const head = await app.request(`http://hub/${made.token}`, { method: 'HEAD' })
        expect(head.status).toBe(200); expect(await head.text()).toBe(''); expect(head.headers.get('content-length')).toBe('6')
        store.close()
    })
    test('uses identical 404 for invalid, revoked, and expired tokens', async () => {
        const { app, service, store } = await setup()
        const made = service.publish({ namespace: 'one', filename: 'a.bin', expiresSeconds: 300, bytes: new Uint8Array([1]) })
        expect(service.revoke(made.artifact.id, 'one')).toEqual({ type: 'deleted' })
        const revoked = await app.request(`http://hub/${made.token}`); const invalid = await app.request('http://hub/not-a-valid-token')
        const invalidBody = await invalid.text()
        expect(revoked.status).toBe(404); expect(invalid.status).toBe(404); expect(await revoked.text()).toBe(invalidBody)
        expect(revoked.headers.get('cache-control')).toBe('no-store'); expect(revoked.headers.get('access-control-allow-origin')).toBeNull()
        const expired = service.publish({ namespace: 'one', filename: 'b.bin', expiresSeconds: -1, bytes: new Uint8Array([1]) })
        const expiredResponse = await app.request(`http://hub/${expired.token}`)
        expect(expiredResponse.status).toBe(404); expect(await expiredResponse.text()).toBe(invalidBody)
        expect((await app.request('http://hub/')).status).toBe(404)
        expect((await app.request('http://hub/s/b')).status).toBe(404)
        expect((await app.request(`http://hub/${expired.token}`, { method: 'POST' })).status).toBe(404)
        store.close()
    })

    test('returns a private 404 for legacy public-link paths', async () => {
        const app = createLegacyPublicShareTombstoneRoutes()
        const response = await app.request('http://hub/old-token')
        expect(response.status).toBe(404)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    })
})
