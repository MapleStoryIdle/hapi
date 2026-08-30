import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
        expect(container.querySelector('pre[aria-hidden="true"]')).toHaveTextContent(/^1 2 3/)
        expect(container.querySelector('.aui-code-surface')).toHaveClass('rounded-[16px]', 'border', 'shadow-none')
        expect(container.querySelector('.aui-code-surface-header')).toHaveClass('px-4', 'py-2.5')
        expect(screen.getByTitle('Copy')).toHaveClass('opacity-75')
        expect(container.querySelector('.aui-code-surface .grid')).toHaveClass('text-[0.875rem]')
    })

    it('morphs the copy glyph into a check after a successful copy', async () => {
        const writeText = vi.fn(async () => {})
        const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })

        try {
            const view = render(
                <I18nProvider>
                    <CodeBlock code="const copied = true" language="typescript" />
                </I18nProvider>
            )

            const copyButton = view.container.querySelector<HTMLButtonElement>('button[title="Copy"]')!
            expect(copyButton.querySelector('[data-motion-icon="copy"]')).not.toBeNull()

            fireEvent.click(copyButton)

            await waitFor(() => {
                expect(writeText).toHaveBeenCalledWith('const copied = true')
                expect(copyButton.querySelector('[data-motion-icon="check"]')).not.toBeNull()
            })
        } finally {
            if (previousClipboard) {
                Object.defineProperty(navigator, 'clipboard', previousClipboard)
            } else {
                Reflect.deleteProperty(navigator, 'clipboard')
            }
        }
    })
})
