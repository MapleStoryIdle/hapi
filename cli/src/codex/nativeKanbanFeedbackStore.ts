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
import { basename, dirname, join } from 'node:path'
import type { NativeKanbanFeedbackReviewGuard } from '@hapi/protocol/codexTranscript'

const MAX_FEEDBACK_BYTES = 10 * 1024 * 1024
const ARTIFACT_ID_RE = /^[a-f0-9]{32}$/

export type NativeKanbanFeedbackStageInput = {
    artifactId: string
    codexSessionId: string
    filename: string
    size: number
    sha256: string
    bytes: Uint8Array | ArrayBuffer
}

export type NativeKanbanFeedbackStageResult =
    | { success: true; path: string }
    | { success: false; error: string }

export type NativeKanbanFeedbackDeleteInput = {
    artifactId: string
    codexSessionId: string
    sha256: string
}

export type NativeKanbanFeedbackDeleteResult =
    | { success: true; deleted: boolean }
    | { success: false; error: string }

export type NativeKanbanFeedbackVerifyResult =
    | { success: true }
    | { success: false; error: string }

type Manifest = {
    version: 1
    artifactId: string
    codexSessionId: string
    filename: string
    size: number
    sha256: string
}

function digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function asBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
    return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function validIdentifier(value: string, max: number): boolean {
    return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function validate(input: NativeKanbanFeedbackStageInput): string | null {
    if (!ARTIFACT_ID_RE.test(input.artifactId)) return 'Invalid feedback artifact id'
    if (!validIdentifier(input.codexSessionId, 200)) return 'Invalid native Codex session id'
    if (!input.filename || basename(input.filename) !== input.filename || !/\.(?:md|markdown)$/i.test(input.filename)) return 'Feedback must be a Markdown filename'
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_FEEDBACK_BYTES) return 'Feedback size must be between 1 byte and 10 MiB'
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) return 'Invalid feedback digest'
    const bytes = asBytes(input.bytes)
    if (bytes.byteLength !== input.size || digest(bytes) !== input.sha256.toLowerCase()) return 'Feedback bytes do not match their declared digest'
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return 'Feedback must be UTF-8 Markdown'
    }
    return null
}

/**
 * A tiny runner-private file vault for native-Codex feedback reviews. The
 * review body is never sent to the Codex prompt, command line, or generic
 * native-message outbox. `artifactId` is the only directory selector.
 */
export class NativeKanbanFeedbackStore {
    constructor(private readonly root: string) {}

