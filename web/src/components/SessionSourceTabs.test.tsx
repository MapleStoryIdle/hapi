import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionSourceTabs } from './SessionSourceTabs'

afterEach(() => cleanup())

describe('SessionSourceTabs', () => {
    it('renders running, hapi, and codex as an accessible tablist', () => {
        render(
            <I18nProvider>
                <SessionSourceTabs value="hapi" onChange={vi.fn()} />
            </I18nProvider>
        )

        expect(screen.getByRole('tablist', { name: 'Session source' })).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: 'running' })).toHaveAttribute('aria-selected', 'false')
        expect(screen.getByRole('tab', { name: 'hapi' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tab', { name: 'codex' })).toHaveAttribute('aria-selected', 'false')
    })

    it('switches source on click and with arrow keys', () => {
        const onChange = vi.fn()
        render(
            <I18nProvider>
                <SessionSourceTabs value="hapi" onChange={onChange} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('tab', { name: 'codex' }))
        expect(onChange).toHaveBeenCalledWith('codex')

        fireEvent.keyDown(screen.getByRole('tab', { name: 'hapi' }), { key: 'ArrowRight' })
        expect(onChange).toHaveBeenCalledWith('codex')
    })
})
