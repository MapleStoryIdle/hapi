import { createHash } from 'node:crypto'
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import {
    MAX_NATIVE_CODEX_ATTACHMENT_BYTES,
    type NativeCodexAttachment,
    type NativeCodexResolvedAttachment
} from '@hapi/protocol/codexTranscript'
import type {
    NativeCodexAttachmentDeleteRequest,
    NativeCodexAttachmentDeleteResponse,
    NativeCodexAttachmentStageRequest,
    NativeCodexAttachmentStageResponse
} from '@hapi/protocol'

const ATTACHMENT_ID_RE = /^[a-f0-9]{32}$/
const MAX_SESSION_ID_LENGTH = 200
export const NATIVE_CODEX_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1_000

type Manifest = NativeCodexAttachment & {
    version: 1
    codexSessionId: string
    sha256: string
    createdAt: number
    contentName: string
}

export type NativeCodexAttachmentResolveResult =
    | { success: true; attachments: NativeCodexResolvedAttachment[] }
    | { success: false; error: string }

function digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function hasControlCharacters(value: string): boolean {
    return /[\u0000-\u001f\u007f]/.test(value)
}

function validSessionId(value: string): boolean {
    return value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && !hasControlCharacters(value)
}

function validFilename(value: string): boolean {
    return value.length > 0
        && value.length <= 255
        && value !== '.'
        && value !== '..'
        && basename(value) === value
        && !/[\\/]/.test(value)
        && !hasControlCharacters(value)
}

function validMimeType(value: string): boolean {
    return value.length > 0 && value.length <= 255 && !hasControlCharacters(value)
}

function imageKind(mimeType: string): NativeCodexAttachment['kind'] {
    return /^image\/(?:png|jpe?g|gif|webp)$/i.test(mimeType) ? 'image' : 'file'
}

function sameAttachment(left: NativeCodexAttachment, right: NativeCodexAttachment): boolean {
    return left.id === right.id
        && left.filename === right.filename
        && left.mimeType === right.mimeType
        && left.size === right.size
        && left.kind === right.kind
}

/**
 * Runner-private attachment vault for original native Codex threads. Browser
 * and Hub callers only know an opaque id; path lookup, integrity checking and
 * deletion always happen against a manifest inside this root.
 */
export class NativeCodexAttachmentStore {
    constructor(private readonly root: string) {}

