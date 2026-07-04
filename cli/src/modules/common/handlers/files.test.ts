import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '../../../api/rpc/RpcHandlerManager'
import { clearGeneratedImages, registerGeneratedImage } from '../generatedImages'
import { registerFileHandlers } from './files'

async function createTempDir(prefix: string): Promise<string> {
    const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(path, { recursive: true })
    return path
}

describe('file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await createTempDir('hapi-file-handler')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
        clearGeneratedImages()
    })

    afterEach(async () => {
        clearGeneratedImages()
        if (rootDir) {
            await rm(rootDir, { recursive: true, force: true })
        }
    })

    it('serves generated images from the registered source path', async () => {
        const imagePath = join(rootDir, 'shot.png')
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        await writeFile(imagePath, pngBytes)
        const info = await lstat(imagePath)

        registerGeneratedImage({
            id: 'img-1',
            path: imagePath,
            mimeType: 'image/png',
            size: info.size,
            mtimeMs: info.mtimeMs
        })

        const response = await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.ReadGeneratedImage}`,
            params: JSON.stringify({ id: 'img-1' })
        })
        const parsed = JSON.parse(response) as { success: boolean; content?: string; mimeType?: string }

        expect(parsed.success).toBe(true)
        expect(parsed.mimeType).toBe('image/png')
        expect(parsed.content).toBe(pngBytes.toString('base64'))
    })

    it('rejects uncached generated image loads when the source file changed', async () => {
        const imagePath = join(rootDir, 'shot.png')
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        await writeFile(imagePath, pngBytes)
        const info = await lstat(imagePath)

        registerGeneratedImage({
            id: 'img-2',
            path: imagePath,
            mimeType: 'image/png',
            size: info.size,
            mtimeMs: info.mtimeMs
        })
        await writeFile(imagePath, Buffer.concat([pngBytes, Buffer.from([0x00])]))

        const response = await rpc.handleRequest({
            method: `session-test:${RPC_METHODS.ReadGeneratedImage}`,
            params: JSON.stringify({ id: 'img-2' })
        })
        const parsed = JSON.parse(response) as { success: boolean; error?: string }

        expect(parsed.success).toBe(false)
        expect(parsed.error).toBe('Generated image source changed')
    })
})
