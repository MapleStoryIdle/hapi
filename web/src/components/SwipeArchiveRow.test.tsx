import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SwipeArchiveRow } from './SwipeArchiveRow'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('swipes a button card without navigating or archiving until the action is clicked', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const archive = vi.fn(), open = vi.fn()
    render(<SwipeArchiveRow label="Archive" onArchive={archive}><button onClick={open}>Session</button></SwipeArchiveRow>)
    const card = screen.getByText('Session'), row = card.parentElement!
    row.setPointerCapture = vi.fn()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    fireEvent.pointerDown(card, { button: 0, clientX: 200, clientY: 50 })
    fireEvent.pointerMove(row, { clientX: 110, clientY: 52 })
    fireEvent.pointerUp(row)
    fireEvent.click(card)
    expect(row.style.transform).toBe('translateX(-80px)')
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('bg-red-600')
    expect(open).not.toHaveBeenCalled()
    expect(archive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(archive).toHaveBeenCalledOnce()
    expect(row.style.transform).toBe('translateX(0px)')
})

it('leaves vertical scrolling alone and supports keyboard reveal and dismissal', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    render(<SwipeArchiveRow label="Archive" onArchive={vi.fn()}><button>Session</button></SwipeArchiveRow>)
    const card = screen.getByText('Session'), row = card.parentElement!
    fireEvent.pointerDown(card, { button: 0, clientX: 200, clientY: 50 })
    fireEvent.pointerMove(row, { clientX: 195, clientY: 110 })
    fireEvent.pointerUp(row)
    expect(row.style.transform).toBe('translateX(0px)')
    fireEvent.keyDown(card, { key: 'ArrowLeft' })
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled()
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
})
