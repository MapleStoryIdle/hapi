import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { BottomDrawer, shouldDismissDrawer } from './BottomDrawer'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
    const [open, setOpen] = useState(false)
    return <I18nProvider><BottomDrawer open={open} onOpenChange={setOpen} title="Choose" trigger={<button>Open</button>} footer={<button>Send</button>}><p>Scrollable content</p></BottomDrawer></I18nProvider>
}

describe('BottomDrawer', () => {
    it('springs back after short/upward drags; closes on long downward drags or flicks', () => {
        expect(shouldDismissDrawer(30, 0.1, 400)).toBe(false)
        expect(shouldDismissDrawer(-150, -1, 400)).toBe(false)
        expect(shouldDismissDrawer(130, 0.1, 400)).toBe(true)
        expect(shouldDismissDrawer(30, 0.8, 400)).toBe(true)
        expect(shouldDismissDrawer(5, 0.8, 400)).toBe(false)
    })

    it('portals above the composer and restores trigger focus on Escape', async () => {
        const view = render(<Harness />)
        fireEvent.click(screen.getByText('Open'))
        const dialog = screen.getByRole('dialog')
        expect(view.container.contains(dialog)).toBe(false)
        expect(dialog).toHaveClass('fixed', 'z-[61]')
        expect(dialog.querySelector('[data-question-drawer-body]')).toHaveClass('overflow-y-auto', 'overscroll-contain')
        expect(dialog.querySelector('[data-question-drawer-body]')?.contains(screen.getByText('Send'))).toBe(false)
        fireEvent.keyDown(dialog, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        await waitFor(() => expect(screen.getByText('Open')).toHaveFocus())
    })

    it('tracks keyboard resize and visual viewport panning', () => {
        const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 20 })
        vi.stubGlobal('visualViewport', viewport)
        vi.stubGlobal('innerHeight', 800)
        render(<Harness />)
        fireEvent.click(screen.getByText('Open'))
        const dialog = screen.getByRole('dialog')
        expect(dialog.style.getPropertyValue('--drawer-viewport-height')).toBe('400px')
        expect(dialog.style.getPropertyValue('--drawer-bottom')).toBe('380px')
        act(() => { viewport.height = 350; viewport.offsetTop = 60; viewport.dispatchEvent(new Event('resize')) })
        expect(dialog.style.getPropertyValue('--drawer-viewport-height')).toBe('350px')
        expect(dialog.style.getPropertyValue('--drawer-bottom')).toBe('390px')
    })
})
