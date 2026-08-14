import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { RequestUserInputFooter } from './RequestUserInputFooter'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <>{props.content}</>
}))

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
        expect(screen.getByRole('button', { name: /Continue/ })).toBeInTheDocument()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('only shows text input after choosing Other and hides it again for an option', () => {
        renderFooter(optionQuestion)

        fireEvent.click(screen.getByRole('button', { name: /Other/ }))
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('sends the selected option through the existing permission response', async () => {
        const approvePermission = vi.fn().mockResolvedValue(undefined)
        const { onDone } = renderFooter(optionQuestion, { approvePermission } as unknown as ApiClient)

        fireEvent.click(screen.getByRole('button', { name: /Continue/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

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

        fireEvent.click(screen.getByRole('button', { name: /Other/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wait for review' } })
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

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
})
