import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const removeToast = vi.fn()
const navigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigate
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({
        toasts: [{
            id: 'toast-1',
            title: 'Task completed',
            body: 'Header regression check',
            sessionId: '',
            url: '/shares/share-1',
            kind: 'error',
            durationMs: null
        }],
        removeToast
    })
}))

import { ToastContainer } from './ToastContainer'

afterEach(() => {
    cleanup()
    removeToast.mockReset()
    navigate.mockReset()
})

describe('ToastContainer', () => {
    it('keeps a non-modal toast below the floating session header controls', () => {
        render(<ToastContainer />)

        const container = screen.getByText('Task completed').closest<HTMLElement>('[aria-live="polite"]')
        if (!container) throw new Error('toast container missing')
        expect(container).toHaveClass('top-[var(--app-toast-top)]')
        expect(screen.getByText('Task completed').closest<HTMLElement>('[data-toast-kind]')).toHaveAttribute('data-toast-kind', 'error')
    })

    it('navigates from the toast card while the close control only dismisses it', () => {
        render(<ToastContainer />)

        fireEvent.click(screen.getByText('Task completed'))
        expect(removeToast).toHaveBeenCalledWith('toast-1')
        expect(navigate).toHaveBeenCalledWith({ to: '/shares/share-1' })

        removeToast.mockReset()
        navigate.mockReset()
        fireEvent.click(screen.getByLabelText('Dismiss'))
        expect(removeToast).toHaveBeenCalledWith('toast-1')
        expect(navigate).not.toHaveBeenCalled()
    })
})
