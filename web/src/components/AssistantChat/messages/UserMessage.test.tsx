import type { ThreadMessageLike } from '@assistant-ui/react'
import type { AttachmentMetadata, MessageStatus } from '@/types/api'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toThreadMessageLike } from '@/lib/assistant-runtime'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyUserMessage } from './UserMessage'

const state = vi.hoisted(() => ({
    message: null as ThreadMessageLike | null,
    retry: vi.fn()
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        MessagePrimitive: {
            Root: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('div', props, children)
        },
        useAssistantState: (selector: (value: { message: ThreadMessageLike | null }) => unknown) => selector({ message: state.message })
    }
})

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({ onRetryMessage: state.retry })
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({ copied: false, copy: vi.fn() })
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <>{props.content}</>
}))

vi.mock('@/components/AssistantChat/messages/MessageAttachments', () => ({
    MessageAttachments: ({ attachments }: { attachments: AttachmentMetadata[] }) => <div>{attachments.map((file) => file.filename).join(', ')}</div>
}))

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

function renderNativeReply(status: MessageStatus = 'sent') {
    const text = `<send_user_message_question_reply>${JSON.stringify([
        { questionItemId: 'question-1', question: '选择方案？', answer: '轻量方案' },
        { questionItemId: 'question-2', question: '统计频率？', answer: '每小时' }
    ])}</send_user_message_question_reply>`
    state.message = toThreadMessageLike({
        kind: 'user-text',
        id: 'native-answer',
        localId: 'local-answer',
        createdAt: 1_000,
        status,
        text,
        attachments: [{ id: 'file-1', filename: 'notes.md', mimeType: 'text/markdown', size: 10, path: '/tmp/notes.md' }]
    }, 'user-text:native-answer')

    return render(<I18nProvider><HappyUserMessage /></I18nProvider>)
}

describe('native replies in HappyUserMessage', () => {
    it('shows all questions and answers without the envelope and opens only read-only details', () => {
        const view = renderNativeReply()

        for (const text of ['选择方案？', '轻量方案', '统计频率？', '每小时', 'notes.md']) {
            expect(screen.getByText(text)).toBeInTheDocument()
        }
        expect(screen.queryByText('Your selection')).not.toBeInTheDocument()
        expect(view.container.textContent).not.toContain('send_user_message_question_reply')
        expect(view.container.textContent).not.toContain('questionItemId')
        expect(view.container.querySelector('#hapi-message-user-text\\:native-answer')).toBeInTheDocument()
        expect(screen.queryByTestId('question-answer-details-drawer')).not.toBeInTheDocument()
        expect(state.retry).not.toHaveBeenCalled()

        fireEvent.click(screen.getByTestId('question-answer-toggle'))
        const drawer = screen.getByTestId('question-answer-details-drawer')
        expect(within(drawer).getByText('每小时')).toBeInTheDocument()
        expect(drawer.querySelector('form,input,textarea,select,[role="radio"],[role="checkbox"]')).toBeNull()
        expect(within(drawer).queryByRole('button', { name: /send|confirm|发送|确认/i })).not.toBeInTheDocument()
        expect(state.retry).not.toHaveBeenCalled()
    })

    it.each(['queued', 'sending'] as const)('retains the %s delivery indicator', (status) => {
        renderNativeReply(status)
        expect(screen.getByRole('status', { name: status === 'queued' ? 'Queued' : 'Sending' })).toBeInTheDocument()
    })

    it('retains explicit retry for a failed message without automatically resending it', () => {
        renderNativeReply('failed')
        expect(state.retry).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(state.retry).toHaveBeenCalledExactlyOnceWith('local-answer')
    })
})
