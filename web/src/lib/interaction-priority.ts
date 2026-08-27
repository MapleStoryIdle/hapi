// Keep network-driven React work out of the small window where a person is
// actively pressing a control. The browser has one main thread: this does not
// preempt a task that has already started, but it prevents the next SSE batch
// or reconnect refresh from starting between pointer-down and click.
export const USER_INTERACTION_GRACE_MS = 250

let interactionUntil = 0
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null
const pendingBackgroundWork = new Set<() => void>()

export function getUserInteractionDelay(now = Date.now()): number {
    return Math.max(0, interactionUntil - now)
}

function schedulePendingFlush(): void {
    if (pendingFlushTimer !== null) {
        clearTimeout(pendingFlushTimer)
    }

    pendingFlushTimer = setTimeout(() => {
        pendingFlushTimer = null
        const delay = getUserInteractionDelay()
        if (delay > 0) {
            schedulePendingFlush()
            return
        }

        const work = Array.from(pendingBackgroundWork)
        pendingBackgroundWork.clear()
        for (const run of work) {
            run()
        }
    }, getUserInteractionDelay())
}

/**
 * Marks a direct human interaction. Callers should do this from a native
 * capture listener or pointer-down, before React background updates can run.
 */
export function markUserInteraction(): void {
    interactionUntil = Math.max(interactionUntil, Date.now() + USER_INTERACTION_GRACE_MS)
    if (pendingBackgroundWork.size > 0) {
        schedulePendingFlush()
    }
}

/**
 * Defers a one-off visual batch only when a direct interaction is underway.
 * Returns true when the work was deferred, so normal fast paths stay exactly
 * as they were outside the interaction window.
 */
export function deferUntilUserInteractionSettles(work: () => void): boolean {
    if (getUserInteractionDelay() === 0) {
        return false
    }

    pendingBackgroundWork.add(work)
    schedulePendingFlush()
    return true
}

/**
 * Schedules reconnect/cache work off the current event task, then waits for
 * any active interaction window. This makes data recovery reliable without
 * letting a reconnect steal the click that happened at the same time.
 */
export function scheduleBackgroundWork(work: () => void): void {
    pendingBackgroundWork.add(work)
    schedulePendingFlush()
}

/** Test-only cleanup for the module-level browser coordinator. */
export function resetInteractionPriorityForTests(): void {
    interactionUntil = 0
    pendingBackgroundWork.clear()
    if (pendingFlushTimer !== null) {
        clearTimeout(pendingFlushTimer)
        pendingFlushTimer = null
    }
}
