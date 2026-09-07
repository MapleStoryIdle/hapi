import { describe, expect, it, vi } from 'vitest'
import type { PendingAttachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import { createNativeCodexAttachmentAdapter } from './nativeCodexAttachmentAdapter'

describe('createNativeCodexAttachmentAdapter', () => {
    it('marks a staged image as ready so an attachment-only message can be sent', async () => {
        const attachmentId = 'a'.repeat(32)
        const api = {
            uploadCodexSessionAttachment: vi.fn().mockResolvedValue({
                success: true,
                attachment: {
                    id: attachmentId,
                    filename: 'photo.png',
                    mimeType: 'image/png',
                    size: 5,
                    kind: 'image'
                }
            })
        } as unknown as ApiClient
        const adapter = createNativeCodexAttachmentAdapter(api, 'session-1', 'machine-1')
        const states: PendingAttachment[] = []
        const added = adapter.add({
            file: new File(['image'], 'photo.png', { type: 'image/png' })
        }) as AsyncIterable<PendingAttachment>

        for await (const state of added) {
            states.push(state)
        }

        const ready = states.at(-1) as (typeof states)[number] & { path?: string }
        expect(ready.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect(ready.path).toBe(`native-codex:${attachmentId}`)
    })
})
