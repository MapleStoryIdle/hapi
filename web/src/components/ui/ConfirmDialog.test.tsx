import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

it('stacks confirmation content and scrim above bottom drawers', () => {
    render(
        <I18nProvider>
            <ConfirmDialog
                isOpen
                onClose={() => {}}
                title="Push"
                description="Confirm push"
                confirmLabel="Push"
                confirmingLabel="Pushing"
                onConfirm={vi.fn()}
                isPending={false}
            />
        </I18nProvider>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('app-safe-dialog')
    expect(dialog).not.toHaveClass('top-1/2', '-translate-y-1/2')
    expect(dialog).toHaveStyle({ zIndex: '201' })
    expect(dialog.previousElementSibling).toHaveStyle({ zIndex: '200' })
})
