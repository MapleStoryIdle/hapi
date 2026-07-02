import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { CodeBlock } from '@/components/CodeBlock'

describe('CodeBlock', () => {
    it('renders a header label and truncation badge for long content', () => {
        const longCode = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
        const { container } = render(
            <I18nProvider>
                <CodeBlock
                    code={longCode}
                    language="typescript"
                    title="TypeScript"
                    collapseLongContent
                    collapseLineThreshold={5}
                />
            </I18nProvider>
        )

        expect(screen.getByText('TypeScript')).toBeInTheDocument()
        expect(screen.getByTitle('Copy')).toBeInTheDocument()
        expect(screen.getByText(/Preview truncated/)).toBeInTheDocument()
        expect(container.querySelector('[style*="grid-template-columns: 3ch max-content"]')).not.toBeNull()
        expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(/^1 2 3/)
        expect(container.querySelector('.aui-code-surface')).toHaveClass('rounded-[22px]', 'border')
        expect(container.querySelector('.aui-code-surface-header')).toHaveClass('px-6', 'pt-5', 'pb-3')
        expect(screen.getByTitle('Copy')).toHaveClass('opacity-75')
        expect(container.querySelector('.aui-code-surface .grid')).toHaveClass('text-[0.95rem]')
    })
})
