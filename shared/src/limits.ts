export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

export const SAFE_RASTER_IMAGE_MIME_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/webp',
    'image/avif'
] as const

export function isSafeRasterImageMimeType(mimeType: string): boolean {
    const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase()
    return Boolean(normalized && (SAFE_RASTER_IMAGE_MIME_TYPES as readonly string[]).includes(normalized))
}
