import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuestionAnswerBubble } from '@/components/AssistantChat/messages/QuestionAnswerBubble'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <>{props.content}</>
}))

afterEach(() => cleanup())

describe('QuestionAnswerBubble', () => {
    it('shows question and selected answer in the bubble, with other options in the drawer', () => {
        const view = render(
            <I18nProvider>
                <QuestionAnswerBubble answer={{
                    items: [{
                        question: 'Which direction?',
                        answers: ['Keep it compact'],
                        options: [
                            { label: 'Keep it compact', description: 'Short rows', selected: true },
                            { label: 'Show all details', description: 'Everything visible', selected: false }
                        ]
                    }]
                }} />
            </I18nProvider>
        )

        expect(screen.getByText('Your selection')).toBeInTheDocument()
        expect(screen.getByText('Keep it compact')).toBeInTheDocument()
        expect(screen.getByText('Which direction?')).toBeInTheDocument()
        expect(screen.queryByText('Show all details')).not.toBeInTheDocument()
        expect(view.container.querySelector('[data-question-answer-bubble]')).toHaveClass('w-full')
        expect(screen.getByTestId('question-answer-toggle')).toHaveClass(
            'rounded-[20px]',
            'bg-[var(--app-tool-card-bg)]'
        )
        expect(screen.getByTestId('question-answer-toggle')).not.toHaveClass('bg-[var(--app-chat-user-chip-bg)]')
        expect(view.container.querySelector('[data-question-answer-summary-mark]')).toHaveClass('text-emerald-600')

        fireEvent.click(screen.getByTestId('question-answer-toggle'))

        const drawer = screen.getByTestId('question-answer-details-drawer')
        expect(drawer).toBeInTheDocument()
        expect(within(drawer).getByText('Which direction?')).toBeInTheDocument()
        expect(screen.getByText('Show all details')).toBeInTheDocument()
        expect(screen.getByText('Everything visible')).toBeInTheDocument()
        expect(drawer.querySelectorAll('[data-question-answer-option]')).toHaveLength(2)
        expect(drawer.querySelector('[data-question-answer-option][data-selected="true"]')).toHaveTextContent('Keep it compact')
    })

    it('renders older selection payloads without original option metadata', () => {
        render(
            <I18nProvider>
                <QuestionAnswerBubble answer={{
                    items: [{
                        question: 'Legacy question',
                        answers: ['Legacy answer']
                    }]
                }} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByTestId('question-answer-toggle'))

        const drawer = screen.getByTestId('question-answer-details-drawer')
        expect(within(drawer).getByText('Legacy question')).toBeInTheDocument()
        expect(within(drawer).getByText('Legacy answer')).toBeInTheDocument()
        expect(drawer.querySelectorAll('[data-selected="true"]')).toHaveLength(1)
    })
})