    stage(input: NativeCodexAttachmentStageRequest): NativeCodexAttachmentStageResponse {
        const validationError = this.validateStage(input)
        if (validationError) return { success: false, error: validationError }

        const attachment: NativeCodexAttachment = {
            id: input.attachmentId,
            filename: input.filename.normalize('NFC'),
            mimeType: input.mimeType,
            size: input.size,
            kind: imageKind(input.mimeType)
        }
        const bytes = asBytes(input.bytes)
        const normalizedDigest = input.sha256.toLowerCase()
        const directory = this.stageDirectory(attachment.id)
        const temporaryDirectory = this.temporaryDirectory(attachment.id)
        // Do not derive a physical filename from browser-controlled text.
        // Metadata preserves the original display name; the on-disk name is
        // intentionally fixed and never leaks back through the protocol.
        const contentName = 'content'
        const manifest: Manifest = {
            version: 1,
            ...attachment,
            codexSessionId: input.codexSessionId,
            sha256: normalizedDigest,
            createdAt: Date.now(),
            contentName
        }

        try {
            this.ensurePrivateDirectory(this.root)
            if (existsSync(directory)) {
                const existing = this.readCompleteManifest(directory)
                if (
                    existing
                    && existing.codexSessionId === manifest.codexSessionId
                    && existing.sha256 === manifest.sha256
                    && sameAttachment(existing, manifest)
                    && this.contentMatches(directory, existing)
                ) {
                    return { success: true, attachment }
                }
                return { success: false, error: 'Native attachment id already belongs to different content' }
            }
            if (existsSync(temporaryDirectory)) {
                return { success: false, error: 'Native attachment staging is already in progress' }
            }

            mkdirSync(temporaryDirectory, { recursive: false, mode: 0o700 })
            chmodSync(temporaryDirectory, 0o700)
            const temporaryContentPath = join(temporaryDirectory, contentName)
            const temporaryManifestPath = join(temporaryDirectory, 'manifest.json')
            writeFileSync(temporaryContentPath, bytes, { flag: 'wx', mode: 0o600 })
            chmodSync(temporaryContentPath, 0o600)
            writeFileSync(temporaryManifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
            chmodSync(temporaryManifestPath, 0o600)
            if (!this.contentMatches(temporaryDirectory, manifest)) {
                throw new Error('Could not verify native attachment before publishing it')
            }
            renameSync(temporaryDirectory, directory)
            return { success: true, attachment }
        } catch (error) {
            try {
                if (this.isPrivateDirectory(temporaryDirectory)) {
                    this.removeStageDirectory(temporaryDirectory)
                }
            } catch {
                // Keep the primary error; an incomplete private directory can
                // be collected by the TTL sweep without exposing its content.
            }
            return { success: false, error: error instanceof Error ? error.message : 'Could not stage native attachment' }
        }
    }

    delete(input: NativeCodexAttachmentDeleteRequest): NativeCodexAttachmentDeleteResponse {
        const attachmentId = typeof input?.attachmentId === 'string' ? input.attachmentId.trim() : ''
        const codexSessionId = typeof input?.codexSessionId === 'string' ? input.codexSessionId.trim() : ''
        if (!ATTACHMENT_ID_RE.test(attachmentId) || !validSessionId(codexSessionId)) {
            return { success: false, error: 'Invalid native attachment identity' }
        }
        const directory = this.stageDirectory(attachmentId)
        if (!existsSync(directory)) return { success: true, deleted: false }
        try {
            const manifest = this.readCompleteManifest(directory)
            if (!manifest || manifest.codexSessionId !== codexSessionId || !this.contentMatches(directory, manifest)) {
                return { success: false, error: 'Native attachment identity does not match' }
            }
            this.removeStageDirectory(directory)
            return { success: true, deleted: true }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Could not delete native attachment' }
        }
    }

    deleteMany(codexSessionId: string, attachmentIds: readonly string[]): void {
        for (const attachmentId of attachmentIds) {
            this.delete({ codexSessionId, attachmentId })
        }
    }

    resolve(codexSessionId: string, attachmentIds: readonly string[]): NativeCodexAttachmentResolveResult {
        if (!validSessionId(codexSessionId)) return { success: false, error: 'Invalid native Codex session id' }
        if (attachmentIds.length > 10) return { success: false, error: 'Too many native attachments' }
        const ids = new Set<string>()
        const attachments: NativeCodexResolvedAttachment[] = []
        for (const rawAttachmentId of attachmentIds) {
            const attachmentId = typeof rawAttachmentId === 'string' ? rawAttachmentId.trim() : ''
            if (!ATTACHMENT_ID_RE.test(attachmentId) || ids.has(attachmentId)) {
                return { success: false, error: 'Native attachment id is invalid' }
            }
            ids.add(attachmentId)
            const directory = this.stageDirectory(attachmentId)
            const manifest = this.readCompleteManifest(directory)
            if (!manifest || manifest.codexSessionId !== codexSessionId || !this.contentMatches(directory, manifest)) {
                return { success: false, error: 'Native attachment is unavailable or changed' }
            }
            attachments.push({
                id: manifest.id,
                filename: manifest.filename,
                mimeType: manifest.mimeType,
                size: manifest.size,
                kind: manifest.kind,
                path: join(directory, manifest.contentName)
            })
        }
        return { success: true, attachments }
    }

    /** Remove orphaned stages while retaining IDs currently referenced by the durable outbox. */
    cleanupExpired(retainedAttachmentIds: ReadonlySet<string>, now = Date.now()): void {
        if (!this.isPrivateDirectory(this.root)) return
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            if (/^\.[a-f0-9]{32}\.staging$/.test(entry.name)) {
                const temporaryDirectory = join(this.root, entry.name)
                try {
                    const age = now - lstatSync(temporaryDirectory).mtimeMs
                    if (age >= NATIVE_CODEX_ATTACHMENT_TTL_MS && this.isPrivateDirectory(temporaryDirectory)) {
                        this.removeStageDirectory(temporaryDirectory)
                    }
                } catch {
                    // A later sweep can retry a transient filesystem failure.
                }
                continue
            }
            if (!ATTACHMENT_ID_RE.test(entry.name) || retainedAttachmentIds.has(entry.name)) continue
            const directory = this.stageDirectory(entry.name)
            const manifest = this.readCompleteManifest(directory)
            if (!manifest || now - manifest.createdAt < NATIVE_CODEX_ATTACHMENT_TTL_MS) continue
            try {
                this.removeStageDirectory(directory)
            } catch {
                // A later sweep can retry a transient filesystem failure.
            }
        }
    }

