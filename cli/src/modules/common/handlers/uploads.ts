import { logger } from '@/ui/logger'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { rmSync } from 'node:fs'
import type { DeleteUploadResponse, UploadFileResponse } from '@hapi/protocol/apiTypes'
import { MAX_UPLOAD_BYTES } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { getHapiBlobsDir } from '@/constants/uploadPaths'
import { detectImageMimeType } from '../generatedImages'

interface UploadFileRequest {
    sessionId?: string
    filename: string
    content: string  // base64 encoded
    mimeType: string
}

type UploadFileBytesRequest = {
    sessionId?: string
    filename: string
    bytes: Uint8Array | ArrayBuffer | Buffer
    mimeType: string
}

interface DeleteUploadRequest {
    sessionId?: string
    path: string
}

const uploadDirs = new Map<string, string>()
const uploadDirPromises = new Map<string, Promise<string>>()
const uploadDirCleanupRequested = new Set<string>()
let cleanupRegistered = false

function sanitizeFilename(filename: string): string {
    // Remove path separators and limit length
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 255)

    // If filename is empty after sanitization, use a default
    return sanitized || 'upload'
}

function getSessionKey(sessionId?: string): string {
    const trimmed = sessionId?.trim()
    return trimmed ? trimmed : 'unknown'
}

function estimateBase64Bytes(base64: string): number {
    const len = base64.length
    if (len === 0) return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((len * 3) / 4) - padding
}

async function getOrCreateUploadDir(sessionId?: string): Promise<string> {
    const sessionKey = getSessionKey(sessionId)
    const existing = uploadDirs.get(sessionKey)
    if (existing) {
        return existing
    }

    const inflight = uploadDirPromises.get(sessionKey)
    if (inflight) {
        return await inflight
    }

    const safeKey = sanitizeFilename(sessionKey)
    const creation = (async () => {
        try {
            const blobsDir = getHapiBlobsDir()
            await mkdir(blobsDir, { recursive: true })
            const dir = await mkdtemp(join(blobsDir, `${safeKey}-`))
            if (uploadDirCleanupRequested.has(sessionKey)) {
                try {
                    await rm(dir, { recursive: true, force: true })
                } catch (error) {
                    logger.debug('Failed to cleanup upload directory after cancel:', error)
                }
                throw new Error('Upload directory cleanup requested')
            }
            uploadDirs.set(sessionKey, dir)
            return dir
        } finally {
            uploadDirPromises.delete(sessionKey)
        }
    })()
    uploadDirPromises.set(sessionKey, creation)
    return await creation
}

export async function cleanupUploadDir(sessionId?: string): Promise<void> {
    const sessionKey = getSessionKey(sessionId)
    uploadDirCleanupRequested.add(sessionKey)

    try {
        const inflight = uploadDirPromises.get(sessionKey)
        if (inflight) {
            try {
                await inflight
            } catch {
                // ignore inflight errors
            }
        }

        const dir = uploadDirs.get(sessionKey)
        uploadDirs.delete(sessionKey)
        uploadDirPromises.delete(sessionKey)

        if (!dir) {
            return
        }

        try {
            await rm(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory:', error)
        }
    } finally {
        uploadDirCleanupRequested.delete(sessionKey)
    }
}

function cleanupUploadDirsSync(): void {
    const dirs = Array.from(uploadDirs.values())
    uploadDirs.clear()
    uploadDirPromises.clear()
    uploadDirCleanupRequested.clear()

    for (const dir of dirs) {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch (error) {
            logger.debug('Failed to cleanup upload directory on exit:', error)
        }
    }
}

function isPathWithinUploadDir(path: string, sessionId?: string): boolean {
    const sessionKey = getSessionKey(sessionId)
    const resolvedPath = resolve(path)
    const activeDir = uploadDirs.get(sessionKey)
    if (activeDir) {
        const resolvedDir = resolve(activeDir)
        const dirPrefix = resolvedDir.endsWith(sep) ? resolvedDir : `${resolvedDir}${sep}`
        return resolvedPath.startsWith(dirPrefix)
    }

    const safeKey = sanitizeFilename(sessionKey)
    const resolvedPrefix = resolve(getHapiBlobsDir(), `${safeKey}-`)
    return resolvedPath.startsWith(resolvedPrefix)
}

function normalizeBytes(value: unknown): Buffer | null {
    if (Buffer.isBuffer(value)) {
        return value
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value)
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value)
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
        return Buffer.from(value)
    }
    if (value && typeof value === 'object') {
        const data = (value as { data?: unknown }).data
        if (Array.isArray(data) && data.every((item) => typeof item === 'number')) {
            return Buffer.from(data)
        }
    }
    return null
}

