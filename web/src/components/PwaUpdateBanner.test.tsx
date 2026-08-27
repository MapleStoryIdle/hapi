import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { PwaUpdateBanner } from '@/components/PwaUpdateBanner'

const usePwaUpdateMock = vi.fn()

vi.mock('@/lib/pwa-update-context', () => ({
    usePwaUpdateContext: () => usePwaUpdateMock(),
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            impact: vi.fn(),
            notification: vi.fn(),
        },
    }),
}))

function renderBanner() {
    return render(
        <I18nProvider>
            <PwaUpdateBanner />
        </I18nProvider>,
    )
}

describe('PwaUpdateBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        Object.defineProperty(window, 'localStorage', {
            value: {
                getItem: vi.fn(() => 'en'),
                setItem: vi.fn(),
                removeItem: vi.fn(),
                clear: vi.fn(),
                key: vi.fn(() => null),
                length: 0,
            },
            configurable: true,
        })
    })

    afterEach(() => {
        cleanup()
    })

    it('does not render when no update is available', () => {
        usePwaUpdateMock.mockReturnValue({
            needRefresh: false,
            reload: vi.fn(),
        })

        renderBanner()

        expect(screen.queryByTestId('pwa-update-prompt')).not.toBeInTheDocument()
    })

    it('requires an explicit update decision in a centered modal', () => {
        const reload = vi.fn()

        usePwaUpdateMock.mockReturnValue({
            needRefresh: true,
            reload,
        })

        renderBanner()

        const prompt = screen.getByTestId('pwa-update-prompt')
        expect(prompt).toBeInTheDocument()
        expect(prompt).toHaveClass('left-1/2', 'top-1/2', '-translate-x-1/2', '-translate-y-1/2')
        expect(screen.getByText('New version available')).toBeInTheDocument()
        expect(screen.getByText('A new version is ready. Updating now reloads this page.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Update now' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()

        fireEvent.keyDown(prompt, { key: 'Escape' })
        expect(screen.getByTestId('pwa-update-prompt')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
        expect(screen.queryByTestId('pwa-update-prompt')).not.toBeInTheDocument()
        expect(reload).not.toHaveBeenCalled()
    })

    it('reloads when the user chooses to update now', () => {
        const reload = vi.fn()

        usePwaUpdateMock.mockReturnValue({
            needRefresh: true,
            reload,
        })

        renderBanner()

        fireEvent.click(screen.getByRole('button', { name: 'Update now' }))
        expect(reload).toHaveBeenCalledTimes(1)
    })
})
