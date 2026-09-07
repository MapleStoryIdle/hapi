import type { Attachment, AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'
import { MAX_NATIVE_CODEX_ATTACHMENT_BYTES, type NativeCodexAttachment } from '@hapi/protocol/nativeCodexAttachments'
import type { ApiClient } from '@/api/client'
import { randomId } from '@/lib/randomId'
import type { AttachmentMetadata } from '@/types/api'

type PendingNativeCodexAttachment = PendingAttachment & {
    nativeAttachment?: NativeCodexAttachment
    /** Opaque ready marker consumed by HappyComposer; never a runner path. */
    path?: string
}

function toAttachmentMetadata(attachment: PendingNativeCodexAttachment): AttachmentMetadata | undefined {
    const staged = attachment.nativeAttachment
    if (!staged) return undefined
    return {
        id: staged.id,
        filename: staged.filename,
        mimeType: staged.mimeType,
        size: staged.size,
        // This is an opaque rendering handle, never a runner filesystem path.
        path: `native-codex:${staged.id}`
    }
}

/**
 * Attachments for original Codex sessions are staged only on the selected
 * runner. The browser keeps an opaque id, which can safely survive a native
 * queue and a page reload without exposing the runner's private path.
 */
export function createNativeCodexAttachmentAdapter(
    api: ApiClient,
    sessionId: string,
    machineId: string
): AttachmentAdapter {
    const cancelledAttachmentIds = new Set<string>()

    const deleteStaged = async (attachmentId?: string) => {
        if (!attachmentId) return
        try {
            await api.deleteCodexSessionAttachment(sessionId, machineId, attachmentId)
        } catch {
            // The runner TTL sweep removes a stage whose browser cleanup races
            // a navigation or a brief network loss.
        }
    }

    return {
        accept: '*/*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            const id = randomId()
            const contentType = file.type || 'application/octet-stream'
            const base: PendingAttachment = {
                id,
                type: 'file',
                name: file.name,
                contentType,
                file,
                status: { type: 'running', reason: 'uploading', progress: 0 }
            }
            yield base

            try {
                if (cancelledAttachmentIds.has(id)) return
                if (file.size > MAX_NATIVE_CODEX_ATTACHMENT_BYTES) {
                    yield {
                        ...base,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                yield {
                    ...base,
                    status: { type: 'running', reason: 'uploading', progress: 50 }
                }
                const result = await api.uploadCodexSessionAttachment(
                    sessionId,
                    machineId,
                    file.name,
                    file,
                    contentType
                )
                if (cancelledAttachmentIds.has(id)) {
                    if (result.success) await deleteStaged(result.attachment.id)
                    return
                }
                if (!result.success) {
                    yield {
                        ...base,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                yield {
                    ...base,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    // HappyComposer uses a staged path-like marker to decide
                    // whether an attachment is ready to send. Keep it opaque:
                    // this is an id only, never the Runner filesystem path.
                    path: `native-codex:${result.attachment.id}`,
                    nativeAttachment: result.attachment
                } as PendingNativeCodexAttachment
            } catch {
                yield {
                    ...base,
                    status: { type: 'incomplete', reason: 'error' }
                }
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            cancelledAttachmentIds.add(attachment.id)
            await deleteStaged((attachment as PendingNativeCodexAttachment).nativeAttachment?.id)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const metadata = toAttachmentMetadata(attachment as PendingNativeCodexAttachment)
            return {
                id: attachment.id,
                type: attachment.type,
                name: attachment.name,
                contentType: attachment.contentType,
                status: { type: 'complete' },
                content: metadata
                    ? [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }]
                    : []
            }
        }
    }
}
