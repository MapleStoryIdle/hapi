import type { NormalizedMessage } from '@/chat/types'
import type { AttachmentMetadata } from '@/types/api'
import { isObject } from '@hapi/protocol'

export function isShapiManagedSkillEcho(content: unknown, meta: unknown): boolean {
    if (!isObject(meta) || meta.sentFrom !== 'cli') return false
    const text = typeof content === 'string'
        ? content
        : isObject(content) && content.type === 'text' && typeof content.text === 'string'
            ? content.text
            : null
    return /^<shapi-managed-skill(?:-ref)? /.test(text?.trimStart() ?? '')
}

function parseAttachments(raw: unknown): AttachmentMetadata[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const attachments: AttachmentMetadata[] = []
    for (const item of raw) {
        if (
            isObject(item) &&
            typeof item.id === 'string' &&
            typeof item.filename === 'string' &&
            typeof item.mimeType === 'string' &&
            typeof item.size === 'number' &&
            typeof item.path === 'string'
        ) {
            attachments.push({
                id: item.id,
                filename: item.filename,
                mimeType: item.mimeType,
                size: item.size,
                path: item.path,
                previewUrl: typeof item.previewUrl === 'string' ? item.previewUrl : undefined
            })
        }
    }
    return attachments.length > 0 ? attachments : undefined
}

export function normalizeUserRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown,
): NormalizedMessage | null {
    if (typeof content === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content },
            isSidechain: false,
            meta
        }
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        const attachments = parseAttachments(content.attachments)
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content.text, attachments },
            isSidechain: false,
            meta
        }
    }

    return null
}
