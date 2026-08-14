import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeneratedImageStore } from './store'

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('GeneratedImageStore', () => {
    it('persists an image independently from its source session process', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-generated-images-'))
        const images = new GeneratedImageStore(rootDir)
        try {
            await images.persist({
                namespace: 'default',
                imageId: 'image-1',
                fileName: 'sample.png',
                mimeType: 'image/png',
                bytes: pngBytes
            })

            await expect(images.read('default', 'image-1')).resolves.toEqual({
                bytes: pngBytes,
                mimeType: 'image/png',
                fileName: 'sample.png'
            })
            await expect(images.read('another-user', 'image-1')).resolves.toBeNull()
        } finally {
            await rm(rootDir, { recursive: true, force: true })
        }
    })

    it('rejects mismatched image content', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-generated-images-'))
        const images = new GeneratedImageStore(rootDir)
        try {
            await expect(images.persist({
                namespace: 'default',
                imageId: 'image-2',
                fileName: 'not-an-image.png',
                mimeType: 'image/png',
                bytes: Buffer.from('not an image')
            })).rejects.toThrow('Generated image content does not match its MIME type')
        } finally {
            await rm(rootDir, { recursive: true, force: true })
        }
    })

    it('removes image records older than three days', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-generated-images-'))
        const images = new GeneratedImageStore(rootDir)
        const now = Date.now()
        try {
            await images.persist({
                namespace: 'default',
                imageId: 'expired-image',
                fileName: 'expired.png',
                mimeType: 'image/png',
                bytes: pngBytes
            })

            const expiredAt = new Date(now - 3 * 24 * 60 * 60 * 1000 - 1)
            const files = await readdir(rootDir)
            await Promise.all(files.map((file) => utimes(join(rootDir, file), expiredAt, expiredAt)))

            expect(await images.pruneExpired(now)).toBe(1)
            await expect(images.read('default', 'expired-image')).resolves.toBeNull()

            await images.persist({
                namespace: 'default',
                imageId: 'fresh-image',
                fileName: 'fresh.png',
                mimeType: 'image/png',
                bytes: pngBytes
            })
            expect(await images.pruneExpired(now)).toBe(0)
            await expect(images.read('default', 'fresh-image')).resolves.toMatchObject({
                fileName: 'fresh.png'
            })
        } finally {
            await rm(rootDir, { recursive: true, force: true })
        }
    })
})
