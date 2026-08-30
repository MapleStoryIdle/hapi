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
        expect(header).toHaveClass('pointer-events-auto', 'z-40', 'isolate', 'touch-manipulation')
        expect(header.style.backgroundColor).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backgroundVariable})`)
        expect(header.style.backdropFilter).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backdropFilterVariable})`)
        expect(screen.getByRole('status', { name: 'loading.session' })).toBeTruthy()
        expect(screen.getAllByTestId('session-entry-message-skeleton')).toHaveLength(3)
        expect(screen.getByTestId('session-entry-composer-skeleton')).toBeTruthy()

        fireEvent.click(screen.getByTestId('session-entry-loading-back'))

        expect(onBack).toHaveBeenCalledOnce()
    })

    it('does not expose an empty title-details control during loading', () => {
        render(<SessionEntryLoading onBack={() => {}} />)

        expect(screen.queryByRole('button', { name: 'loading.session' })).toBeNull()
    })
})
