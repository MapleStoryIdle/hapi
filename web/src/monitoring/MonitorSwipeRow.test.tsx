import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MonitorSwipeRow } from './MonitorSwipeRow'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('has no visible delete until revealed, supports keyboard reveal, and blocks deletion while busy', () => {
    const remove = vi.fn()
    const { rerender } = render(<MonitorSwipeRow onDelete={remove} deleteLabel="Delete"><a href="#monitor">Monitor</a></MonitorSwipeRow>)
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    fireEvent.keyDown(screen.getByText('Monitor'), { key: 'Delete' })
    expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible()
    expect(remove).not.toHaveBeenCalled()
    rerender(<MonitorSwipeRow disabled onDelete={remove} deleteLabel="Delete"><a href="#monitor">Monitor</a></MonitorSwipeRow>)
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByText('Monitor'), { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
})

it('reveals delete only on a horizontal swipe and suppresses accidental navigation', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const remove = vi.fn(), navigate = vi.fn()
    render(<MonitorSwipeRow onDelete={remove} deleteLabel="Delete"><a onClick={navigate}>Monitor</a></MonitorSwipeRow>)
    const link = screen.getByText('Monitor')
    const row = link.parentElement!
    row.setPointerCapture = vi.fn()
    fireEvent.pointerDown(link, { button: 0, clientX: 220, clientY: 50 })
    fireEvent.pointerMove(row, { clientX: 140, clientY: 52 })
    fireEvent.pointerUp(row)
    expect(row.style.transform).toBe('translateX(-80px)')
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(navigate).not.toHaveBeenCalled()
    expect(row.style.transform).toBe('translateX(-80px)')
    fireEvent.click(link)
    expect(row.style.transform).toBe('translateX(0px)')
    fireEvent.pointerDown(link, { button: 0, clientX: 220, clientY: 50 })
    fireEvent.pointerMove(row, { clientX: 215, clientY: 120 })
    fireEvent.pointerUp(row)
    expect(row.style.transform).toBe('translateX(0px)')
    fireEvent.pointerDown(link, { button: 0, clientX: 220, clientY: 50 })
    fireEvent.pointerMove(row, { clientX: 130, clientY: 52 })
    fireEvent.pointerUp(row)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(remove).toHaveBeenCalledOnce()
})
