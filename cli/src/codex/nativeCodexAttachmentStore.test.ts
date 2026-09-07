import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { NativeCodexAttachmentStore, NATIVE_CODEX_ATTACHMENT_TTL_MS } from './nativeCodexAttachmentStore'

const temporaryRoots: string[] = []

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
    }
})

function createStore(): { root: string; store: NativeCodexAttachmentStore } {
    const root = mkdtempSync(join(tmpdir(), 'shapi-native-attachments-'))
    temporaryRoots.push(root)
    return { root, store: new NativeCodexAttachmentStore(root) }
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex')
}

describe('NativeCodexAttachmentStore', () => {
    it('keeps a staged attachment private to its original Codex session', () => {
        const { store } = createStore()
        const bytes = new TextEncoder().encode('hello native attachment')
        const sessionId = '019ff99e-7ad1-7761-841b-4441315c9d36'
        const attachmentId = 'a'.repeat(32)

        expect(store.stage({
            attachmentId,
            codexSessionId: sessionId,
            filename: 'notes.md',
            mimeType: 'text/markdown',
            size: bytes.byteLength,
            sha256: sha256(bytes),
            bytes
        })).toEqual({
            success: true,
            attachment: {
                id: attachmentId,
                filename: 'notes.md',
                mimeType: 'text/markdown',
                size: bytes.byteLength,
                kind: 'file'
            }
        })

        const resolved = store.resolve(sessionId, [attachmentId])
        expect(resolved.success).toBe(true)
        if (resolved.success) {
            expect(resolved.attachments[0]).toMatchObject({
                id: attachmentId,
                filename: 'notes.md',
                kind: 'file'
            })
            expect(resolved.attachments[0]?.path).toContain(attachmentId)
        }
        expect(store.resolve('other-native-session', [attachmentId])).toEqual({
            success: false,
            error: 'Native attachment is unavailable or changed'
        })
    })

    it('expires abandoned stages but retains queue-referenced files', () => {
        const { root, store } = createStore()
        const bytes = new Uint8Array([1, 2, 3])
        const sessionId = '019ff99e-7ad1-7761-841b-4441315c9d36'
        const attachmentId = 'b'.repeat(32)
        expect(store.stage({
            attachmentId,
            codexSessionId: sessionId,
            filename: 'image.png',
            mimeType: 'image/png',
            size: bytes.byteLength,
            sha256: sha256(bytes),
            bytes
        }).success).toBe(true)

        const future = Date.now() + NATIVE_CODEX_ATTACHMENT_TTL_MS + 1
        store.cleanupExpired(new Set([attachmentId]), future)
        expect(store.resolve(sessionId, [attachmentId]).success).toBe(true)

        store.cleanupExpired(new Set(), future)
        expect(existsSync(join(root, attachmentId))).toBe(false)
    })
})
