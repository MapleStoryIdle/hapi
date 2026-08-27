import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { markUserInteraction } from '@/lib/interaction-priority'

// Safari standalone can dispatch the compatibility click long after a touch
// pointer-up if rendering was busy. Keep the guard longer than one frame, but
// only consume pointer-style clicks; keyboard clicks have detail === 0.
const COMPATIBILITY_CLICK_GUARD_MS = 2_000

export function useReliableTopEdgeAction(action: () => void): {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: () => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
} {
    const actionRef = useRef(action)
    const compatibilityClickUntilRef = useRef(0)
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    actionRef.current = action

    const clearCompatibilityClickGuard = useCallback(() => {
        compatibilityClickUntilRef.current = 0
        if (resetTimerRef.current !== null) {
            clearTimeout(resetTimerRef.current)
            resetTimerRef.current = null
        }
    }, [])

    useEffect(() => clearCompatibilityClickGuard, [clearCompatibilityClickGuard])

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        markUserInteraction()
        // A real mouse press must not be mistaken for the old touch's delayed
        // compatibility click.
        if (event.pointerType === 'mouse') {
            clearCompatibilityClickGuard()
        }
    }, [clearCompatibilityClickGuard])

    const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'mouse') {
            return
        }

        markUserInteraction()
        compatibilityClickUntilRef.current = Date.now() + COMPATIBILITY_CLICK_GUARD_MS
        if (resetTimerRef.current !== null) {
            clearTimeout(resetTimerRef.current)
        }
        resetTimerRef.current = setTimeout(() => {
            compatibilityClickUntilRef.current = 0
            resetTimerRef.current = null
        }, COMPATIBILITY_CLICK_GUARD_MS)
        event.preventDefault()
        actionRef.current()
    }, [])

    const onPointerCancel = useCallback(() => {
        clearCompatibilityClickGuard()
    }, [clearCompatibilityClickGuard])

    const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
        const isDelayedPointerClick = event.detail !== 0
            && compatibilityClickUntilRef.current > Date.now()
        clearCompatibilityClickGuard()
        if (isDelayedPointerClick) {
            return
        }
        actionRef.current()
    }, [clearCompatibilityClickGuard])

    return { onPointerDown, onPointerUp, onPointerCancel, onClick }
}
