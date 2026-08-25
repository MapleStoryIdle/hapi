import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ReconnectingBanner } from './ReconnectingBanner'

vi.mock('@/hooks/useOnlineStatus', () => ({
    useOnlineStatus: () => true
}))

afterEach(() => {
    cleanup()
})

describe('ReconnectingBanner', () => {
    it('stays below the floating title bar and never blocks its controls', () => {
        render(
            <I18nProvider>
                <ReconnectingBanner isReconnecting reason="error" offsetFromTitleBar />
            </I18nProvider>
        )

        const banner = screen.getByRole('status')
        expect(banner).toHaveClass(
            'pointer-events-none',
            'z-30',
            'top-[calc(var(--app-safe-area-top)+4.75rem)]'
        )
        expect(banner).toHaveAttribute('aria-live', 'polite')
    })
})
