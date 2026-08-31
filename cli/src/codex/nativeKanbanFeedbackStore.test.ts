import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeKanbanFeedbackStore } from './nativeKanbanFeedbackStore'

const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'hapi-native-kanban-stage-'))
    directories.push(root)
    const bytes = new TextEncoder().encode('---\nhapi_feedback: 1\n---\nReview')
    return {
        root,
        bytes,
        input: {
            artifactId: 'a'.repeat(32),
            codexSessionId: 'native-session-1',
            filename: 'review.md',
            size: bytes.length,
            sha256: sha256(bytes),
            bytes
        }
    }
}

describe('NativeKanbanFeedbackStore', () => {
    it('stages private UTF-8 Markdown atomically and idempotently', () => {
        const { root, input, bytes } = fixture()
        const store = new NativeKanbanFeedbackStore(root)
        const first = store.stage(input)
        expect(first).toEqual(expect.objectContaining({ success: true }))
        if (first.success !== true) throw new Error(first.error)
        expect(readFileSync(first.path)).toEqual(Buffer.from(bytes))
        expect(statSync(first.path).mode & 0o777).toBe(0o600)
        expect(store.stage(input)).toEqual(first)
        expect(store.stage({ ...input, filename: 'retry-name.md' })).toEqual(first)
    })

    it('rejects changed content for the same deterministic stage id', () => {
        const { input } = fixture()
        const store = new NativeKanbanFeedbackStore(join(directories[0]!, 'stages'))
        expect(store.stage(input).success).toBe(true)
        const other = new TextEncoder().encode('different')
        expect(store.stage({ ...input, bytes: other, size: other.length, sha256: sha256(other) })).toEqual({
            success: false,
            error: 'Feedback stage id already belongs to different content'
        })
    })

    it('rejects traversal names and non-UTF-8 feedback before writing a stage', () => {
        const { root, input } = fixture()
        const store = new NativeKanbanFeedbackStore(join(root, 'stages'))
        expect(store.stage({ ...input, filename: '../review.md' })).toEqual({
            success: false,
            error: 'Feedback must be a Markdown filename'
        })
        const bytes = new Uint8Array([0xc3, 0x28])
        expect(store.stage({ ...input, bytes, size: bytes.length, sha256: sha256(bytes) })).toEqual({
            success: false,
            error: 'Feedback must be UTF-8 Markdown'
        })
        expect(existsSync(join(root, 'stages', input.artifactId))).toBe(false)
    })

    it('deletes only a stage whose session and digest identity match', () => {
        const { input } = fixture()
        const store = new NativeKanbanFeedbackStore(join(directories[0]!, 'stages'))
        const staged = store.stage(input)
        expect(staged.success).toBe(true)
        expect(store.delete({ artifactId: input.artifactId, codexSessionId: 'other-session', sha256: input.sha256 }).success).toBe(false)
        expect(store.delete({ artifactId: input.artifactId, codexSessionId: input.codexSessionId, sha256: input.sha256 })).toEqual({ success: true, deleted: true })
        expect(existsSync(join(directories[0]!, 'stages', input.artifactId))).toBe(false)
    })

    it('repairs matching legacy half-stages before atomically publishing the canonical directory', () => {
        const { root, input, bytes } = fixture()
        const stageRoot = join(root, 'stages')
        const canonical = join(stageRoot, input.artifactId)
        const store = new NativeKanbanFeedbackStore(stageRoot)

        mkdirSync(canonical, { recursive: true, mode: 0o700 })
        writeFileSync(join(canonical, 'feedback.md'), bytes, { mode: 0o600 })
        expect(store.stage(input)).toMatchObject({ success: true })
        expect(readFileSync(join(canonical, 'feedback.md'))).toEqual(Buffer.from(bytes))
        expect(existsSync(join(canonical, 'manifest.json'))).toBe(true)
        expect(existsSync(join(stageRoot, `.${input.artifactId}.staging`))).toBe(false)

        rmSync(canonical, { recursive: true, force: true })
        mkdirSync(canonical, { recursive: true, mode: 0o700 })
        writeFileSync(join(canonical, 'manifest.json'), JSON.stringify({
            version: 1,
            artifactId: input.artifactId,
            codexSessionId: input.codexSessionId,
            filename: input.filename,
            size: input.size,
            sha256: input.sha256
        }), { mode: 0o600 })
        expect(store.stage(input)).toMatchObject({ success: true })
        expect(readFileSync(join(canonical, 'feedback.md'))).toEqual(Buffer.from(bytes))
    })

    it('deletes matching legacy half-stages and verifies only its canonical staged path', () => {
        const { root, input, bytes } = fixture()
        const stageRoot = join(root, 'stages')
        const canonical = join(stageRoot, input.artifactId)
        const store = new NativeKanbanFeedbackStore(stageRoot)
        mkdirSync(canonical, { recursive: true, mode: 0o700 })
        writeFileSync(join(canonical, 'feedback.md'), bytes, { mode: 0o600 })

        expect(store.delete({ artifactId: input.artifactId, codexSessionId: input.codexSessionId, sha256: input.sha256 })).toEqual({ success: true, deleted: true })
        expect(existsSync(canonical)).toBe(false)

        const staged = store.stage(input)
        expect(staged.success).toBe(true)
        if (staged.success !== true) throw new Error(staged.error)
        expect(store.verify(input.codexSessionId, { stagePath: staged.path, sha256: input.sha256 })).toEqual({ success: true })
        expect(store.verify(input.codexSessionId, { stagePath: join(root, 'not-runner-owned.md'), sha256: input.sha256 }).success).toBe(false)
    })
})
