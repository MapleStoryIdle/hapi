import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { BottomDrawer, drawerDragSize, shouldDismissDrawer } from './BottomDrawer'

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.appKeyboardOpen
    delete document.documentElement.dataset.iosStandalone
})

function Harness() {
    const [open, setOpen] = useState(false)
    return <I18nProvider><BottomDrawer open={open} onOpenChange={setOpen} title="Choose" trigger={<button>Open</button>} footer={<button>Send</button>}><p>Scrollable content</p></BottomDrawer></I18nProvider>
}

describe('BottomDrawer', () => {
    it('keeps keyboard detents on the handle without extra expand/collapse buttons', () => {
        const view = render(<Harness />)
        fireEvent.click(screen.getByText('Open'))
        expect(screen.queryByRole('button', { name: 'Expand drawer' })).toBeNull()
        fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
        expect(screen.getByRole('dialog')).toHaveAttribute('data-expanded', 'true')
        expect(screen.queryByRole('button', { name: 'Collapse drawer' })).toBeNull()
        view.rerender(<Harness />)
        expect(screen.getByRole('dialog')).toHaveAttribute('data-expanded', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        fireEvent.click(screen.getByText('Open'))
        expect(screen.getByRole('dialog')).not.toHaveAttribute('data-expanded')
    })

    it('bounds upward resistance and never grows past the safe-area limit', () => {
        expect(drawerDragSize(500, -50, 750)).toEqual({ height: 550, offset: -0 })
        expect(drawerDragSize(700, -250, 750)).toEqual({ height: 750, offset: -12 })
        expect(drawerDragSize(700, 40, 750)).toEqual({ height: 660, offset: -0 })
    })

    it('uses header drags for detents and ignores body drags', () => {
        class TestPointerEvent extends MouseEvent {
            pointerId: number
            constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1 }
        }
        vi.stubGlobal('PointerEvent', TestPointerEvent)
        render(<Harness />)
        fireEvent.click(screen.getByText('Open'))
        const dialog = screen.getByRole('dialog')
        const handle = dialog.querySelector('[data-question-drawer-handle]')!
        const body = dialog.querySelector('[data-chat-drawer-body]')!
        const drag = (target: Element, from: number, to: number, cancel = false) => {
            fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientY: from })
            fireEvent.pointerMove(target, { pointerId: 1, clientY: to })
            if (cancel) fireEvent.pointerCancel(target, { pointerId: 1, clientY: to })
            else fireEvent.pointerUp(target, { pointerId: 1, clientY: to })
        }
        drag(body, 200, 0)
        expect(dialog).not.toHaveAttribute('data-expanded')
        drag(handle, 200, 0, true)
        expect(dialog).not.toHaveAttribute('data-expanded')
        drag(handle, 200, 0)
        expect(dialog).toHaveAttribute('data-expanded', 'true')
        drag(handle, 0, 200)
        expect(dialog).not.toHaveAttribute('data-expanded')
        expect(dialog).toBeInTheDocument()
        drag(handle, 0, 200)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('expanded sheets follow keyboard height without losing their detent', () => {
        const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 })
        vi.stubGlobal('visualViewport', viewport)
        render(<Harness />)
        fireEvent.click(screen.getByText('Open'))
        fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
        act(() => { viewport.height = 360; viewport.dispatchEvent(new Event('resize')) })
        expect(screen.getByRole('dialog').style.getPropertyValue('--drawer-viewport-height')).toBe('360px')
        expect(screen.getByRole('dialog')).toHaveAttribute('data-expanded', 'true')
    })
    it('can fill 70% of the visible viewport without changing other drawers', () => {
        const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 0 })
        vi.stubGlobal('visualViewport', viewport)
        render(<I18nProvider><BottomDrawer open fixedHeight onOpenChange={() => {}} title="Directory">Files</BottomDrawer></I18nProvider>)
        const dialog = screen.getByRole('dialog')
        expect(dialog.style.height).toBe('calc(var(--drawer-viewport-height, 100dvh) * 0.7)')
        expect(dialog.style.getPropertyValue('--drawer-viewport-height')).toBe('400px')
        expect(dialog).not.toHaveAttribute('aria-describedby')
    })
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

    it('uses a keyboard-safe dialog for editable detail content', () => {
        const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 })
        vi.stubGlobal('visualViewport', viewport)
        vi.stubGlobal('innerHeight', 800)
        render(<I18nProvider><BottomDrawer open inputDialog onOpenChange={() => {}} title="Rename" testId="keyboard-safe-dialog"><input data-drawer-initial-focus /></BottomDrawer></I18nProvider>)
        const dialog = screen.getByTestId('keyboard-safe-dialog')
        expect(dialog).toHaveAttribute('data-keyboard-safe-dialog', 'true')
        expect(dialog).not.toHaveAttribute('data-keyboard-open')
        expect(dialog.style.left).toBe('calc(var(--app-safe-area-left) + var(--app-mobile-input-dialog-edge-gap))')
        expect(dialog.style.right).toBe('calc(var(--app-safe-area-right) + var(--app-mobile-input-dialog-edge-gap))')
        expect(dialog.style.width).toBe('auto')
        expect(dialog.style.top).toBe('auto')
        expect(dialog.style.bottom).toBe('calc(var(--app-safe-area-bottom) + var(--app-mobile-input-dialog-edge-gap))')
        expect(dialog.style.maxHeight).toBe('calc(var(--drawer-viewport-height) - var(--app-safe-area-top) - var(--app-safe-area-bottom) - var(--app-mobile-input-dialog-edge-gap) - var(--app-mobile-input-dialog-edge-gap))')
        expect(dialog.style.transform).toBe('none')
        expect(dialog.className).not.toContain('left-1/2')
        expect(dialog.className).not.toContain('-translate-x-1/2')
        const input = dialog.querySelector('input')!
        input.focus()
        act(() => { viewport.height = 400; viewport.dispatchEvent(new Event('resize')) })
        expect(dialog).toHaveAttribute('data-keyboard-open', 'true')
        expect(dialog).toHaveAttribute('data-keyboard-fixed-viewport', 'layout')
        expect(dialog.querySelector('[data-question-drawer-handle]')).toBeNull()
        expect(dialog.style.top).toBe('auto')
        expect(dialog.style.bottom).toBe('calc(var(--drawer-keyboard-bottom) + var(--app-mobile-input-dialog-keyboard-gap))')
        expect(dialog.style.getPropertyValue('--drawer-keyboard-bottom')).toBe('400px')
        expect(dialog.style.maxHeight).toBe('calc(var(--drawer-viewport-height) - var(--app-safe-area-top) - var(--app-mobile-input-dialog-edge-gap) - var(--app-mobile-input-dialog-keyboard-gap))')
        expect(dialog.style.transform).toBe('none')
    })

    it('does not raise an editable dialog twice when iOS fixed positioning follows the visual viewport', () => {
        const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 })
        vi.stubGlobal('visualViewport', viewport)
        vi.stubGlobal('innerHeight', 800)
        render(<I18nProvider><BottomDrawer open inputDialog onOpenChange={() => {}} title="Rename" testId="visual-viewport-dialog"><input data-drawer-initial-focus /></BottomDrawer></I18nProvider>)
        const dialog = screen.getByTestId('visual-viewport-dialog')
        const input = dialog.querySelector('input')!
        input.focus()
        act(() => {
            vi.stubGlobal('innerHeight', 400)
            viewport.height = 400
            viewport.dispatchEvent(new Event('resize'))
        })
        expect(dialog).toHaveAttribute('data-keyboard-open', 'true')
        expect(dialog).toHaveAttribute('data-keyboard-fixed-viewport', 'visual')
        expect(dialog.style.getPropertyValue('--drawer-keyboard-bottom')).toBe('0px')
        expect(dialog.style.bottom).toBe('calc(var(--drawer-keyboard-bottom) + var(--app-mobile-input-dialog-keyboard-gap))')
        expect(dialog.style.transform).toBe('none')
    })

    it('keeps an iOS standalone input dialog above the keyboard when innerHeight also shrinks', () => {
        document.documentElement.dataset.iosStandalone = 'true'
        const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 })
        vi.stubGlobal('visualViewport', viewport)
        vi.stubGlobal('innerHeight', 800)
        render(<I18nProvider><BottomDrawer open inputDialog onOpenChange={() => {}} title="Answer" testId="standalone-question-dialog"><textarea data-drawer-initial-focus /></BottomDrawer></I18nProvider>)
        const dialog = screen.getByTestId('standalone-question-dialog')
        screen.getByRole('textbox').focus()

        act(() => {
            vi.stubGlobal('innerHeight', 400)
            viewport.height = 400
            viewport.dispatchEvent(new Event('resize'))
        })

        expect(dialog).toHaveAttribute('data-keyboard-open', 'true')
        expect(dialog).toHaveAttribute('data-keyboard-fixed-viewport', 'layout')
        expect(dialog.style.getPropertyValue('--drawer-keyboard-bottom')).toBe('400px')
        expect(dialog.style.bottom).toBe('calc(var(--drawer-keyboard-bottom) + var(--app-mobile-input-dialog-keyboard-gap))')
    })

    it('keeps the full viewport baseline when a sheet switches into an input dialog', () => {
        const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 })
        vi.stubGlobal('visualViewport', viewport)
        vi.stubGlobal('innerHeight', 800)

        function EditableSheet() {
            const [editing, setEditing] = useState(false)
            return <I18nProvider><BottomDrawer open inputDialog={editing} onOpenChange={() => {}} title="Group" testId="group-dialog">
                {editing
                    ? <input data-drawer-initial-focus aria-label="Group name" />
                    : <button type="button" onClick={() => setEditing(true)}>Edit group</button>}
            </BottomDrawer></I18nProvider>
        }

        render(<EditableSheet />)
        fireEvent.click(screen.getByRole('button', { name: 'Edit group' }))
        const dialog = screen.getByTestId('group-dialog')
        expect(dialog).toHaveAttribute('data-keyboard-safe-dialog', 'true')
        screen.getByRole('textbox', { name: 'Group name' }).focus()

        act(() => {
            vi.stubGlobal('innerHeight', 400)
            viewport.height = 400
            viewport.dispatchEvent(new Event('resize'))
        })

        expect(dialog).toHaveAttribute('data-keyboard-open', 'true')
        expect(dialog.style.bottom).toBe('calc(var(--drawer-keyboard-bottom) + var(--app-mobile-input-dialog-keyboard-gap))')
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
