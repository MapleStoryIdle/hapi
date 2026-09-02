import { logger } from '@/ui/logger'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type {
    CleanupUploadSessionRequest,
    DeleteUploadResponse,
    UploadFileCancelRequest,
    UploadFileChunkRequest,
    UploadFileFinishRequest,
    UploadFileOperationResponse,
    UploadFileResponse,
    UploadFileStartRequest
} from '@hapi/protocol/apiTypes'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { AsyncLock } from '@/utils/lock'
import { getErrorMessage, rpcError } from '../rpcResponses'
import { getHapiBlobsDir } from '@/constants/uploadPaths'
import { detectImageMimeType } from '../generatedImages'

type DeleteUploadRequest = {
    sessionId?: unknown
    path?: unknown
}

type ActiveUpload = {
    sessionId: string
    uploadId: string
    expectedSize: number
    writtenBytes: number
    partPath: string
    filePath: string
    lastActivityAt: number
    lock: AsyncLock
    staleTimer: ReturnType<typeof setTimeout> | null
}

type CompletedUpload = {
    sessionId: string
    path: string
    completedAt: number
}

const uploadDirs = new Map<string, string>()
const uploadDirPromises = new Map<string, Promise<string>>()
const uploadDirCleanupRequested = new Set<string>()
const activeUploads = new Map<string, ActiveUpload>()
const reservedUploadIds = new Set<string>()
const completedUploads = new Map<string, CompletedUpload>()
const UPLOAD_STALE_MS = 10 * 60 * 1000
const MAX_UPLOAD_ID_LENGTH = 128
const MAX_BASE64_CHUNK_LENGTH = Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4
const MAX_COMPLETED_UPLOADS = 256
let cleanupRegistered = false

function sanitizeFilename(filename: string): string {
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 255)

    return sanitized || 'upload'
}

function getSessionKey(sessionId?: string): string {
    const trimmed = sessionId?.trim()
    return trimmed ? trimmed : 'unknown'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const sessionId = value.trim()
    return sessionId ? sessionId : null
}

function readUploadId(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > MAX_UPLOAD_ID_LENGTH) return null
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) ? value : null
}

function readFilename(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const filename = value.trim()
    return filename && filename.length <= 255 ? filename : null
}

function readMimeType(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const mimeType = value.trim()
    return mimeType && mimeType.length <= 255 ? mimeType : null
}

function readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readChunkBytes(value: unknown): Buffer | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_CHUNK_LENGTH) {
        return null
    }

    if (
        value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
        return null
    }

    const bytes = Buffer.from(value, 'base64')
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_CHUNK_BYTES || bytes.toString('base64') !== value) {
        return null
    }

    return bytes
}

async function getOrCreateUploadDir(sessionId: string): Promise<string> {
    const sessionKey = getSessionKey(sessionId)
    if (uploadDirCleanupRequested.has(sessionKey)) {
        throw new Error('Upload directory cleanup requested')
    }

    const existing = uploadDirs.get(sessionKey)
    if (existing) {
        try {
            if ((await stat(existing)).isDirectory()) {
                return existing
            }
        } catch {
            // External removal can leave this process with a stale cache
            // entry. Recreate it below.
        }
        uploadDirs.delete(sessionKey)
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

function isWithinDirectory(path: string, directory: string): boolean {
    const resolvedPath = resolve(path)
    const resolvedDirectory = resolve(directory)
    const directoryPrefix = resolvedDirectory.endsWith(sep) ? resolvedDirectory : `${resolvedDirectory}${sep}`
    return resolvedPath.startsWith(directoryPrefix)
}

function isLegacyUploadDirectoryName(directoryName: string, sessionKey: string): boolean {
    const prefix = `${sanitizeFilename(sessionKey)}-`
    const suffix = directoryName.slice(prefix.length)
    return directoryName.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(suffix)
}

function isPathWithinUploadDir(path: string, sessionId?: string): boolean {
    const sessionKey = getSessionKey(sessionId)
    const activeDir = uploadDirs.get(sessionKey)
    if (activeDir && isWithinDirectory(path, activeDir)) {
        return true
    }

    // A session process from before runner-owned uploads may have created this
    // directory. The runner cannot know its random suffix after a restart, so
    // retain a narrow filename-prefix fallback for previews and deletion.
    const blobsDir = resolve(getHapiBlobsDir())
    const pathWithinBlobs = relative(blobsDir, resolve(path))
    if (!pathWithinBlobs || pathWithinBlobs.startsWith('..') || isAbsolute(pathWithinBlobs)) {
        return false
    }

    const segments = pathWithinBlobs.split(sep)
    const directoryName = segments[0] ?? ''
    return segments.length > 1 && isLegacyUploadDirectoryName(directoryName, sessionKey)
}

async function listUploadDirsForSession(sessionId: string): Promise<string[]> {
    const sessionKey = getSessionKey(sessionId)
    const blobsDir = getHapiBlobsDir()
    try {
        const entries = await readdir(blobsDir, { withFileTypes: true })
        return entries
            .filter((entry) => entry.isDirectory() && isLegacyUploadDirectoryName(entry.name, sessionKey))
            .map((entry) => join(blobsDir, entry.name))
    } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'ENOENT') {
            logger.debug('Failed to list upload directories:', error)
        }
        return []
    }
}

