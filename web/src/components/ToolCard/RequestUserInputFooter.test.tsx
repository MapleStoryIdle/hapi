import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { RequestUserInputFooter } from './RequestUserInputFooter'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <>{props.content}</>
}))

afterEach(cleanup)

function makeTool(input: unknown): ChatToolCall {
    return {
        id: 'tool-1',
        name: 'request_user_input',
        state: 'pending',
        input,
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        description: null,
        permission: {
            id: 'permission-1',
            status: 'pending'
        }
    }
}

function renderFooter(input: unknown, api: ApiClient = { approvePermission: vi.fn() } as unknown as ApiClient) {
    const onDone = vi.fn()
    render(
        <I18nProvider>
            <RequestUserInputFooter
                api={api}
                sessionId="session-1"
                tool={makeTool(input)}
                disabled={false}
                onDone={onDone}
            />
        </I18nProvider>
    )
    return { onDone }
}

describe('RequestUserInputFooter', () => {
    const optionQuestion = {
        questions: [{
            id: 'confirm',
            question: 'Continue with the change?',
            options: [
                { label: 'Continue', description: 'Apply the change' },
                { label: 'Stop', description: 'Do not make changes' }
            ]
        }]
    }

    it('opens an option dialog immediately and keeps text input hidden', () => {
        renderFooter(optionQuestion)

        expect(screen.getByRole('dialog', { name: 'Answer question' })).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: /Continue/ })).not.toBeChecked()
        expect(screen.getByRole('radio', { name: /Stop/ })).not.toBeChecked()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('does not send until a deliberate option click, without a confirm button', async () => {
        const approvePermission = vi.fn().mockResolvedValue(undefined)
        renderFooter(optionQuestion, { approvePermission } as unknown as ApiClient)

        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.queryByRole('button', { name: /Submit|Send/ })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: /Continue/ }))

        await waitFor(() => {
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
                answers: {
                    confirm: { answers: ['Continue'] }
                }
            })
        })
    })

    it('only shows text input after choosing Other and hides it again for an option', () => {
        renderFooter(optionQuestion)

        fireEvent.click(screen.getByRole('radio', { name: /Other/ }))
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('radio', { name: /Continue/ }))
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('sends the selected option through the existing permission response', async () => {
        const approvePermission = vi.fn().mockResolvedValue(undefined)
        const { onDone } = renderFooter(optionQuestion, { approvePermission } as unknown as ApiClient)

        fireEvent.click(screen.getByRole('radio', { name: /Continue/ }))

        await waitFor(() => {
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
                answers: {
                    confirm: { answers: ['Continue'] }
                }
            })
        })
        expect(onDone).toHaveBeenCalledTimes(1)
    })

    it('accepts a custom answer after Other is chosen', async () => {
        const approvePermission = vi.fn().mockResolvedValue(undefined)
        renderFooter(optionQuestion, { approvePermission } as unknown as ApiClient)

        fireEvent.click(screen.getByRole('radio', { name: /Other/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wait for review' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
                answers: {
                    confirm: { answers: ['user_note: Wait for review'] }
                }
            })
        })
    })

    it('shows text input immediately when Codex supplies no options', () => {
        renderFooter({
            questions: [{
                id: 'details',
                question: 'What should I do next?',
                options: []
            }]
        })

        expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('advances multiple questions, sends them together and guards double taps', async () => {
        const approvePermission = vi.fn().mockImplementation(() => new Promise(() => {}))
        renderFooter({ questions: [optionQuestion.questions[0], {
            id: 'color', question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Red' }]
        }] }, { approvePermission } as unknown as ApiClient)
        fireEvent.click(screen.getByRole('radio', { name: /Stop/ }))
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.getByText('Which color?')).toBeInTheDocument()
        const blue = screen.getByRole('radio', { name: 'Blue' })
        fireEvent.click(blue)
        fireEvent.click(blue)
        expect(approvePermission).toHaveBeenCalledTimes(1)
        expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { confirm: { answers: ['Stop'] }, color: { answers: ['Blue'] } }
        })
        expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    })

    it('closing does not submit or cancel; reopening preserves the text answer', () => {
        const approvePermission = vi.fn()
        const { onDone } = renderFooter(optionQuestion, { approvePermission } as unknown as ApiClient)
        fireEvent.click(screen.getByRole('radio', { name: /Other/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(approvePermission).not.toHaveBeenCalled()
        expect(onDone).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        expect(screen.getByRole('textbox')).toHaveValue('My draft')
    })

    it('keeps answers on failure, and only retries on another deliberate click', async () => {
        const approvePermission = vi.fn().mockRejectedValueOnce(new Error('Try again')).mockResolvedValue(undefined)
        renderFooter(optionQuestion, { approvePermission } as unknown as ApiClient)
        fireEvent.click(screen.getByRole('radio', { name: /Stop/ }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Try again'))
        expect(approvePermission).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('radio', { name: /Stop/ })).toBeChecked()
        fireEvent.click(screen.getByRole('radio', { name: /Stop/ }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledTimes(2))
    })
})
