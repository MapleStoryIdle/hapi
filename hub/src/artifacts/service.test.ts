import { afterEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { ArtifactService } from './service'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function service() { const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir); return { store: new Store(':memory:'), service: new ArtifactService(new Store(':memory:'), dir) } }
describe('ArtifactService', () => {
    test('stores a token hash plus an owner-copyable URL and enforces namespace-scoped revocation', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const created = artifacts.publish({
            namespace: 'one',
            filename: 'note.txt',
            expiresSeconds: 300,
            bytes: new TextEncoder().encode('safe'),
            makePublicUrl: (token) => `https://example.test/s/${token}`
        })
        expect(created.artifact.tokenHash).not.toBe(created.token)
        expect(store.artifacts.findPublic(created.artifact.tokenHash)?.publicUrl).toBe(`https://example.test/s/${created.token}`)
        expect(artifacts.readPublic(created.token)?.bytes).toEqual(new TextEncoder().encode('safe'))
        expect(artifacts.revoke(created.artifact.id, 'two')).toEqual({ type: 'not-found' })
        expect(artifacts.revoke(created.artifact.id, 'one')).toEqual({ type: 'revoked', cleanupPending: false })
        expect(artifacts.readPublic(created.token)).toBeNull()
        store.close()
    })
    test('does not serve expired artifacts', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const made = artifacts.publish({ namespace: 'one', filename: 'page.html', expiresSeconds: 300, bytes: new Uint8Array([1]) })
        expect(store.artifacts.findPublic(made.artifact.tokenHash, made.artifact.expiresAt)).toBeNull()
        store.close()
    })
    test('removes expired blobs and records at the expiration boundary', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const made = artifacts.publish({ namespace: 'one', filename: 'note.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('expired') })
        const blob = join(dir, 'artifacts', `${made.artifact.id}.blob`)
        expect(existsSync(blob)).toBe(true)
        expect(store.artifacts.findPublic(made.artifact.tokenHash, made.artifact.expiresAt - 1)).not.toBeNull()
        expect(artifacts.cleanupExpired(made.artifact.expiresAt)).toBe(1)
        expect(existsSync(blob)).toBe(false)
        expect(store.artifacts.findPublic(made.artifact.tokenHash, made.artifact.expiresAt - 1)).toBeNull()
        store.close()
    })
    test('keeps future artifacts and removes expired records whose blob is already missing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const future = artifacts.publish({ namespace: 'one', filename: 'future.txt', expiresSeconds: 600, bytes: new TextEncoder().encode('future') })
        const expired = artifacts.publish({ namespace: 'one', filename: 'expired.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('expired') })
        const futureBlob = join(dir, 'artifacts', `${future.artifact.id}.blob`)
        const expiredBlob = join(dir, 'artifacts', `${expired.artifact.id}.blob`)
        await rm(expiredBlob)
        expect(artifacts.cleanupExpired(expired.artifact.expiresAt)).toBe(1)
        expect(existsSync(futureBlob)).toBe(true)
        expect(store.artifacts.findPublic(future.artifact.tokenHash, expired.artifact.expiresAt)).not.toBeNull()
        expect(store.artifacts.findPublic(expired.artifact.tokenHash, expired.artifact.expiresAt - 1)).toBeNull()
        store.close()
    })
    test('continues cleaning later expired artifacts when one blob cannot be removed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const blocked = artifacts.publish({ namespace: 'one', filename: 'blocked.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('blocked') })
        const removable = artifacts.publish({ namespace: 'one', filename: 'removable.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('removable') })
        const blockedBlob = join(dir, 'artifacts', `${blocked.artifact.id}.blob`)
        const removableBlob = join(dir, 'artifacts', `${removable.artifact.id}.blob`)
        await rm(blockedBlob)
        mkdirSync(blockedBlob)
        writeFileSync(join(blockedBlob, 'contents'), 'keep')
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(artifacts.cleanupExpired(Math.max(blocked.artifact.expiresAt, removable.artifact.expiresAt))).toBe(1)
        expect(warning).toHaveBeenCalledWith('[Artifacts] Failed to clean share blob')
        expect(store.artifacts.findPublic(blocked.artifact.tokenHash, blocked.artifact.expiresAt - 1)).not.toBeNull()
        expect(existsSync(removableBlob)).toBe(false)
        expect(store.artifacts.findPublic(removable.artifact.tokenHash, removable.artifact.expiresAt - 1)).toBeNull()
        store.close()
    })

    test('revokes only active shares and reports deferred blob cleanup', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const active = artifacts.publish({ namespace: 'one', filename: 'active.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('active') })
        const expired = artifacts.publish({ namespace: 'one', filename: 'expired.txt', expiresSeconds: -1, bytes: new TextEncoder().encode('expired') })
        const blob = join(dir, 'artifacts', `${active.artifact.id}.blob`)
        await rm(blob)
        mkdirSync(blob)
        writeFileSync(join(blob, 'contents'), 'keep')

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(artifacts.revoke(expired.artifact.id, 'one')).toEqual({ type: 'not-found' })
        expect(artifacts.revoke(active.artifact.id, 'one')).toEqual({ type: 'revoked', cleanupPending: true })
        expect(warning).toHaveBeenCalledWith('[Artifacts] Failed to clean revoked share blob')
        expect(artifacts.readPublic(active.token)).toBeNull()
        expect(store.artifacts.listActive('one')).toEqual([])

        await rm(blob, { recursive: true, force: true })
        expect(artifacts.cleanupExpired()).toBe(2)
        store.close()
    })
})
