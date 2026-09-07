import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentMetadata } from '@/types/api'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { MessageAttachments } from './MessageAttachments'

vi.mock('@/components/ImagePreview', () => ({
    ImagePreview: (props: {
        src: string
        fileName: string
        gallery?: Array<{ fileName: string }>
    }) => (
        <div data-testid={`image:${props.fileName}`} data-src={props.src}>
            {props.gallery?.map((item) => item.fileName).join(',')}
        </div>
    )
}))

function makeContext(getUploadedFileBlob: HappyChatContextValue['api']['getUploadedFileBlob']): HappyChatContextValue {
    return {
        api: { getUploadedFileBlob } as HappyChatContextValue['api'],
        sessionId: 'session-1',
        metadata: null,
        terminalToolDisplayMode: 'detailed',
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => false
    }
}

const attachments: AttachmentMetadata[] = [
    { id: 'first', filename: 'first.png', mimeType: 'image/png', size: 1, path: '/tmp/first.png' },
    { id: 'second', filename: 'second.png', mimeType: 'image/png', size: 1, path: '/tmp/second.png' }
]

describe('MessageAttachments', () => {
    it('renders native Codex images as local file cards without requesting a managed-upload blob', () => {
        const getUploadedFileBlob = vi.fn()
        render(
            <HappyChatProvider value={makeContext(getUploadedFileBlob)}>
                <MessageAttachments attachments={[{
                    id: 'a'.repeat(32),
                    filename: 'diagram.png',
                    mimeType: 'image/png',
                    size: 3,
                    path: `native-codex:${'a'.repeat(32)}`
                }]} />
            </HappyChatProvider>
        )

        expect(screen.getByText('diagram.png')).toBeInTheDocument()
        expect(getUploadedFileBlob).not.toHaveBeenCalled()
    })

    it('opens uploaded images as one message-level gallery', async () => {
        const getUploadedFileBlob = vi.fn(async (sessionId: string, path: string) => {
            return new Blob([path], { type: 'image/png' })
        })
        const createObjectUrl = vi.spyOn(URL, 'createObjectURL')
            .mockImplementation((_blob) => `blob:preview-${createObjectUrl.mock.calls.length}`)

        render(
            <HappyChatProvider value={makeContext(getUploadedFileBlob)}>
                <MessageAttachments attachments={attachments} />
            </HappyChatProvider>
        )

        await waitFor(() => {
            expect(screen.getByTestId('image:first.png')).toHaveTextContent('first.png,second.png')
            expect(screen.getByTestId('image:second.png')).toHaveTextContent('first.png,second.png')
        })

        expect(getUploadedFileBlob).toHaveBeenCalledTimes(2)
        createObjectUrl.mockRestore()
    })
})
