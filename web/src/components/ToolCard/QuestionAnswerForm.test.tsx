import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { QuestionAnswerForm } from './QuestionAnswerForm'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { selection: vi.fn(), notification: vi.fn() }
    })
}))

afterEach(cleanup)

function renderQuestion(options: { value: string; label: string; description: string | null }[]) {
    render(
        <I18nProvider>
            <QuestionAnswerForm
                messageCard
                questions={[{ id: 'q1', question: 'Which option?', multiSelect: true, options }]}
                disabled={false}
                onSubmit={async () => {}}
                onDone={() => {}}
                textPlaceholder="Type an answer"
            />
        </I18nProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
    return screen.getByTestId('question-answer-form-drawer')
}

describe('QuestionAnswerForm mobile presentation', () => {
    it('keeps option-only questions in the normal bottom sheet', () => {
        const drawer = renderQuestion([{ value: 'one', label: 'One', description: null }])
        expect(drawer).not.toHaveAttribute('data-keyboard-safe-dialog')
        expect(drawer.querySelector('[data-question-drawer-handle]')).not.toBeNull()
    })

    it('switches to the keyboard-safe dialog before rendering the Other text field', async () => {
        renderQuestion([{ value: 'one', label: 'One', description: null }])
        fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }))
        await waitFor(() => expect(screen.getByTestId('question-answer-form-drawer')).toHaveAttribute('data-keyboard-safe-dialog', 'true'))
        const drawer = screen.getByTestId('question-answer-form-drawer')
        expect(screen.getByRole('textbox')).toHaveAttribute('data-drawer-initial-focus')
        expect(drawer.querySelector('[data-question-drawer-handle]')).toBeNull()
    })

    it('opens a free-text-only question directly in the keyboard-safe dialog', () => {
        const drawer = renderQuestion([])
        expect(drawer).toHaveAttribute('data-keyboard-safe-dialog', 'true')
        const input = screen.getByRole('textbox')
        expect(input).toBeVisible()
        expect(input).toHaveClass('chat-sheet-input', 'resize-none')
        expect(input).not.toHaveClass('border-[var(--app-border)]', 'bg-[var(--app-bg)]')
    })
})
