import { describe, expect, it } from 'vitest'
import { isPreviewableImageMimeType } from './fileAttachments'

describe('isPreviewableImageMimeType', () => {
    it('allows only safe raster image previews', () => {
        // Previewing via <img> should match the CLI-side magic-byte supported formats.
        expect(isPreviewableImageMimeType('image/png')).toBe(true)
        expect(isPreviewableImageMimeType('image/jpeg')).toBe(true)
        expect(isPreviewableImageMimeType('image/webp')).toBe(true)
        expect(isPreviewableImageMimeType('image/avif')).toBe(true)
        expect(isPreviewableImageMimeType('IMAGE/PNG; charset=binary')).toBe(true)
    })

    it('does not preview SVG or generic image types', () => {
        // SVG and unknown image/* values stay as file attachments, not inline image previews.
        expect(isPreviewableImageMimeType('image/svg+xml')).toBe(false)
        expect(isPreviewableImageMimeType('image/heic')).toBe(false)
        expect(isPreviewableImageMimeType('application/octet-stream')).toBe(false)
    })
})
