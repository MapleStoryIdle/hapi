import { useSyncExternalStore } from 'react'

const TICK_MS = 1_000
const listeners = new Set<() => void>()
const noopSubscribe = () => () => {}
let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
let visibilityListenerInstalled = false

function isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
}

function publishNow(): void {
    now = Date.now()
    for (const listener of listeners) listener()
}

function stopTimer(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
}

function syncTimer(): void {
    if (listeners.size === 0 || !isVisible()) {
        stopTimer()
        return
    }
    if (timer !== null) return
    timer = setInterval(publishNow, TICK_MS)
}

function handleVisibilityChange(): void {
    if (isVisible()) publishNow()
    syncTimer()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    now = Date.now()
    if (!visibilityListenerInstalled && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange)
        visibilityListenerInstalled = true
    }
    syncTimer()

    return () => {
        listeners.delete(listener)
        syncTimer()
        if (listeners.size === 0 && visibilityListenerInstalled && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            visibilityListenerInstalled = false
        }
    }
}

function getSnapshot(): number {
    return now
}

/** One visibility-aware clock shared by every active elapsed-time label. */
export function useSharedNow(active: boolean): number {
    return useSyncExternalStore(active ? subscribe : noopSubscribe, getSnapshot, getSnapshot)
}
