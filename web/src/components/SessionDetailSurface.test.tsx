import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionDetailContent, SessionDetailSurface } from './SessionDetailSurface'

describe('SessionDetailSurface', () => {
    it('provides the same bounded flex frame for SHAPI and native detail routes', () => {
        const { rerender } = render(
            <SessionDetailSurface source="hapi" testId="detail-surface">
                <SessionDetailContent ariaLabel="SHAPI conversation">SHAPI content</SessionDetailContent>
            </SessionDetailSurface>
        )

        const surface = screen.getByTestId('detail-surface')
        expect(surface).toHaveClass('relative', 'flex', 'h-full', 'min-h-0', 'flex-col', 'overflow-hidden')
        expect(surface).toHaveAttribute('data-session-detail-source', 'hapi')
        expect(screen.getByTestId('session-detail-content')).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col')
        expect(screen.getByRole('main', { name: 'SHAPI conversation' })).toHaveTextContent('SHAPI content')

        rerender(
            <SessionDetailSurface source="codex" testId="detail-surface">
                <SessionDetailContent ariaLabel="Native conversation">Native content</SessionDetailContent>
            </SessionDetailSurface>
        )

        expect(screen.getByTestId('detail-surface')).toHaveAttribute('data-session-detail-source', 'codex')
        expect(screen.getByRole('main', { name: 'Native conversation' })).toHaveTextContent('Native content')
    })
})
