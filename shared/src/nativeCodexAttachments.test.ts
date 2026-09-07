import { describe, expect, test } from 'bun:test'
import {
    formatNativeCodexAttachmentPrompt,
    parseNativeCodexAttachmentPrompt
} from './nativeCodexAttachments'

describe('native Codex attachment prompt', () => {
    test('keeps Runner paths in the delivery envelope but excludes them from parsed browser metadata', () => {
        const text = formatNativeCodexAttachmentPrompt('Review these files', [
            {
                id: 'a'.repeat(32),
                filename: 'diagram.png',
                mimeType: 'image/png',
                size: 3,
                kind: 'image',
                path: '/runner-private/diagram.png'
            },
            {
                id: 'b'.repeat(32),
                filename: 'notes.md',
                mimeType: 'text/markdown',
                size: 4,
                kind: 'file',
                path: '/runner-private/notes.md'
            }
        ], { includeImagePaths: false })

        expect(text).toContain('/runner-private/notes.md')
        expect(text).not.toContain('/runner-private/diagram.png')
        expect(parseNativeCodexAttachmentPrompt(text)).toEqual({
            text: 'Review these files',
            attachments: [
                {
                    id: 'a'.repeat(32),
                    filename: 'diagram.png',
                    mimeType: 'image/png',
                    size: 3,
                    kind: 'image'
                },
                {
                    id: 'b'.repeat(32),
                    filename: 'notes.md',
                    mimeType: 'text/markdown',
                    size: 4,
                    kind: 'file'
                }
            ]
        })
    })
})
