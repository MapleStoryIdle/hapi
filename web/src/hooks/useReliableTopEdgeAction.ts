import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { markUserInteraction } from '@/lib/interaction-priority'

// Safari standalone can dispatch the compatibility click long after a touch
// pointer-up if rendering was busy. Keep the guard longer than one frame, but
// only consume pointer-style clicks; keyboard clicks have detail === 0.
const COMPATIBILITY_CLICK_GUARD_MS = 2_000

type ReliableTopEdgeActionOptions = {
    /**
     * Use this only for small state-only controls such as the session title
     * details toggle. It makes a touch responsive before WebKit has a chance
     * to drop the pointer-up/click pair while the header is repainting.
     */
    activateOnTouchPointerDown?: boolean
}

export function useReliableTopEdgeAction(
    action: () => void,
    options: ReliableTopEdgeActionOptions = {}
): {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: () => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
} {
    const actionRef = useRef(action)
    const compatibilityClickUntilRef = useRef(0)
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const activatedOnPointerDownRef = useRef(false)
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
            activatedOnPointerDownRef.current = false
            clearCompatibilityClickGuard()
            return
        }

        if (options.activateOnTouchPointerDown) {
            activatedOnPointerDownRef.current = true
            compatibilityClickUntilRef.current = Date.now() + COMPATIBILITY_CLICK_GUARD_MS
            if (resetTimerRef.current !== null) {
                clearTimeout(resetTimerRef.current)
            }
            resetTimerRef.current = setTimeout(() => {
                compatibilityClickUntilRef.current = 0
                resetTimerRef.current = null
            }, COMPATIBILITY_CLICK_GUARD_MS)
            actionRef.current()
        }
    }, [clearCompatibilityClickGuard, options.activateOnTouchPointerDown])

    const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'mouse') {
            return
        }

        markUserInteraction()
        if (activatedOnPointerDownRef.current) {
            activatedOnPointerDownRef.current = false
            event.preventDefault()
            return
        }
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
        activatedOnPointerDownRef.current = false
        clearCompatibilityClickGuard()
    }, [clearCompatibilityClickGuard])

    const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
        const isDelayedPointerClick = event.detail !== 0
            && compatibilityClickUntilRef.current > Date.now()
        activatedOnPointerDownRef.current = false
        clearCompatibilityClickGuard()
        if (isDelayedPointerClick) {
            return
        }
        actionRef.current()
    }, [clearCompatibilityClickGuard])

    return { onPointerDown, onPointerUp, onPointerCancel, onClick }
}
