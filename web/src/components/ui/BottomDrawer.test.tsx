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

it('blocks outside, Escape and close while an answer is being sent', () => {
    const change = vi.fn()
    render(<I18nProvider><BottomDrawer open onOpenChange={change} busy title="Sending" overlayTestId="outside"><p>Wait</p></BottomDrawer></I18nProvider>)
    fireEvent.click(screen.getByTestId('outside'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    expect(change).not.toHaveBeenCalled()
})

it('restores focus without a Radix trigger and removes background motion on close', async () => {
    function Preview() {
        const [open, setOpen] = useState(false)
        return <I18nProvider><div data-chat-drawer-background><button onClick={() => setOpen(true)}>Preview</button></div>
            <BottomDrawer open={open} onOpenChange={setOpen} title="Preview" overlayTestId="outside"><p>Content</p></BottomDrawer>
        </I18nProvider>
    }
    render(<Preview />)
    const button = screen.getByRole('button', { name: 'Preview' })
    button.focus()
    fireEvent.click(button)
    const background = document.querySelector<HTMLElement>('[data-chat-drawer-background]')!
    expect(background.style.getPropertyValue('--drawer-background-progress')).toBe('1')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const outside = screen.getByTestId('outside')
    fireEvent.pointerDown(outside)
    fireEvent.click(outside)
    await waitFor(() => expect(button).toHaveFocus())
    expect(background.style.getPropertyValue('--drawer-background-progress')).toBe('0')
})

it('associates its subtitle with the dialog description', () => {
    render(<I18nProvider><BottomDrawer open onOpenChange={() => {}} title="Details" subtitle="More context">Body</BottomDrawer></I18nProvider>)
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('More context')
})

it('dismisses only once for a complete outside pointer click', async () => {
    const change = vi.fn()
    render(<I18nProvider><BottomDrawer open onOpenChange={change} title="Details" overlayTestId="outside">Body</BottomDrawer></I18nProvider>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const outside = screen.getByTestId('outside')
    fireEvent.pointerDown(outside, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseDown(outside)
    fireEvent.pointerUp(outside, { button: 0, pointerType: 'mouse' })
    fireEvent.mouseUp(outside)
    fireEvent.click(outside)
    expect(change).toHaveBeenCalledExactlyOnceWith(false)
})
