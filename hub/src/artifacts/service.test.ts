import { afterEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store'
import { feedbackBlobPath } from '../kanban/feedback'
import { ArtifactService } from './service'

const dirs: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
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
        expect(artifacts.revoke(created.artifact.id, 'one')).toEqual({ type: 'deleted' })
        expect(artifacts.readPublic(created.token)).toBeNull()
        store.close()
    })

    test('keeps expired records and blobs while their public links are unavailable', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const made = artifacts.publish({ namespace: 'one', filename: 'page.html', expiresSeconds: 300, bytes: new Uint8Array([1]) })
        const blob = join(dir, 'artifacts', `${made.artifact.id}.blob`)
        expect(existsSync(blob)).toBe(true)
        expect(store.kanbanTasks.find(made.artifact.id)).not.toBeNull()
        expect(store.artifacts.findPublic(made.artifact.tokenHash, made.artifact.expiresAt)).toBeNull()
        // Expiry only changes URL visibility. There is deliberately no cleanup
        // call here or in Hub startup that can delete this retained task.
        expect(existsSync(blob)).toBe(true)
        expect(store.kanbanTasks.find(made.artifact.id)).not.toBeNull()
        store.close()
    })

    test('removes the share blob, feedback blob, and cascaded Kanban task on owner revocation', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const made = artifacts.publish({
            namespace: 'one',
            filename: 'task.md',
            expiresSeconds: 300,
            bytes: new TextEncoder().encode('# task'),
            sourceSessionId: 'session-1',
            feedback: { makeFeedbackUrl: (id) => `https://example.test/f/${id}` }
        })
        const blob = join(dir, 'artifacts', `${made.artifact.id}.blob`)
        const feedbackBlob = feedbackBlobPath(dir, made.artifact.id)
        mkdirSync(join(dir, 'kanban-feedback'))
        writeFileSync(feedbackBlob, '# feedback')

        expect(store.kanbanTasks.find(made.artifact.id)).not.toBeNull()
        expect(artifacts.revoke(made.artifact.id, 'one')).toEqual({ type: 'deleted' })
        expect(existsSync(blob)).toBe(false)
        expect(existsSync(feedbackBlob)).toBe(false)
        expect(store.kanbanTasks.find(made.artifact.id)).toBeNull()
        expect(store.artifacts.findPublic(made.artifact.tokenHash, made.artifact.createdAt)).toBeNull()
        store.close()
    })

    test('requires an explicit retry if manual deletion cannot remove a blob', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-artifact-')); dirs.push(dir)
        const store = new Store(':memory:'); const artifacts = new ArtifactService(store, dir)
        const active = artifacts.publish({ namespace: 'one', filename: 'active.txt', expiresSeconds: 300, bytes: new TextEncoder().encode('active') })
        const blob = join(dir, 'artifacts', `${active.artifact.id}.blob`)
        await rm(blob)
        mkdirSync(blob)
        writeFileSync(join(blob, 'contents'), 'keep')

        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(artifacts.revoke(active.artifact.id, 'one')).toEqual({ type: 'delete-failed' })
        expect(warning).toHaveBeenCalledWith('[Artifacts] Failed to delete share data')
        expect(artifacts.readPublic(active.token)).toBeNull()
        expect(store.artifacts.listActive('one')).toEqual([])
        expect(store.kanbanTasks.find(active.artifact.id)).not.toBeNull()

        await rm(blob, { recursive: true, force: true })
        expect(artifacts.revoke(active.artifact.id, 'one')).toEqual({ type: 'deleted' })
        expect(store.kanbanTasks.find(active.artifact.id)).toBeNull()
        store.close()
    })
})
