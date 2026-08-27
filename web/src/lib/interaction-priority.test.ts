import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    USER_INTERACTION_GRACE_MS,
    deferUntilUserInteractionSettles,
    getUserInteractionDelay,
    markUserInteraction,
    resetInteractionPriorityForTests,
    scheduleBackgroundWork,
} from '@/lib/interaction-priority'

afterEach(() => {
    resetInteractionPriorityForTests()
    vi.useRealTimers()
})

describe('interaction priority', () => {
    it('puts reconnect work behind the current event task', () => {
        vi.useFakeTimers()
        const work = vi.fn()

        scheduleBackgroundWork(work)

        expect(work).not.toHaveBeenCalled()
        vi.runOnlyPendingTimers()
        expect(work).toHaveBeenCalledTimes(1)
    })

    it('keeps background work behind a direct interaction window', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'))
        const work = vi.fn()

        markUserInteraction()
        scheduleBackgroundWork(work)

        expect(getUserInteractionDelay()).toBe(USER_INTERACTION_GRACE_MS)
        vi.advanceTimersByTime(USER_INTERACTION_GRACE_MS - 1)
        expect(work).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(work).toHaveBeenCalledTimes(1)
    })

    it('does not add a timer to the normal fast path', () => {
        const work = vi.fn()

        expect(deferUntilUserInteractionSettles(work)).toBe(false)
        expect(work).not.toHaveBeenCalled()
    })
})
