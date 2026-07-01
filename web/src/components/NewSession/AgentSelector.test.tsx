import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgentSelector } from './AgentSelector'
import type { AgentType } from './types'

afterEach(() => {
    cleanup()
})

function renderedAgentValues(): string[] {
    const { container } = render(
        <AgentSelector agent={'claude' as AgentType} isDisabled={false} onAgentChange={() => {}} />
    )
    return Array.from(container.querySelectorAll('input[type="radio"]'))
        .map((el) => (el as HTMLInputElement).value)
}

describe('AgentSelector', () => {
    it('does not offer hidden agents as new-session choices', () => {
        expect(renderedAgentValues()).not.toContain('gemini')
        expect(renderedAgentValues()).not.toContain('cursor')
        expect(renderedAgentValues()).not.toContain('opencode')
        expect(renderedAgentValues()).not.toContain('pi')
    })

    it('offers only Claude and Codex in tab order', () => {
        expect(renderedAgentValues()).toEqual(['claude', 'codex'])
    })

    it('renders visible agent tab labels', () => {
        render(
            <AgentSelector agent={'claude' as AgentType} isDisabled={false} onAgentChange={() => {}} />
        )

        expect(screen.getByText('Claude Code', { selector: 'span.whitespace-nowrap' })).toBeTruthy()
        expect(screen.getByText('Codex', { selector: 'span.whitespace-nowrap' })).toBeTruthy()
    })

    it('renders compact 20px agent icons inside tabs', () => {
        const { container } = render(
            <AgentSelector agent={'claude' as AgentType} isDisabled={false} onAgentChange={() => {}} />
        )

        expect(container.querySelector('[aria-label="Codex"] span')?.className).toContain('h-5 w-5')
    })

    it('keeps the icon radio controls selectable by accessible label', () => {
        const onAgentChange = vi.fn()
        const { container } = render(
            <AgentSelector agent={'claude' as AgentType} isDisabled={false} onAgentChange={onAgentChange} />
        )

        const codexInput = container.querySelector('input[value="codex"]') as HTMLInputElement | null
        expect(codexInput).not.toBeNull()
        fireEvent.click(codexInput!)

        expect(onAgentChange).toHaveBeenCalledWith('codex')
    })
})
