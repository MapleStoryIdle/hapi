import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_ID_LENGTH = 256
const MAX_FILE_NAME_LENGTH = 255

export const GENERATED_IMAGE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif'
])

type GeneratedImageMetadata = {
    mimeType: string
    fileName: string
}

export type GeneratedImageStoreInput = {
    namespace: string
    imageId: string
    mimeType: string
    fileName: string
    bytes: Uint8Array | ArrayBuffer
}

export type StoredGeneratedImage = {
    bytes: Buffer
    mimeType: string
    fileName: string
}

function detectImageMimeType(bytes: Uint8Array): string | null {
    if (bytes.length >= 8
        && bytes[0] === 0x89
        && bytes[1] === 0x50
        && bytes[2] === 0x4e
        && bytes[3] === 0x47
        && bytes[4] === 0x0d
        && bytes[5] === 0x0a
        && bytes[6] === 0x1a
        && bytes[7] === 0x0a) {
        return 'image/png'
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg'
    }

    if (bytes.length >= 6) {
        const header = ascii(bytes, 0, 6)
        if (header === 'GIF87a' || header === 'GIF89a') {
            return 'image/gif'
        }
    }

    if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
        return 'image/webp'
    }

    if (bytes.length >= 12
        && bytes[0] === 0x00
        && bytes[1] === 0x00
        && bytes[2] === 0x00
        && ascii(bytes, 4, 8) === 'ftyp'
        && (ascii(bytes, 8, 12) === 'avif' || ascii(bytes, 8, 12) === 'avis')) {
        return 'image/avif'
    }

    return null
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
    return String.fromCharCode(...bytes.subarray(start, end))
}

function normalizeBytes(value: Uint8Array | ArrayBuffer): Buffer {
    return value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value)
}

function normalizeFileName(fileName: string): string {
    const sanitized = fileName
        .replace(/[\\/]/g, '_')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .trim()
        .slice(0, MAX_FILE_NAME_LENGTH)
    return sanitized || 'generated-image'
}

function assetKey(namespace: string, imageId: string): string {
    return createHash('sha256').update(namespace).update('\0').update(imageId).digest('hex')
}

async function writeAtomically(path: string, contents: string | Uint8Array): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
        await writeFile(temporaryPath, contents, { mode: 0o600 })
        await rename(temporaryPath, path)
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
}

/**
 * Stores generated-image bytes outside SQLite. Assets are keyed by namespace
 * and image id, so a session-history merge does not orphan its image records.
 */
export class GeneratedImageStore {
    constructor(private readonly rootDir: string) {}

    async persist(input: GeneratedImageStoreInput): Promise<void> {
        if (!input.namespace || input.namespace.length > MAX_IMAGE_ID_LENGTH) {
            throw new Error('Invalid generated image namespace')
        }
        if (!input.imageId || input.imageId.length > MAX_IMAGE_ID_LENGTH) {
            throw new Error('Invalid generated image id')
        }
        if (!SUPPORTED_IMAGE_MIME_TYPES.has(input.mimeType)) {
            throw new Error('Unsupported generated image type')
        }

        const bytes = normalizeBytes(input.bytes)
        if (bytes.length === 0 || bytes.length > MAX_GENERATED_IMAGE_BYTES) {
            throw new Error('Generated image is too large')
        }
        if (detectImageMimeType(bytes) !== input.mimeType) {
            throw new Error('Generated image content does not match its MIME type')
        }

        const key = assetKey(input.namespace, input.imageId)
        const imagePath = join(this.rootDir, `${key}.image`)
        const metadataPath = join(this.rootDir, `${key}.json`)
        const metadata: GeneratedImageMetadata = {
            mimeType: input.mimeType,
            fileName: normalizeFileName(input.fileName)
        }

        await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
        await writeAtomically(imagePath, bytes)
        await writeAtomically(metadataPath, JSON.stringify(metadata))
    }

    async read(namespace: string, imageId: string): Promise<StoredGeneratedImage | null> {
        if (!namespace || !imageId || imageId.length > MAX_IMAGE_ID_LENGTH) {
            return null
        }

        const key = assetKey(namespace, imageId)
        try {
            const [bytes, rawMetadata] = await Promise.all([
                readFile(join(this.rootDir, `${key}.image`)),
                readFile(join(this.rootDir, `${key}.json`), 'utf8')
            ])
            const metadata = JSON.parse(rawMetadata) as Partial<GeneratedImageMetadata>
            if (!SUPPORTED_IMAGE_MIME_TYPES.has(metadata.mimeType ?? '')
                || typeof metadata.fileName !== 'string'
                || detectImageMimeType(bytes) !== metadata.mimeType) {
                return null
            }

            return {
                bytes,
                mimeType: metadata.mimeType,
                fileName: normalizeFileName(metadata.fileName)
            }
        } catch {
            return null
        }
    }

    /** Removes complete image records (and stale orphan files) older than the retention period. */
    async pruneExpired(now: number = Date.now(), retentionMs: number = GENERATED_IMAGE_RETENTION_MS): Promise<number> {
        const cutoff = now - retentionMs
        const records = new Map<string, { paths: string[]; latestModifiedAt: number }>()

        try {
            const entries = await readdir(this.rootDir, { withFileTypes: true })
            for (const entry of entries) {
                if (!entry.isFile()) continue
                const match = /^([a-f0-9]{64})\.(image|json)$/.exec(entry.name)
                if (!match) continue

                const path = join(this.rootDir, entry.name)
                let modifiedAt: number
                try {
                    modifiedAt = (await stat(path)).mtimeMs
                } catch {
                    continue
                }

                const key = match[1]
                const record = records.get(key) ?? { paths: [], latestModifiedAt: modifiedAt }
                record.paths.push(path)
                record.latestModifiedAt = Math.max(record.latestModifiedAt, modifiedAt)
                records.set(key, record)
            }
        } catch {
            return 0
        }

        let deleted = 0
        for (const record of records.values()) {
            if (record.latestModifiedAt >= cutoff) continue
            await Promise.all(record.paths.map((path) => rm(path, { force: true })))
            deleted += 1
        }
        return deleted
    }
}
