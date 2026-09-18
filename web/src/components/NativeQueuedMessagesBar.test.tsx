import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeQueuedMessagesBar } from './NativeQueuedMessagesBar'

afterEach(cleanup)

it('offers recovery beside the uncertain receipt, without resending ordinary queued messages', () => {
    const retry = vi.fn()
    const props = {
        messages: [
            { id: 'uncertain', text: 'Check this delivery', queuedAt: 1, recoveryRequired: true },
            { id: 'waiting', text: 'Send automatically', queuedAt: 2 }
        ],
        onRetry: retry,
        retryMessageId: 'uncertain',
    }
    const { rerender } = render(<I18nProvider><NativeQueuedMessagesBar {...props} retryDisabled /></I18nProvider>)
    fireEvent.click(screen.getByTestId('native-queued-messages-trigger'))
    const drawer = screen.getByTestId('native-queued-messages-drawer')
    expect(within(drawer).getByRole('button', { name: 'Send again (may duplicate)' })).toBeDisabled()
    expect(within(drawer).getByText('Retry when idle and the queue is resumed.')).toBeInTheDocument()
    rerender(<I18nProvider><NativeQueuedMessagesBar {...props} /></I18nProvider>)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send again (may duplicate)' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(within(drawer).getAllByRole('button', { name: 'Send again (may duplicate)' })).toHaveLength(1)
})

it('allows cancelling both waiting and already handed-off SHAPI receipts', () => {
    const onCancel = vi.fn()
    const messages = [
        { id: 'waiting', text: 'Waiting feedback', queuedAt: 1 },
        { id: 'active', text: 'In flight', queuedAt: 2, cancelBlocked: true },
    ]
    render(<I18nProvider><NativeQueuedMessagesBar messages={messages} onCancel={onCancel} /></I18nProvider>)
    fireEvent.click(screen.getByTestId('native-queued-messages-trigger'))
    const buttons = screen.getAllByRole('button', { name: /cancel/i })
    expect(buttons[0]).not.toBeDisabled()
    expect(buttons[1]).not.toBeDisabled()
    fireEvent.click(buttons[0]!)
    expect(onCancel).toHaveBeenCalledWith(messages[0])
    fireEvent.click(buttons[1]!)
    expect(onCancel).toHaveBeenCalledWith(messages[1])
})

it('renders a queued native question reply as readable text', () => {
    const text = '<send_user_message_question_reply>[{"questionItemId":"q","question":"Continue?","answer":"Yes"}]</send_user_message_question_reply>'
    render(<I18nProvider><NativeQueuedMessagesBar messages={[{ id: 'q', text, queuedAt: 1 }]} /></I18nProvider>)
    expect(screen.getByTestId('native-queued-messages-trigger')).toHaveTextContent('Continue?')
    expect(screen.queryByText(/send_user_message_question_reply/)).toBeNull()
})

it('renders a queued managed Skill as its user request, not internal XML', () => {
    const text = [
        '<shapi-managed-skill-ref id="agent-team" version="1.0.0">',
        'private managed instructions',
        '</shapi-managed-skill-ref>',
        '',
        'User request:',
        'Check the release state.'
    ].join('\n')
    render(<I18nProvider><NativeQueuedMessagesBar messages={[{ id: 'skill', text, queuedAt: 1 }]} /></I18nProvider>)
    expect(screen.getByTestId('native-queued-messages-trigger')).toHaveTextContent('$agent-team Check the release state.')
    expect(screen.queryByText(/shapi-managed-skill-ref/)).toBeNull()
})
