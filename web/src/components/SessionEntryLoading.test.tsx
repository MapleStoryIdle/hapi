import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { SessionEntryLoading } from './SessionEntryLoading'

afterEach(() => {
    cleanup()
})

describe('SessionEntryLoading', () => {
    it('keeps the conversation frame and back action visible while session data loads', () => {
        const onBack = vi.fn()
        render(<SessionEntryLoading onBack={onBack} />)

        expect(screen.getByTestId('session-entry-loading')).toHaveAttribute('data-session-detail-source', 'hapi')
        const header = screen.getByTestId('session-entry-loading-header')
        expect(header).toHaveClass('pointer-events-none', 'z-40', 'isolate')
        expect(header.style.backgroundColor).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backgroundVariable})`)
        expect(header.style.backdropFilter).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backdropFilterVariable})`)
        const skeleton = screen.getByRole('status', { name: 'misc.loadingMessages' })
        expect(skeleton).toHaveClass('min-h-full', 'justify-between')
        expect(skeleton).toHaveAttribute('data-session-loading-animation', 'refresh-loop')
        expect(screen.getAllByTestId('session-entry-message-skeleton')).toHaveLength(8)
        expect(screen.getAllByTestId('session-entry-message-skeleton')[0]?.firstElementChild)
            .toHaveClass('session-message-skeleton-refresh')
        expect(screen.getByTestId('session-entry-composer-skeleton')).toBeTruthy()
        expect(screen.queryByText('loading.session')).toBeNull()
        expect(screen.queryByText('misc.loadingMessages')).toBeNull()

        fireEvent.click(screen.getByTestId('session-entry-loading-back'))

        expect(onBack).toHaveBeenCalledOnce()
    })

    it('does not expose a title or visible loading copy while the conversation frame refreshes', () => {
        render(<SessionEntryLoading onBack={() => {}} />)

        expect(screen.queryByRole('button', { name: 'loading.session' })).toBeNull()
        expect(screen.queryByText('loading.session')).toBeNull()
        expect(screen.queryByText('misc.loadingMessages')).toBeNull()
    })
})
