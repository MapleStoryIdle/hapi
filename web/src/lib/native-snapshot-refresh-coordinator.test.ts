import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createNativeSnapshotRefreshCoordinator,
    isRetryableNativeSnapshotRefreshError,
    isNativeSnapshotVersionCovered,
    type NativeSnapshotVersion
} from './native-snapshot-refresh-coordinator'

afterEach(() => {
    vi.useRealTimers()
})

describe('native snapshot refresh coordinator', () => {
    it('only retries transport and temporary runner failures', () => {
        expect(isRetryableNativeSnapshotRefreshError(new TypeError('fetch failed'))).toBe(true)
        expect(isRetryableNativeSnapshotRefreshError({ status: 503 })).toBe(true)
        expect(isRetryableNativeSnapshotRefreshError({ status: 409, code: 'runner_offline' })).toBe(true)
        expect(isRetryableNativeSnapshotRefreshError({ status: 404, code: 'session_not_found' })).toBe(false)
        expect(isRetryableNativeSnapshotRefreshError(new Error('invalid snapshot'))).toBe(false)
    })

    it('coalesces foreground recovery signals into one read', async () => {
        vi.useFakeTimers()
        const refresh = vi.fn(async () => {})
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => ({ runnerEpoch: 'runner-a', revision: 1 }),
            isVisible: () => true,
            refresh
        })

        coordinator.request({ authoritative: true, delayMs: 250 })
        coordinator.request({ authoritative: true, delayMs: 250 })
        coordinator.request({ authoritative: true, delayMs: 250 })
        await vi.advanceTimersByTimeAsync(250)

        expect(refresh).toHaveBeenCalledTimes(1)
        coordinator.dispose()
    })

    it('keeps one trailing read for updates received in flight', async () => {
        vi.useFakeTimers()
        let current: NativeSnapshotVersion | null = { runnerEpoch: 'runner-a', revision: 1 }
        let finishFirst!: () => void
        const refresh = vi.fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => {
                finishFirst = resolve
            }))
            .mockImplementationOnce(async () => {
                current = { runnerEpoch: 'runner-a', revision: 4 }
            })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => current,
            isVisible: () => true,
            refresh
        })

        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-a', revision: 2 }, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-a', revision: 3 }, delayMs: 0 })
        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-a', revision: 4 }, delayMs: 0 })
        finishFirst()
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(0)

        expect(refresh).toHaveBeenCalledTimes(2)
        coordinator.dispose()
    })

    it('accepts a low revision from a new runner epoch', () => {
        expect(isNativeSnapshotVersionCovered(
            { runnerEpoch: 'old-runner', revision: 100 },
            { runnerEpoch: 'new-runner', revision: 1 }
        )).toBe(false)
        expect(isNativeSnapshotVersionCovered(
            { runnerEpoch: 'new-runner', revision: 2 },
            { runnerEpoch: 'new-runner', revision: 1 }
        )).toBe(true)
    })

    it('performs one bounded confirmation when a stale event resolves to a new runner epoch', async () => {
        vi.useFakeTimers()
        let current: NativeSnapshotVersion | null = { runnerEpoch: 'runner-a', revision: 100 }
        const refresh = vi.fn(async () => {
            current = { runnerEpoch: 'runner-b', revision: 1 }
        })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => current,
            isVisible: () => true,
            refresh
        })

        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-a', revision: 101 }, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(1_000)

        expect(refresh).toHaveBeenCalledTimes(2)
        coordinator.dispose()
    })

    it('recovers when a request pinned to the old runner returns after the new runner event', async () => {
        vi.useFakeTimers()
        let current: NativeSnapshotVersion | null = { runnerEpoch: 'runner-a', revision: 99 }
        const refresh = vi.fn()
            .mockImplementationOnce(async () => {
                current = { runnerEpoch: 'runner-a', revision: 100 }
            })
            .mockImplementationOnce(async () => {
                current = { runnerEpoch: 'runner-b', revision: 2 }
            })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => current,
            isVisible: () => true,
            refresh
        })

        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-b', revision: 2 }, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(250)
        await vi.advanceTimersByTimeAsync(1_000)

        expect(refresh).toHaveBeenCalledTimes(2)
        expect(current).toEqual({ runnerEpoch: 'runner-b', revision: 2 })
        coordinator.dispose()
    })

    it('confirms once when a retiring legacy runner returns no version', async () => {
        vi.useFakeTimers()
        let current: NativeSnapshotVersion | null = { runnerEpoch: 'runner-a', revision: 99 }
        const refresh = vi.fn()
            .mockImplementationOnce(async () => {
                current = null
            })
            .mockImplementationOnce(async () => {
                current = { runnerEpoch: 'runner-b', revision: 2 }
            })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => current,
            isVisible: () => true,
            refresh
        })

        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-b', revision: 2 }, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(250)

        expect(refresh).toHaveBeenCalledTimes(2)
        expect(current).toEqual({ runnerEpoch: 'runner-b', revision: 2 })
        coordinator.dispose()
    })

    it('does not let a covered old-runner event replace a pending new-runner refresh', async () => {
        vi.useFakeTimers()
        let current: NativeSnapshotVersion | null = { runnerEpoch: 'runner-a', revision: 100 }
        const refresh = vi.fn(async () => {
            current = { runnerEpoch: 'runner-b', revision: 1 }
        })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => current,
            isVisible: () => true,
            refresh
        })

        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-b', revision: 1 }, delayMs: 250 })
        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-a', revision: 100 }, delayMs: 250 })
        await vi.advanceTimersByTimeAsync(250)

        expect(refresh).toHaveBeenCalledTimes(1)
        expect(current).toEqual({ runnerEpoch: 'runner-b', revision: 1 })
        coordinator.dispose()
    })

    it('retains the required runner version across a failed refresh', async () => {
        vi.useFakeTimers()
        let current: NativeSnapshotVersion | null = { runnerEpoch: 'runner-a', revision: 1 }
        const refresh = vi.fn()
            .mockRejectedValueOnce(new TypeError('temporary disconnect'))
            .mockImplementationOnce(async () => {
                current = { runnerEpoch: 'runner-a', revision: 2 }
            })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => current,
            isVisible: () => true,
            refresh,
            random: () => 0.5
        })

        coordinator.request({ requiredVersion: { runnerEpoch: 'runner-a', revision: 2 }, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(500)

        expect(refresh).toHaveBeenCalledTimes(2)
        expect(current).toEqual({ runnerEpoch: 'runner-a', revision: 2 })
        coordinator.dispose()
    })

    it('does not loop after a permanent response error', async () => {
        vi.useFakeTimers()
        const refresh = vi.fn().mockRejectedValue({ status: 404, code: 'session_not_found' })
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => ({ runnerEpoch: 'runner-a', revision: 1 }),
            isVisible: () => true,
            refresh,
            random: () => 0.5
        })

        coordinator.request({ authoritative: true, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(60_000)

        expect(refresh).toHaveBeenCalledTimes(1)
        coordinator.dispose()
    })

    it('caps one automatic retry round until a new signal arrives', async () => {
        vi.useFakeTimers()
        const refresh = vi.fn().mockRejectedValue(new TypeError('offline'))
        const coordinator = createNativeSnapshotRefreshCoordinator({
            getCurrentVersion: () => ({ runnerEpoch: 'runner-a', revision: 1 }),
            isVisible: () => true,
            refresh,
            random: () => 0.5,
            maxRetryAttempts: 2
        })

        coordinator.request({ authoritative: true, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(60_000)
        expect(refresh).toHaveBeenCalledTimes(3)

        coordinator.request({ authoritative: true, delayMs: 0 })
        await vi.advanceTimersByTimeAsync(0)
        expect(refresh).toHaveBeenCalledTimes(4)
        coordinator.dispose()
    })
})
