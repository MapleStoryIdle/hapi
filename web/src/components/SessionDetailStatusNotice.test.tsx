import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionDetailStatusNotice } from './SessionDetailStatusNotice'

afterEach(() => {
    cleanup()
})

function renderNotice(props: ComponentProps<typeof SessionDetailStatusNotice>) {
    return render(
        <I18nProvider>
            <SessionDetailStatusNotice {...props} />
        </I18nProvider>
    )
}

describe('SessionDetailStatusNotice', () => {
    it('renders processing as a compact status with no detail card', () => {
        renderNotice({ tone: 'processing', title: 'Native Codex is running', compact: true, testId: 'status' })

        const status = screen.getByTestId('status')
        expect(status).toHaveAttribute('role', 'status')
        expect(status).toHaveAttribute('data-status-tone', 'processing')
        expect(status).toHaveAttribute('aria-busy', 'true')
        expect(status).toHaveTextContent('Native Codex is running')
        expect(status.querySelector('svg')).toBeNull()
    })

    it('renders an error with detail and invokes retry', () => {
        const onRetry = vi.fn()
        renderNotice({
            tone: 'error',
            title: 'Could not load context',
            detail: 'Runner unavailable',
            action: { label: 'Retry', onClick: onRetry },
            testId: 'status'
        })

        const status = screen.getByTestId('status')
        expect(status).toHaveAttribute('role', 'alert')
        expect(status).toHaveTextContent('Runner unavailable')
        expect(status).toHaveClass('max-h-[min(60dvh,28rem)]')
        expect(status.querySelector('[data-status-content]')).toHaveClass('overflow-y-auto')
        expect(status.querySelector('[data-status-actions]')).toHaveClass('border-t')
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('shows a loading icon and preserves a disabled action state', () => {
        renderNotice({
            tone: 'loading',
            title: 'Creating new session',
            action: { label: 'Retry', onClick: vi.fn(), busy: true },
            testId: 'status'
        })

        const status = screen.getByTestId('status')
        expect(status).toHaveAttribute('aria-busy', 'true')
        expect(status.querySelector('.lucide-loader-circle')).not.toBeNull()
        expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    })

    it('keeps a secondary cancellation action usable while the primary action is busy', () => {
        const onCancel = vi.fn()
        renderNotice({
            tone: 'warning',
            title: 'Native session may be stuck',
            action: { label: 'Retrying…', onClick: vi.fn(), busy: true },
            secondaryAction: { label: 'Cancel', onClick: onCancel },
            testId: 'status'
        })

        expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(onCancel).toHaveBeenCalledTimes(1)
    })
})