    private validateStage(input: NativeCodexAttachmentStageRequest): string | null {
        if (!ATTACHMENT_ID_RE.test(input?.attachmentId ?? '')) return 'Invalid native attachment id'
        if (!validSessionId(input?.codexSessionId ?? '')) return 'Invalid native Codex session id'
        if (!validFilename(input?.filename ?? '')) return 'Invalid native attachment filename'
        if (!validMimeType(input?.mimeType ?? '')) return 'Invalid native attachment MIME type'
        if (!Number.isSafeInteger(input?.size) || input.size < 0 || input.size > MAX_NATIVE_CODEX_ATTACHMENT_BYTES) {
            return 'Native attachments must be at most 10 MiB'
        }
        if (!/^[a-f0-9]{64}$/i.test(input?.sha256 ?? '')) return 'Invalid native attachment digest'
        const bytes = asBytes(input.bytes)
        if (bytes.byteLength !== input.size || digest(bytes) !== input.sha256.toLowerCase()) {
            return 'Native attachment bytes do not match their declared digest'
        }
        return null
    }

    private stageDirectory(attachmentId: string): string {
        return join(this.root, attachmentId)
    }

    private temporaryDirectory(attachmentId: string): string {
        return join(this.root, `.${attachmentId}.staging`)
    }

    private ensurePrivateDirectory(path: string): void {
        mkdirSync(path, { recursive: true, mode: 0o700 })
        if (lstatSync(path).isSymbolicLink()) throw new Error('Native attachment root is unsafe')
        chmodSync(path, 0o700)
    }

    private isPrivateDirectory(path: string): boolean {
        try {
            const entry = lstatSync(path)
            return entry.isDirectory() && !entry.isSymbolicLink()
        } catch {
            return false
        }
    }

    private isRegularFile(path: string): boolean {
        try {
            const entry = lstatSync(path)
            return entry.isFile() && !entry.isSymbolicLink()
        } catch {
            return false
        }
    }

    private readCompleteManifest(directory: string): Manifest | null {
        if (!this.isPrivateDirectory(directory)) return null
        const manifestPath = join(directory, 'manifest.json')
        if (!this.isRegularFile(manifestPath)) return null
        try {
            const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<Manifest>
            if (
                parsed.version !== 1
                || typeof parsed.id !== 'string'
                || !ATTACHMENT_ID_RE.test(parsed.id)
                || typeof parsed.codexSessionId !== 'string'
                || !validSessionId(parsed.codexSessionId)
                || typeof parsed.filename !== 'string'
                || !validFilename(parsed.filename)
                || typeof parsed.mimeType !== 'string'
                || !validMimeType(parsed.mimeType)
                || typeof parsed.size !== 'number'
                || !Number.isSafeInteger(parsed.size)
                || parsed.size < 0
                || parsed.size > MAX_NATIVE_CODEX_ATTACHMENT_BYTES
                || (parsed.kind !== 'image' && parsed.kind !== 'file')
                || parsed.kind !== imageKind(parsed.mimeType)
                || typeof parsed.sha256 !== 'string'
                || !/^[a-f0-9]{64}$/i.test(parsed.sha256)
                || typeof parsed.createdAt !== 'number'
                || !Number.isFinite(parsed.createdAt)
                || typeof parsed.contentName !== 'string'
                || !validFilename(parsed.contentName)
            ) return null
            return parsed as Manifest
        } catch {
            return null
        }
    }

    private contentMatches(directory: string, manifest: Manifest): boolean {
        const contentPath = join(directory, manifest.contentName)
        if (!this.isRegularFile(contentPath)) return false
        try {
            const bytes = readFileSync(contentPath)
            return bytes.byteLength === manifest.size && digest(bytes) === manifest.sha256
        } catch {
            return false
        }
    }

    private removeStageDirectory(directory: string): void {
        if (!this.isPrivateDirectory(directory)) throw new Error('Native attachment directory is unsafe')
        rmSync(directory, { recursive: true, force: true, maxRetries: 1 })
    }
}
