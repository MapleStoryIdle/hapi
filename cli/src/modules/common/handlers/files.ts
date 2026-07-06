import { logger } from '@/ui/logger'
import { lstat, readFile, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { basename, isAbsolute, resolve } from 'path'
import type { FileReadResponse, GeneratedImageResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { detectImageMimeType, getGeneratedImage } from '../generatedImages'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

interface WriteFileResponse {
    success: boolean
    hash?: string
    error?: string
}

export type ReadFileBytesResult = {
    success: true
    bytes: Buffer
    mimeType: string | null
    fileName: string
    size: number
    mtimeMs: number
} | {
    success: false
    error: string
}

export type GeneratedImageFileReference = {
    path: string
    mimeType: string
    size: number
    mtimeMs: number
    fileName?: string | null
}

export async function readSessionFileBytes(path: string, workingDirectory: string): Promise<ReadFileBytesResult> {
    const validation = validatePath(path, workingDirectory)
    if (!validation.valid) {
        return rpcError(validation.error ?? 'Invalid file path')
    }

    try {
        const resolvedPath = resolve(workingDirectory, path)
        const bytes = await readFile(resolvedPath)
        const info = await stat(resolvedPath)
        return {
            success: true,
            bytes,
            mimeType: detectImageMimeType(bytes),
            fileName: basename(path) || 'file',
            size: info.size,
            mtimeMs: info.mtimeMs
        }
    } catch (error) {
        logger.debug('Failed to read file:', error)
        return rpcError(getErrorMessage(error, 'Failed to read file'))
    }
}

export async function readGeneratedImageFileBytes(image: GeneratedImageFileReference): Promise<ReadFileBytesResult> {
    if (!isAbsolute(image.path)) {
        return rpcError('Invalid generated image path')
    }

    try {
        const info = await lstat(image.path)
        if (!info.isFile()) {
            return rpcError('Generated image source is unavailable')
        }
        if (info.size !== image.size || info.mtimeMs !== image.mtimeMs) {
            return rpcError('Generated image source changed')
        }

        const bytes = await readFile(image.path)
        if (detectImageMimeType(bytes) !== image.mimeType) {
            return rpcError('Generated image source changed')
        }

        return {
            success: true,
            bytes,
            mimeType: image.mimeType,
            fileName: image.fileName || basename(image.path) || 'generated-image',
            size: image.size,
            mtimeMs: image.mtimeMs
        }
    } catch (error) {
        logger.debug('Failed to read generated image:', error)
        return rpcError(getErrorMessage(error, 'Failed to read generated image'))
    }
}

export async function readGeneratedImageBytes(id: string): Promise<ReadFileBytesResult> {
    const image = getGeneratedImage(id)
    if (!image) {
        return rpcError('Generated image not found')
    }

    return await readGeneratedImageFileBytes(image)
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const result = await readSessionFileBytes(data.path, workingDirectory)
        if (!result.success) {
            return result
        }
        return { success: true, content: result.bytes.toString('base64') }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const result = await readGeneratedImageBytes(data.id)
        if (!result.success) {
            return result
        }
        return {
            success: true,
            content: result.bytes.toString('base64'),
            mimeType: result.mimeType ?? undefined,
            fileName: result.fileName
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(data.path)
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                }
            } else {
                try {
                    await stat(data.path)
                    return rpcError('File already exists but was expected to be new')
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                }
            }

            const buffer = Buffer.from(data.content, 'base64')
            await writeFile(data.path, buffer)

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
