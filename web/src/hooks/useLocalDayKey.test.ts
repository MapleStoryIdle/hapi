import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLocalDayKey } from './useLocalDayKey'

afterEach(() => {
    vi.useRealTimers()
})

describe('useLocalDayKey', () => {
    it('updates after the next local midnight without waiting for share data to change', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2025, 0, 7, 23, 59, 59, 900))
        const { result } = renderHook(() => useLocalDayKey())

        expect(result.current).toBe('2025-01-07')
        act(() => { vi.advanceTimersByTime(200) })
        expect(result.current).toBe('2025-01-08')
    })
})
