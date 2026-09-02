import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { rm } from 'fs/promises'
import { dirname } from 'path'
import {
    appendUploadFileChunk,
    cancelUploadFile,
    cleanupStaleUploads,
    cleanupUploadDir,
    finishUploadFile,
    readUploadFileBytes,
    startUploadFile
} from './uploads'

describe('upload handlers', () => {
    it('assembles ordered base64 chunks and exposes only the finished file', async () => {
        const sessionId = `upload-chunks-${Date.now()}`
        const uploadId = `upload${Date.now()}`
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
        await cleanupUploadDir(sessionId)

        try {
            await expect(startUploadFile({
                sessionId,
                uploadId,
                filename: 'screen shot.png',
                mimeType: 'image/png',
                size: bytes.length
            })).resolves.toEqual({ success: true })

            await expect(appendUploadFileChunk({
                sessionId,
                uploadId,
                offset: 0,
                content: Buffer.from(bytes.subarray(0, 5)).toString('base64')
            })).resolves.toEqual({ success: true })
            await expect(appendUploadFileChunk({
                sessionId,
                uploadId,
                offset: 5,
                content: Buffer.from(bytes.subarray(5)).toString('base64')
            })).resolves.toEqual({ success: true })

            const finished = await finishUploadFile({ sessionId, uploadId })
            expect(finished.success).toBe(true)
            if (!finished.success) return

            const read = await readUploadFileBytes(finished.path!, sessionId)
            expect(read.success).toBe(true)
            if (!read.success) return
            expect(Array.from(read.bytes)).toEqual(Array.from(bytes))
            expect(read.mimeType).toBe('image/png')
            expect(read.fileName).toContain('screen_shot.png')
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })

    it('rejects invalid chunk order and encoding, then cancels the partial upload', async () => {
        const sessionId = `upload-validation-${Date.now()}`
        const uploadId = `upload${Date.now()}`
        await cleanupUploadDir(sessionId)

        try {
            await startUploadFile({
                sessionId,
                uploadId,
                filename: 'private.png',
                mimeType: 'image/png',
                size: 3
            })

            await expect(appendUploadFileChunk({
                sessionId,
                uploadId,
                offset: 1,
                content: 'AQID'
            })).resolves.toEqual({ success: false, error: 'Unexpected upload chunk offset' })
            await expect(appendUploadFileChunk({
                sessionId,
                uploadId,
                offset: 0,
                content: 'not-base64'
            })).resolves.toEqual({ success: false, error: 'Invalid upload chunk' })
            await expect(finishUploadFile({ sessionId, uploadId })).resolves.toEqual({
                success: false,
                error: 'Upload is incomplete'
            })

            await expect(cancelUploadFile({ sessionId, uploadId })).resolves.toEqual({ success: true })
            await expect(appendUploadFileChunk({
                sessionId,
                uploadId,
                offset: 0,
                content: 'AQID'
            })).resolves.toEqual({ success: false, error: 'Upload not found' })
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })

    it('removes a stale partial upload before it can be finished', async () => {
        const sessionId = `upload-stale-${Date.now()}`
        const uploadId = `upload${Date.now()}`
        await cleanupUploadDir(sessionId)

        try {
            await startUploadFile({
                sessionId,
                uploadId,
                filename: 'stale.txt',
                mimeType: 'text/plain',
                size: 1
            })

            await cleanupStaleUploads(Date.now() + 10 * 60 * 1000)
            await expect(finishUploadFile({ sessionId, uploadId })).resolves.toEqual({
                success: false,
                error: 'Upload not found'
            })
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })

    it('keeps finished uploads idempotent until cancellation removes the file', async () => {
        const sessionId = `upload-finish-${Date.now()}`
        const uploadId = `upload${Date.now()}`
        await cleanupUploadDir(sessionId)

        try {
            await startUploadFile({
                sessionId,
                uploadId,
                filename: 'finish.txt',
                mimeType: 'text/plain',
                size: 3
            })
            await appendUploadFileChunk({ sessionId, uploadId, offset: 0, content: 'AQID' })

            const firstFinish = await finishUploadFile({ sessionId, uploadId })
            expect(firstFinish.success).toBe(true)
            if (!firstFinish.success) return
            await expect(finishUploadFile({ sessionId, uploadId })).resolves.toEqual(firstFinish)

            await expect(cancelUploadFile({ sessionId, uploadId })).resolves.toEqual({ success: true })
            expect(existsSync(firstFinish.path!)).toBe(false)
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })

    it('does not let a prefix-related session read or clean another upload directory', async () => {
        const fooSessionId = `foo-${Date.now()}`
        const fooBarSessionId = `${fooSessionId}-bar`
        const uploadId = `upload${Date.now()}`
        await Promise.all([cleanupUploadDir(fooSessionId), cleanupUploadDir(fooBarSessionId)])

        try {
            await startUploadFile({
                sessionId: fooBarSessionId,
                uploadId,
                filename: 'private.txt',
                mimeType: 'text/plain',
                size: 1
            })
            await appendUploadFileChunk({ sessionId: fooBarSessionId, uploadId, offset: 0, content: 'AQ==' })
            const finished = await finishUploadFile({ sessionId: fooBarSessionId, uploadId })
            expect(finished.success).toBe(true)
            if (!finished.success) return

            await expect(readUploadFileBytes(finished.path!, fooSessionId)).resolves.toEqual({
                success: false,
                error: 'Invalid upload path'
            })
            await cleanupUploadDir(fooSessionId)
            await expect(readUploadFileBytes(finished.path!, fooBarSessionId)).resolves.toMatchObject({ success: true })
        } finally {
            await Promise.all([cleanupUploadDir(fooSessionId), cleanupUploadDir(fooBarSessionId)])
        }
    })

    it('recreates a removed cached runner upload directory', async () => {
        const sessionId = `upload-cache-${Date.now()}`
        const firstUploadId = `upload${Date.now()}a`
        const secondUploadId = `upload${Date.now()}b`
        await cleanupUploadDir(sessionId)

        try {
            await startUploadFile({
                sessionId,
                uploadId: firstUploadId,
                filename: 'first.txt',
                mimeType: 'text/plain',
                size: 1
            })
            await appendUploadFileChunk({ sessionId, uploadId: firstUploadId, offset: 0, content: 'AQ==' })
            const first = await finishUploadFile({ sessionId, uploadId: firstUploadId })
            expect(first.success).toBe(true)
            if (!first.success) return

            await rm(dirname(first.path!), { recursive: true, force: true })

            await expect(startUploadFile({
                sessionId,
                uploadId: secondUploadId,
                filename: 'second.txt',
                mimeType: 'text/plain',
                size: 1
            })).resolves.toEqual({ success: true })
            await appendUploadFileChunk({ sessionId, uploadId: secondUploadId, offset: 0, content: 'Ag==' })
            await expect(finishUploadFile({ sessionId, uploadId: secondUploadId })).resolves.toMatchObject({ success: true })
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })
})
