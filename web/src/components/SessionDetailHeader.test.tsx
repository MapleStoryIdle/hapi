import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionDetailHeader } from './SessionDetailHeader'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-lang')
})

describe('SessionDetailHeader', () => {
    it('uses the shared fixed-height title-bar row and localized back affordance', () => {
        const onBack = vi.fn()

        render(
            <I18nProvider>
                <SessionDetailHeader title="Terminal" subtitle="/workspace/hapi" onBack={onBack} />
            </I18nProvider>
        )

        expect(screen.getByTestId('session-detail-header-row')).toHaveClass('h-14')
        expect(screen.getByText('Terminal')).toBeInTheDocument()
        expect(screen.getByText('/workspace/hapi')).toBeInTheDocument()

        const backButton = screen.getByRole('button', { name: 'Back' })
        fireEvent.click(backButton)

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('uses one native click after a touch-like pointer sequence', () => {
        const onBack = vi.fn()

        render(
            <I18nProvider>
                <SessionDetailHeader title="Terminal" onBack={onBack} />
            </I18nProvider>
        )

        const backButton = screen.getByRole('button', { name: 'Back' })
        fireEvent.pointerDown(backButton, { pointerType: 'touch', pointerId: 1 })
        fireEvent.pointerUp(backButton, { pointerType: 'touch', pointerId: 1 })
        fireEvent.click(backButton)

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('localizes the shared back control in Chinese', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')

        render(
            <I18nProvider>
                <SessionDetailHeader title="终端" onBack={() => {}} />
            </I18nProvider>
        )

        expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument()
    })
})
