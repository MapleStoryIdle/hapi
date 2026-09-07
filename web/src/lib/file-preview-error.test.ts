import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { classifyFilePreviewError, FilePreviewError } from './file-preview-error'

describe('file preview error classification', () => {
    it.each([
        ['ENOENT: no such file or directory, open /private/file.png', 'missing'],
        ['EACCES: permission denied', 'denied'],
        ['HTTP 403', 'denied'],
        ['EISDIR: illegal operation on a directory', 'unsupported'],
        ['file too large', 'tooLarge'],
        ['Runner is offline', 'offline'],
        ['Failed to fetch', 'offline'],
        ['RPC timed out', 'offline'],
        ['InvalidCharacterError', 'invalid'],
        ['unexpected secret details /private/token', 'unavailable'],
    ])('maps %s to %s', (message, issue) => {
        expect(classifyFilePreviewError(new Error(message))).toBe(issue)
        expect(classifyFilePreviewError(message)).toBe(issue)
    })
    it('reads known errors inside a managed blob response without assuming every 404 is a missing file', () => {
        expect(classifyFilePreviewError(new ApiError('HTTP 502', 502, undefined, JSON.stringify({ error: 'ENOENT: no such file' })))).toBe('missing')
        expect(classifyFilePreviewError(new ApiError('HTTP 404', 404, undefined, '{"error":"Session not found"}'))).toBe('unavailable')
        expect(classifyFilePreviewError(new ApiError('HTTP 502', 502, undefined, '<html>bad gateway</html>'))).toBe('unavailable')
        expect(classifyFilePreviewError(new ApiError('Denied', 403))).toBe('denied')
        expect(classifyFilePreviewError(new ApiError('Large', 413))).toBe('tooLarge')
        expect(classifyFilePreviewError(new FilePreviewError('empty'))).toBe('empty')
        expect(classifyFilePreviewError(null)).toBe('unavailable')
    })
})