function clearStaleTimer(upload: ActiveUpload): void {
    if (upload.staleTimer) {
        clearTimeout(upload.staleTimer)
        upload.staleTimer = null
    }
}

function scheduleStaleCleanup(upload: ActiveUpload): void {
    clearStaleTimer(upload)
    const timer = setTimeout(() => {
        void cleanupStaleUploads()
    }, UPLOAD_STALE_MS)
    timer.unref?.()
    upload.staleTimer = timer
}

function rememberCompletedUpload(uploadId: string, sessionId: string, path: string): void {
    completedUploads.set(uploadId, { sessionId, path, completedAt: Date.now() })
    while (completedUploads.size > MAX_COMPLETED_UPLOADS) {
        const oldestUploadId = completedUploads.keys().next().value
        if (oldestUploadId === undefined) {
            break
        }
        completedUploads.delete(oldestUploadId)
    }
}

function getCompletedUpload(uploadId: string, sessionId: string): CompletedUpload | null {
    const completed = completedUploads.get(uploadId)
    return completed?.sessionId === sessionId ? completed : null
}

function clearCompletedUploadsForSession(sessionId: string): void {
    for (const [uploadId, completed] of completedUploads) {
        if (completed.sessionId === sessionId) {
            completedUploads.delete(uploadId)
        }
    }
}

async function cancelCompletedUpload(uploadId: string, sessionId: string): Promise<UploadFileOperationResponse | null> {
    const completed = completedUploads.get(uploadId)
    if (!completed) {
        return null
    }
    if (completed.sessionId !== sessionId) {
        return rpcError('Upload not found')
    }

    try {
        await rm(completed.path, { force: true })
        completedUploads.delete(uploadId)
        return { success: true }
    } catch (error) {
        logger.debug('Failed to cancel completed upload:', error)
        return rpcError(getErrorMessage(error, 'Failed to cancel completed upload'))
    }
}

async function discardActiveUpload(upload: ActiveUpload): Promise<void> {
    await upload.lock.inLock(async () => {
        if (activeUploads.get(upload.uploadId) !== upload) {
            return
        }

        activeUploads.delete(upload.uploadId)
        clearStaleTimer(upload)
        try {
            await rm(upload.partPath, { force: true })
        } catch (error) {
            logger.debug('Failed to remove partial upload:', error)
        }
    })
}

export async function cleanupStaleUploads(now = Date.now()): Promise<void> {
    const staleUploads = Array.from(activeUploads.values()).filter((upload) => (
        now - upload.lastActivityAt >= UPLOAD_STALE_MS
    ))
    await Promise.all(staleUploads.map(async (upload) => {
        await discardActiveUpload(upload)
    }))
    for (const [uploadId, completed] of completedUploads) {
        if (now - completed.completedAt >= UPLOAD_STALE_MS) {
            completedUploads.delete(uploadId)
        }
    }
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
                // The cleanup marker intentionally makes an in-flight create fail.
            }
        }

        const uploads = Array.from(activeUploads.values()).filter((upload) => upload.sessionId === sessionKey)
        await Promise.all(uploads.map(async (upload) => {
            await discardActiveUpload(upload)
        }))
        clearCompletedUploadsForSession(sessionKey)

        const knownDir = uploadDirs.get(sessionKey)
        uploadDirs.delete(sessionKey)
        uploadDirPromises.delete(sessionKey)

        const dirs = new Set(await listUploadDirsForSession(sessionKey))
        if (knownDir) {
            dirs.add(knownDir)
        }

        await Promise.all(Array.from(dirs).map(async (dir) => {
            try {
                await rm(dir, { recursive: true, force: true })
            } catch (error) {
                logger.debug('Failed to cleanup upload directory:', error)
            }
        }))
    } finally {
        uploadDirCleanupRequested.delete(sessionKey)
    }
}

