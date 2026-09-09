import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDrawerExitPresence } from './useDrawerExitPresence'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('retains the owner through exit and cancels removal when reopened', () => {
    vi.useFakeTimers()
    const view = renderHook(({ visible }) => useDrawerExitPresence(visible), { initialProps: { visible: true } })
    view.rerender({ visible: false })
    act(() => vi.advanceTimersByTime(400))
    expect(view.result.current).toBe(true)
    view.rerender({ visible: true })
    act(() => vi.advanceTimersByTime(420))
    expect(view.result.current).toBe(true)
    view.rerender({ visible: false })
    act(() => vi.advanceTimersByTime(420))
    expect(view.result.current).toBe(false)
})
