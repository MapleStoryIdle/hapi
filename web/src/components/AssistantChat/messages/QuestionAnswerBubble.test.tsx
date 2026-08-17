import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QuestionAnswerBubble } from '@/components/AssistantChat/messages/QuestionAnswerBubble'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <>{props.content}</>
}))

describe('QuestionAnswerBubble', () => {
    it('shows only the user-selected options in a distinct user-message surface', () => {
        const view = render(
            <I18nProvider>
                <QuestionAnswerBubble answer={{
                    items: [{
                        question: 'Which direction?',
                        answers: ['Keep it compact']
                    }]
                }} />
            </I18nProvider>
        )

        expect(screen.getByText('Your selection')).toBeInTheDocument()
        expect(screen.getByText('Which direction?')).toBeInTheDocument()
        expect(screen.getByText('Keep it compact')).toBeInTheDocument()
        expect(view.container.querySelector('[data-question-answer-bubble]')).toHaveClass('flex')
        expect(view.container.querySelectorAll('[data-question-answer-item]')).toHaveLength(1)
        expect(view.container.querySelector('[data-question-answer-choice]')).toHaveTextContent('Keep it compact')
    })
})
