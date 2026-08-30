import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

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
            url: ''
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
        expect(container).toHaveClass('top-[calc(var(--app-safe-area-top)+4.5rem)]')
    })
})
