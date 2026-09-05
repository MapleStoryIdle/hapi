import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeFeedbackSilence } from './useNativeFeedbackSilence'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useNativeFeedbackSilence', () => {
    it('requires a full 15 seconds, not time already spent in an old session', () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderHook(({ now }) => useNativeFeedbackSilence('session:old-receipt', now), {
            initialProps: { now: 100_000 }
        })
        view.rerender({ now: 114_999 })
        expect(view.result.current).toBe(false)
        view.rerender({ now: 115_000 })
        expect(view.result.current).toBe(true)
        expect(vi.getTimerCount()).toBe(0) // Reuse the page clock, no extra poll/timer.
    })

    it('resets immediately on actual progress, but not an identical refreshed snapshot', () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderHook(({ activity, now }) => useNativeFeedbackSilence(activity, now), {
            initialProps: { activity: 'session:launching:revision-1', now: 100_000 }
        })
        act(() => vi.setSystemTime(115_000))
        view.rerender({ activity: 'session:launching:revision-1', now: 115_000 })
        expect(view.result.current).toBe(true)
        view.rerender({ activity: 'session:matching:revision-1', now: 115_000 })
        expect(view.result.current).toBe(false)
        view.rerender({ activity: 'session:matching:revision-1', now: 129_999 })
        expect(view.result.current).toBe(false)
        view.rerender({ activity: 'session:matching:revision-1', now: 130_000 })
        expect(view.result.current).toBe(true)
        act(() => vi.setSystemTime(130_000))
        view.rerender({ activity: 'session:matching:revision-2', now: 130_000 })
        expect(view.result.current).toBe(false)
    })

    it('starts fresh for another session and does not mistake a backwards clock for silence', () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderHook(({ activity, now }) => useNativeFeedbackSilence(activity, now), {
            initialProps: { activity: 'session-a', now: 100_000 }
        })
        act(() => vi.setSystemTime(120_000))
        view.rerender({ activity: 'session-a', now: 120_000 })
        expect(view.result.current).toBe(true)
        view.rerender({ activity: 'session-b', now: 120_000 })
        expect(view.result.current).toBe(false)
        view.rerender({ activity: 'session-b', now: 119_000 })
        expect(view.result.current).toBe(false)
    })
})