function cleanupUploadDirsSync(): void {
    for (const upload of activeUploads.values()) {
        clearStaleTimer(upload)
    }
    activeUploads.clear()
    reservedUploadIds.clear()
    completedUploads.clear()

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

export async function startUploadFile(data: UploadFileStartRequest | unknown): Promise<UploadFileOperationResponse> {
    await cleanupStaleUploads()
    if (!isRecord(data)) {
        return rpcError('Invalid upload request')
    }

    const sessionId = readSessionId(data.sessionId)
    const uploadId = readUploadId(data.uploadId)
    const filename = readFilename(data.filename)
    const mimeType = readMimeType(data.mimeType)
    const size = readNonNegativeInteger(data.size)
    if (!sessionId || !uploadId || !filename || !mimeType || size === null) {
        return rpcError('Invalid upload request')
    }
    if (size > MAX_UPLOAD_BYTES) {
        return rpcError('File too large (max 50MB)')
    }
    if (activeUploads.has(uploadId) || reservedUploadIds.has(uploadId) || completedUploads.has(uploadId)) {
        return rpcError('Upload id is already in use')
    }

    reservedUploadIds.add(uploadId)
    try {
        const dir = await getOrCreateUploadDir(sessionId)
        const uniqueFilename = `${Date.now()}-${uploadId}-${sanitizeFilename(filename)}`
        const filePath = join(dir, uniqueFilename)
        const partPath = `${filePath}.part`
        await writeFile(partPath, Buffer.alloc(0), { flag: 'wx' })

        const upload: ActiveUpload = {
            sessionId,
            uploadId,
            expectedSize: size,
            writtenBytes: 0,
            partPath,
            filePath,
            lastActivityAt: Date.now(),
            lock: new AsyncLock(),
            staleTimer: null
        }
        activeUploads.set(uploadId, upload)
        scheduleStaleCleanup(upload)
        return { success: true }
    } catch (error) {
        logger.debug('Failed to start upload:', error)
        return rpcError(getErrorMessage(error, 'Failed to start upload'))
    } finally {
        reservedUploadIds.delete(uploadId)
    }
}

export async function appendUploadFileChunk(data: UploadFileChunkRequest | unknown): Promise<UploadFileOperationResponse> {
    await cleanupStaleUploads()
    if (!isRecord(data)) {
        return rpcError('Invalid upload chunk')
    }

    const sessionId = readSessionId(data.sessionId)
    const uploadId = readUploadId(data.uploadId)
    const offset = readNonNegativeInteger(data.offset)
    const bytes = readChunkBytes(data.content)
    if (!sessionId || !uploadId || offset === null || !bytes) {
        return rpcError('Invalid upload chunk')
    }

    const upload = activeUploads.get(uploadId)
    if (!upload || upload.sessionId !== sessionId) {
        return rpcError('Upload not found')
    }

    return await upload.lock.inLock(async () => {
        if (activeUploads.get(uploadId) !== upload || upload.sessionId !== sessionId) {
            return rpcError('Upload not found')
        }
        if (offset !== upload.writtenBytes) {
            return rpcError('Unexpected upload chunk offset')
        }
        if (upload.writtenBytes + bytes.length > upload.expectedSize) {
            return rpcError('Upload exceeds declared file size')
        }

        try {
            await appendFile(upload.partPath, bytes)
            upload.writtenBytes += bytes.length
            upload.lastActivityAt = Date.now()
            scheduleStaleCleanup(upload)
            return { success: true }
        } catch (error) {
            logger.debug('Failed to append upload chunk:', error)
            return rpcError(getErrorMessage(error, 'Failed to append upload chunk'))
        }
    })
}

export async function finishUploadFile(data: UploadFileFinishRequest | unknown): Promise<UploadFileResponse> {
    await cleanupStaleUploads()
    if (!isRecord(data)) {
        return rpcError('Invalid upload finish request')
    }

    const sessionId = readSessionId(data.sessionId)
    const uploadId = readUploadId(data.uploadId)
    if (!sessionId || !uploadId) {
        return rpcError('Invalid upload finish request')
    }

    const upload = activeUploads.get(uploadId)
    if (!upload || upload.sessionId !== sessionId) {
        const completed = getCompletedUpload(uploadId, sessionId)
        if (completed) {
            return { success: true, path: completed.path }
        }
        return rpcError('Upload not found')
    }

    return await upload.lock.inLock(async () => {
        if (activeUploads.get(uploadId) !== upload || upload.sessionId !== sessionId) {
            const completed = getCompletedUpload(uploadId, sessionId)
            if (completed) {
                return { success: true, path: completed.path }
            }
            return rpcError('Upload not found')
        }
        if (upload.writtenBytes !== upload.expectedSize) {
            return rpcError('Upload is incomplete')
        }

        try {
            await rename(upload.partPath, upload.filePath)
            activeUploads.delete(uploadId)
            clearStaleTimer(upload)
            rememberCompletedUpload(uploadId, sessionId, upload.filePath)
            logger.debug('File uploaded successfully:', upload.filePath)
            return { success: true, path: upload.filePath }
        } catch (error) {
            logger.debug('Failed to finish upload:', error)
            return rpcError(getErrorMessage(error, 'Failed to finish upload'))
        }
    })
}

export async function cancelUploadFile(data: UploadFileCancelRequest | unknown): Promise<UploadFileOperationResponse> {
    if (!isRecord(data)) {
        return rpcError('Invalid upload cancel request')
    }

    const sessionId = readSessionId(data.sessionId)
    const uploadId = readUploadId(data.uploadId)
    if (!sessionId || !uploadId) {
        return rpcError('Invalid upload cancel request')
    }

    const upload = activeUploads.get(uploadId)
    if (upload) {
        if (upload.sessionId !== sessionId) {
            return rpcError('Upload not found')
        }
        await discardActiveUpload(upload)
    }

    const completedResult = await cancelCompletedUpload(uploadId, sessionId)
    if (completedResult) {
        return completedResult
    }
    return { success: true }
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

async function deleteUploadFile(data: DeleteUploadRequest): Promise<DeleteUploadResponse> {
    const path = typeof data?.path === 'string' ? data.path.trim() : ''
    const sessionId = readSessionId(data?.sessionId)
    if (!path) {
        return rpcError('Path is required')
    }
    if (!sessionId || !isPathWithinUploadDir(path, sessionId)) {
        return rpcError('Invalid upload path')
    }

    try {
        await rm(path, { force: true })
        return { success: true }
    } catch (error) {
        logger.debug('Failed to delete upload file:', error)
        return rpcError(getErrorMessage(error, 'Failed to delete upload file'))
    }
}

export function registerUploadHandlers(rpcHandlerManager: RpcHandlerManager): void {
    if (!cleanupRegistered) {
        cleanupRegistered = true
        process.once('exit', cleanupUploadDirsSync)
    }

    rpcHandlerManager.registerHandler<UploadFileStartRequest, UploadFileOperationResponse>(
        RPC_METHODS.UploadFileStart,
        async (data) => await startUploadFile(data)
    )
    rpcHandlerManager.registerHandler<UploadFileChunkRequest, UploadFileOperationResponse>(
        RPC_METHODS.UploadFileChunk,
        async (data) => await appendUploadFileChunk(data)
    )
    rpcHandlerManager.registerHandler<UploadFileFinishRequest, UploadFileResponse>(
        RPC_METHODS.UploadFileFinish,
        async (data) => await finishUploadFile(data)
    )
    rpcHandlerManager.registerHandler<UploadFileCancelRequest, UploadFileOperationResponse>(
        RPC_METHODS.UploadFileCancel,
        async (data) => await cancelUploadFile(data)
    )
    rpcHandlerManager.registerHandler<CleanupUploadSessionRequest, UploadFileOperationResponse>(
        RPC_METHODS.CleanupUploadSession,
        async (data) => {
            const sessionId = readSessionId(data?.sessionId)
            if (!sessionId) {
                return rpcError('Invalid cleanup request')
            }
            await cleanupUploadDir(sessionId)
            return { success: true }
        }
    )
    rpcHandlerManager.registerHandler<DeleteUploadRequest, DeleteUploadResponse>(
        RPC_METHODS.DeleteUpload,
        async (data) => await deleteUploadFile(data)
    )
}
