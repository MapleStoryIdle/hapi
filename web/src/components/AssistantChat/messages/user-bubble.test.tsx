import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text, inline, preserveSingleLineBreaks }: { text: string; inline?: boolean; preserveSingleLineBreaks?: boolean }) => (
        <span
            data-testid="lazy-rainbow-text"
            data-inline={inline ? 'true' : 'false'}
            data-preserve-single-line-breaks={preserveSingleLineBreaks ? 'true' : 'false'}
        >
            {text}
        </span>
    )
}))

import {
    UserBubbleContent,
    extractLeadingDirectives,
    formatDirectiveLabel,
    getQuestionAnswerMessageClassName,
    getUserBubbleClassName
} from '@/components/AssistantChat/messages/user-bubble'

describe('extractLeadingDirectives', () => {
    it('extracts leading skill and command directives', () => {
        expect(extractLeadingDirectives('$deep-interview /model keep going')).toEqual({
            directives: ['$deep-interview', '/model'],
            body: 'keep going'
        })
    })

    it('leaves ordinary text untouched', () => {
        expect(extractLeadingDirectives('plain message')).toEqual({
            directives: [],
            body: 'plain message'
        })
    })

    it('does not treat absolute paths as slash directives', () => {
        expect(extractLeadingDirectives('/Users/bytedance/project')).toEqual({
            directives: [],
            body: '/Users/bytedance/project'
        })
    })
})

describe('UserBubbleContent', () => {
    it('renders directive chips inline with the remaining single-line message body', () => {
        const { container } = render(<UserBubbleContent text="$ralplan polish the user bubble" />)

        expect(screen.getByText('ralplan')).toBeInTheDocument()
        expect(screen.getByText('polish the user bubble')).toBeInTheDocument()
        expect(screen.getByTitle('$ralplan')).toBeInTheDocument()
        expect(screen.getByTestId('lazy-rainbow-text')).toHaveAttribute('data-inline', 'true')
        const skill = container.querySelector('[data-user-directive-kind="skill"]')
        expect(skill).toHaveClass('text-[var(--app-markdown-link)]')
        expect(skill).toHaveClass('bg-transparent', 'border-0', 'p-0')
        expect(skill).not.toHaveClass('bg-[var(--app-chat-user-chip-bg)]', 'border', 'rounded-full')
        expect(skill?.querySelector('svg')).toBeInTheDocument()
        expect(skill?.tagName).toBe('SPAN')
    })

    it('keeps slash commands visually separate from skills', () => {
        const { container } = render(<UserBubbleContent text="/model gpt-5" />)

        const command = container.querySelector('[data-user-directive-kind="command"]')
        expect(command).toHaveClass('text-[var(--app-chat-user-chip-fg)]')
        expect(command).toHaveClass('bg-[var(--app-chat-user-chip-bg)]', 'rounded-full', 'border')
        expect(command).not.toHaveClass('text-[var(--app-markdown-link)]')
    })

    it('keeps multiple skills transparent alongside an unchanged slash command', () => {
        const { container } = render(<UserBubbleContent text={'$review $hapi-upgrade /model\nContinue\nNext step'} />)

        const skills = container.querySelectorAll('[data-user-directive-kind="skill"]')
        expect(skills).toHaveLength(2)
        for (const skill of skills) {
            expect(skill).toHaveClass('bg-transparent', 'border-0', 'text-[var(--app-markdown-link)]')
        }
        expect(container.querySelector('[data-user-directive-kind="command"]')).toHaveClass('bg-[var(--app-chat-user-chip-bg)]')
        expect(container.querySelector('[data-testid="lazy-rainbow-text"]')).toHaveAttribute('data-preserve-single-line-breaks', 'true')
    })

    it('asks LazyRainbowText to preserve single newlines in sent prompt bodies', () => {
        const { container } = render(<UserBubbleContent text={'Line one\nLine two\nLine three'} />)
        const lazyText = container.querySelector('[data-testid="lazy-rainbow-text"]')

        expect(lazyText).toHaveAttribute('data-preserve-single-line-breaks', 'true')
    })

    it('preserves original directive casing in chip labels', () => {
        expect(formatDirectiveLabel('$DeEp-INTERVIEW')).toBe('DeEp INTERVIEW')
    })

    it('uses the shadowless queued bubble styling', () => {
        const className = getUserBubbleClassName('queued')
        expect(className).toContain('shadow-none')
        expect(className).toContain('opacity-60')
    })

    it('gives completed selections their own card container instead of a user bubble', () => {
        const className = getQuestionAnswerMessageClassName()

        expect(className).toContain('happy-question-answer-message')
        expect(className).toContain('max-w-[min(30rem,92%)]')
        expect(className).not.toContain('happy-user-bubble')
    })
})