export async function uploadFileBytes(data: UploadFileBytesRequest): Promise<UploadFileResponse> {
    logger.debug('Upload file bytes request:', data.filename, 'mimeType:', data.mimeType)

    if (!data.filename) {
        return rpcError('Filename is required')
    }

    const buffer = normalizeBytes(data.bytes)
    if (!buffer || buffer.length === 0) {
        return rpcError('Content is required')
    }

    if (buffer.length > MAX_UPLOAD_BYTES) {
        return rpcError('File too large (max 50MB)')
    }

    try {
        const dir = await getOrCreateUploadDir(data.sessionId)
        const sanitizedFilename = sanitizeFilename(data.filename)

        // Add timestamp to avoid collisions
        const timestamp = Date.now()
        const uniqueFilename = `${timestamp}-${sanitizedFilename}`
        const filePath = join(dir, uniqueFilename)

        await writeFile(filePath, buffer)

        logger.debug('File uploaded successfully:', filePath)
        return { success: true, path: filePath }
    } catch (error) {
        logger.debug('Failed to upload file:', error)
        return rpcError(getErrorMessage(error, 'Failed to upload file'))
    }
}

export async function readUploadFileBytes(path: string, sessionId?: string): Promise<{
    success: true
    bytes: Buffer
    fileName: string
    size: number
    mimeType: string | null
} | {
    success: false
    error: string
}> {
    const trimmedPath = path?.trim()
    if (!trimmedPath) {
        return rpcError('Path is required')
    }

    if (!isPathWithinUploadDir(trimmedPath, sessionId)) {
        return rpcError('Invalid upload path')
    }

    try {
        const bytes = await readFile(trimmedPath)
        return {
            success: true,
            bytes,
            fileName: trimmedPath.split(/[\\/]/).pop() ?? 'upload',
            size: bytes.length,
            mimeType: detectImageMimeType(bytes)
        }
    } catch (error) {
        logger.debug('Failed to read upload file:', error)
        return rpcError(getErrorMessage(error, 'Failed to read upload file'))
    }
}

export function registerUploadHandlers(rpcHandlerManager: RpcHandlerManager): void {
    if (!cleanupRegistered) {
        cleanupRegistered = true
        process.once('exit', cleanupUploadDirsSync)
    }

    rpcHandlerManager.registerHandler<UploadFileRequest, UploadFileResponse>(RPC_METHODS.UploadFile, async (data) => {
        logger.debug('Upload file request:', data.filename, 'mimeType:', data.mimeType)

        if (!data.filename) {
            return rpcError('Filename is required')
        }

        if (!data.content) {
            return rpcError('Content is required')
        }

        const estimatedBytes = estimateBase64Bytes(data.content)
        if (estimatedBytes > MAX_UPLOAD_BYTES) {
            return rpcError('File too large (max 50MB)')
        }

        return await uploadFileBytes({
            sessionId: data.sessionId,
            filename: data.filename,
            mimeType: data.mimeType,
            bytes: Buffer.from(data.content, 'base64')
        })
    })

    rpcHandlerManager.registerHandler<DeleteUploadRequest, DeleteUploadResponse>(RPC_METHODS.DeleteUpload, async (data) => {
        const path = data?.path?.trim()
        if (!path) {
            return rpcError('Path is required')
        }

        if (!isPathWithinUploadDir(path, data.sessionId)) {
            return rpcError('Invalid upload path')
        }

        try {
            await rm(path, { force: true })
            return { success: true }
        } catch (error) {
            logger.debug('Failed to delete upload file:', error)
            return rpcError(getErrorMessage(error, 'Failed to delete upload file'))
        }
    })
}
