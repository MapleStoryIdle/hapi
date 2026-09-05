import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageLinkIcon } from './MessageLink'

afterEach(cleanup)

describe('MessageLinkIcon', () => {
    it.each([
        ['src/rules.ts', 'TS'], ['src/App.tsx', 'TS'], ['index.js', 'JS'],
        ['README.md', 'MD'], ['data.json', '{}'], ['report.PDF', 'PDF'],
    ])('shows the compact file type for %s', (filePath, label) => {
        const { container } = render(<MessageLinkIcon filePath={filePath} />)
        expect(container.querySelector('svg')).toHaveAttribute('data-markdown-link-icon', 'file')
        expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
        expect(container.querySelector('text')).toHaveTextContent(label)
    })

    it.each([
        ['https://example.com', 'globe'], ['//example.com/help', 'globe'],
        ['/settings', 'link2'], ['#section', 'hash'],
        ['mailto:help@example.com', 'mail'], ['vscode://file/main.ts', 'app-window'],
        ['https://example.com?name=main.ts', 'globe'], ['https://example.md', 'globe'],
        ['https://example.com/file.constructor', 'globe'],
    ])('selects an icon without changing the meaning of %s', (href, iconClass) => {
        const { container } = render(<MessageLinkIcon href={href} />)
        expect(container.querySelector('svg')).toHaveClass(`lucide-${iconClass}`)
    })

    it('recognizes an external file from its pathname, not its query', () => {
        const { container } = render(<MessageLinkIcon href="https://example.com/%E6%96%87%E6%A1%A3.md?download=1#preview" external />)
        expect(container.querySelector('text')).toHaveTextContent('MD')
    })

    it.each([['photo.webp', 'file-image'], ['archive.zip', 'file-archive'], ['Makefile', 'file-text'], ['skills/test/SKILL.md', 'puzzle']])(
        'uses a semantic file icon for %s', (filePath, iconClass) => {
            const { container } = render(<MessageLinkIcon filePath={filePath} />)
            expect(container.querySelector('svg')).toHaveClass(`lucide-${iconClass}`)
        }
    )

    it('uses a disabled file icon instead of an enabled type badge', () => {
        const { container } = render(<MessageLinkIcon filePath="/other/project/main.ts" disabled />)
        expect(container.querySelector('svg')).toHaveClass('lucide-file-x2')
        expect(container.querySelector('svg')).toHaveAttribute('data-markdown-link-icon', 'disabled')
        expect(container.querySelector('text')).toBeNull()
    })
})
