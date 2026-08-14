import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer', () => {
    it('renders standalone markdown outside assistant message context', () => {
        render(
            <MarkdownRenderer
                standalone
                content={'# README\n\nInline `code`\n\n```ts\nconst ok = true\n```'}
            />
        )

        expect(screen.getByRole('heading', { name: 'README' })).toBeInTheDocument()
        expect(screen.getByText('const ok = true')).toBeInTheDocument()
    })
})
