import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AskUserQuestionOptionBody, getAskUserQuestionOptionFrameClassName } from './askUserQuestionOptionCard'

afterEach(cleanup)

describe('question option presentation', () => {
    it('keeps available options readable rather than fading them like historical answers', () => {
        const { container } = render(<AskUserQuestionOptionBody checked={false} mode="multi" title="Code" interactive />)
        expect(container.firstChild).not.toHaveClass('opacity-70')
        expect(screen.getByText('Code')).toHaveClass('text-[var(--app-fg)]')
        expect(container.querySelector('[aria-hidden]')).not.toHaveClass('bg-[var(--app-button)]')
        expect(getAskUserQuestionOptionFrameClassName(false, undefined, true)).toContain('border-[var(--app-border)]')
    })

    it.each(['single', 'multi'] as const)('highlights the selected interactive %s control', (mode) => {
        const { container } = render(<AskUserQuestionOptionBody checked mode={mode} title="Code" interactive />)
        expect(container.querySelector('[aria-hidden]')).toHaveClass('border-[var(--app-button)]')
        expect(getAskUserQuestionOptionFrameClassName(true, undefined, true)).toContain('border-[var(--app-button)]')
    })

    it('preserves muted unselected answers in history', () => {
        const { container } = render(<AskUserQuestionOptionBody checked={false} mode="multi" title="Code" />)
        expect(container.firstChild).toHaveClass('opacity-70')
        expect(screen.getByText('Code')).toHaveClass('text-[var(--app-tool-card-subtitle)]')
        expect(getAskUserQuestionOptionFrameClassName(false)).toContain('border-transparent')
    })
})
