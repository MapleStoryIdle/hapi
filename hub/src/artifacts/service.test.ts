import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { ArtifactService } from './service'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function service() { const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir); return { store: new Store(':memory:'), service: new ArtifactService(new Store(':memory:'), dir) } }
describe('ArtifactService', () => {
    test('stores only a token hash and enforces namespace-scoped revocation', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const created = artifacts.publish({ namespace: 'one', filename: 'note.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('safe') })
        expect(store.artifacts.findPublic(created.token)?.tokenHash).not.toBe(created.token)
        expect(artifacts.readPublic(created.token)?.bytes).toEqual(new TextEncoder().encode('safe'))
        expect(artifacts.revoke(created.artifact.id, 'two')).toBe(false)
        expect(artifacts.revoke(created.artifact.id, 'one')).toBe(true)
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
})