    stage(input: NativeKanbanFeedbackStageInput): NativeKanbanFeedbackStageResult {
        const invalid = validate(input)
        if (invalid) return { success: false, error: invalid }
        const bytes = asBytes(input.bytes)
        const normalizedDigest = input.sha256.toLowerCase()
        const directory = this.stageDirectory(input.artifactId)
        const temporaryDirectory = this.temporaryStageDirectory(input.artifactId)
        const contentPath = this.contentPath(input.artifactId)
        const manifest: Manifest = {
            version: 1,
            artifactId: input.artifactId,
            codexSessionId: input.codexSessionId,
            filename: input.filename.normalize('NFC'),
            size: input.size,
            sha256: normalizedDigest
        }
        try {
            this.ensurePrivateDirectory(this.root)
            if (existsSync(directory)) {
                const existing = this.inspectCompleteStage(directory, manifest, bytes)
                if (existing === 'complete') return { success: true, path: contentPath }
                if (existing === 'conflict') return { success: false, error: 'Feedback stage id already belongs to different content' }
                if (!this.canRemoveIncompleteStage(directory, input.artifactId, input.codexSessionId, normalizedDigest)) {
                    return { success: false, error: 'Feedback stage is incomplete and cannot be repaired safely' }
                }
                this.removeStageDirectory(directory)
            }

            // A previously crashed writer can leave only one of these files.
            // It is safe to repair only a stage that proves the caller's
            // artifact/digest identity (or an empty, private skeleton).
            if (existsSync(temporaryDirectory)) {
                if (!this.canRemoveIncompleteStage(temporaryDirectory, input.artifactId, input.codexSessionId, normalizedDigest)) {
                    return { success: false, error: 'Feedback stage preparation is already in progress' }
                }
                this.removeStageDirectory(temporaryDirectory)
            }

            // Build the complete private directory away from the canonical
            // path. A reader can only ever observe the final directory after
            // the one same-filesystem rename below.
            mkdirSync(temporaryDirectory, { recursive: false, mode: 0o700 })
            chmodSync(temporaryDirectory, 0o700)
            const temporaryContentPath = join(temporaryDirectory, 'feedback.md')
            const temporaryManifestPath = join(temporaryDirectory, 'manifest.json')
            writeFileSync(temporaryContentPath, bytes, { flag: 'wx', mode: 0o600 })
            chmodSync(temporaryContentPath, 0o600)
            writeFileSync(temporaryManifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
            chmodSync(temporaryManifestPath, 0o600)
            // Check our own complete tree before publishing it. This catches
            // unexpected filesystem hooks without exposing a half-stage.
            if (this.inspectCompleteStage(temporaryDirectory, manifest, bytes) !== 'complete') {
                throw new Error('Could not validate staged feedback before publishing it')
            }
            renameSync(temporaryDirectory, directory)
            return { success: true, path: contentPath }
        } catch (error) {
            // The canonical directory was never created by this attempt until
            // the final rename. The deterministic temporary sibling can be
            // safely retried/cleaned only when it matches this identity.
            try {
                if (existsSync(temporaryDirectory) && this.canRemoveIncompleteStage(temporaryDirectory, input.artifactId, input.codexSessionId, normalizedDigest)) {
                    this.removeStageDirectory(temporaryDirectory)
                }
            } catch {
                // Preserve the original staging failure. A future retry or
                // explicit revoke can repair a matching incomplete stage.
            }
            return { success: false, error: error instanceof Error ? error.message : 'Could not stage native feedback' }
        }
    }

    delete(input: NativeKanbanFeedbackDeleteInput): NativeKanbanFeedbackDeleteResult {
        if (!ARTIFACT_ID_RE.test(input.artifactId) || !validIdentifier(input.codexSessionId, 200) || !/^[a-f0-9]{64}$/i.test(input.sha256)) {
            return { success: false, error: 'Invalid feedback stage identity' }
        }
        const directory = this.stageDirectory(input.artifactId)
        const temporaryDirectory = this.temporaryStageDirectory(input.artifactId)
        if (!existsSync(directory) && !existsSync(temporaryDirectory)) return { success: true, deleted: false }
        try {
            let deleted = false
            for (const candidate of [directory, temporaryDirectory]) {
                if (!existsSync(candidate)) continue
                if (!this.canRemoveIncompleteStage(candidate, input.artifactId, input.codexSessionId, input.sha256.toLowerCase())) {
                    return { success: false, error: 'Feedback stage identity does not match' }
                }
                this.removeStageDirectory(candidate)
                deleted = true
            }
            return { success: true, deleted }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Could not delete native feedback stage' }
        }
    }

    /**
     * Validate a delivery guard issued by `stage`. The caller never supplies
     * a filesystem selector: `stagePath` must equal this store's canonical
     * artifact path and the manifest, bytes, and digest must still agree.
     */
    verify(codexSessionId: string, guard: NativeKanbanFeedbackReviewGuard): NativeKanbanFeedbackVerifyResult {
        if (!validIdentifier(codexSessionId, 200) || !guard || typeof guard.stagePath !== 'string' || !/^[a-f0-9]{64}$/i.test(guard.sha256)) {
            return { success: false, error: 'Native feedback review guard is invalid' }
        }
        const artifactId = basename(dirname(guard.stagePath))
        if (!ARTIFACT_ID_RE.test(artifactId)) return { success: false, error: 'Native feedback review path is invalid' }
        const expectedPath = this.contentPath(artifactId)
        if (guard.stagePath !== expectedPath) return { success: false, error: 'Native feedback review path is not runner-owned' }

        try {
            const directory = this.stageDirectory(artifactId)
            const manifestPath = join(directory, 'manifest.json')
            if (!this.isPrivateDirectory(directory) || !this.isRegularFile(manifestPath) || !this.isRegularFile(expectedPath)) {
                return { success: false, error: 'Native feedback stage is incomplete' }
            }
            const manifest = this.readManifest(manifestPath)
            if (!manifest || manifest.artifactId !== artifactId || manifest.codexSessionId !== codexSessionId || manifest.sha256 !== guard.sha256.toLowerCase()) {
                return { success: false, error: 'Native feedback stage identity does not match' }
            }
            const bytes = readFileSync(expectedPath)
            if (bytes.length !== manifest.size || digest(bytes) !== manifest.sha256) {
                return { success: false, error: 'Native feedback stage content changed after staging' }
            }
            return { success: true }
        } catch {
            return { success: false, error: 'Native feedback stage cannot be read safely' }
        }
    }

    private stageDirectory(artifactId: string): string {
        // artifactId is validated before every operation; never accept a path
        // supplied by the hub or browser.
        return join(this.root, artifactId)
    }

    private temporaryStageDirectory(artifactId: string): string {
        return join(this.root, `.${artifactId}.staging`)
    }

    private contentPath(artifactId: string): string {
        return join(this.stageDirectory(artifactId), 'feedback.md')
    }

    private ensurePrivateDirectory(path: string): void {
        mkdirSync(path, { recursive: true, mode: 0o700 })
        if (lstatSync(path).isSymbolicLink()) throw new Error('Feedback stage root is unsafe')
        chmodSync(path, 0o700)
    }

    private readManifest(path: string): Manifest | null {
        try {
            const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>
            if (
                parsed.version !== 1
                || typeof parsed.artifactId !== 'string'
                || typeof parsed.codexSessionId !== 'string'
                || typeof parsed.filename !== 'string'
                || typeof parsed.size !== 'number'
                || typeof parsed.sha256 !== 'string'
            ) return null
            return parsed as Manifest
        } catch {
            return null
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

    private isPrivateDirectory(path: string): boolean {
        try {
            const entry = lstatSync(path)
            return entry.isDirectory() && !entry.isSymbolicLink()
        } catch {
            return false
        }
    }

    private inspectCompleteStage(directory: string, expected: Manifest, expectedBytes: Uint8Array): 'complete' | 'incomplete' | 'conflict' {
        if (!this.isPrivateDirectory(directory)) return 'incomplete'
        const manifestPath = join(directory, 'manifest.json')
        const contentPath = join(directory, 'feedback.md')
        if (!this.isRegularFile(manifestPath) || !this.isRegularFile(contentPath)) return 'incomplete'
        const manifest = this.readManifest(manifestPath)
        if (!manifest) return 'incomplete'
        if (
            manifest.artifactId !== expected.artifactId
            || manifest.codexSessionId !== expected.codexSessionId
            || manifest.sha256 !== expected.sha256
        ) return 'conflict'
        // The immutable artifact id + digest define idempotency. Preserve the
        // original display filename if a retry supplies a harmlessly different
        // name, but repair any inconsistent byte-size manifest.
        if (manifest.size !== expected.size) return 'incomplete'
        try {
            const content = readFileSync(contentPath)
            return content.length === expectedBytes.length && digest(content) === expected.sha256
                ? 'complete'
                : 'incomplete'
        } catch {
            return 'incomplete'
        }
    }

    /**
     * Half-stages from older runners have no atomic publish guarantee. Remove
     * only deterministic, private skeletons that either carry the exact
     * manifest identity, carry bytes with the expected digest, or are empty.
     */
    private canRemoveIncompleteStage(directory: string, artifactId: string, codexSessionId: string, sha256: string): boolean {
        if (!this.isPrivateDirectory(directory)) return false
        let entries: string[]
        try {
            entries = readdirSync(directory)
        } catch {
            return false
        }
        if (!entries.every((entry) => entry === 'feedback.md' || entry === 'manifest.json')) return false
        if (entries.length === 0) return true

        const manifestPath = join(directory, 'manifest.json')
        const manifest = this.isRegularFile(manifestPath) ? this.readManifest(manifestPath) : null
        if (manifest) {
            return manifest.artifactId === artifactId
                && manifest.codexSessionId === codexSessionId
                && manifest.sha256 === sha256
        }

        const contentPath = join(directory, 'feedback.md')
        if (!this.isRegularFile(contentPath)) return false
        try {
            return digest(readFileSync(contentPath)) === sha256
        } catch {
            return false
        }
    }

    private removeStageDirectory(directory: string): void {
        if (!this.isPrivateDirectory(directory)) throw new Error('Feedback stage directory is unsafe')
        rmSync(directory, { recursive: true, force: true, maxRetries: 1 })
    }
}
