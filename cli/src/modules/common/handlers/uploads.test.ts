import { describe, expect, it } from 'vitest'
import { cleanupUploadDir, readUploadFileBytes, uploadFileBytes } from './uploads'

describe('upload handlers', () => {
    it('stores uploaded bytes directly and reads them back for preview', async () => {
        // Binary upload path must not require base64 decoding; bytes are written as-is.
        const sessionId = `upload-bytes-${Date.now()}`
        await cleanupUploadDir(sessionId)
        try {
            const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
            const uploaded = await uploadFileBytes({
                sessionId,
                filename: 'screen shot.png',
                mimeType: 'image/png',
                bytes
            })

            expect(uploaded.success).toBe(true)
            expect(typeof uploaded.path).toBe('string')
            const uploadedPath = uploaded.path!

            const read = await readUploadFileBytes(uploadedPath, sessionId)
            expect(read.success).toBe(true)
            if (!read.success) return
            expect(Array.from(read.bytes)).toEqual(Array.from(bytes))
            expect(read.mimeType).toBe('image/png')
            expect(read.fileName).toContain('screen_shot.png')
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })

    it('rejects reading an uploaded file from another session', async () => {
        // Upload blob paths are session-scoped; another session must not fetch the same temp file.
        const sessionId = `upload-owner-${Date.now()}`
        await cleanupUploadDir(sessionId)
        try {
            const uploaded = await uploadFileBytes({
                sessionId,
                filename: 'private.png',
                mimeType: 'image/png',
                bytes: new Uint8Array([1, 2, 3])
            })

            expect(uploaded.success).toBe(true)
            expect(typeof uploaded.path).toBe('string')
            const uploadedPath = uploaded.path!

            const read = await readUploadFileBytes(uploadedPath, `${sessionId}-other`)
            expect(read).toEqual({ success: false, error: 'Invalid upload path' })
        } finally {
            await cleanupUploadDir(sessionId)
        }
    })
})
