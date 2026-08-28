import {
    useCallback,
    useEffect,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type TouchEvent as ReactTouchEvent
} from 'react'
import { markUserInteraction } from '@/lib/interaction-priority'

// Safari standalone can dispatch the compatibility click long after a touch
// pointer-up if rendering was busy. Keep the guard longer than one frame, but
// only consume pointer-style clicks; keyboard clicks have detail === 0.
const COMPATIBILITY_CLICK_GUARD_MS = 2_000
const TOUCH_TAP_SLOP_PX = 10

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
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: () => void
    onTouchEnd: (event: ReactTouchEvent<HTMLButtonElement>) => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
} {
    const actionRef = useRef(action)
    const compatibilityClickUntilRef = useRef(0)
    const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const touchActionHandledRef = useRef(false)
    const touchGestureRef = useRef<{
        pointerId: number
        clientX: number
        clientY: number
        moved: boolean
    } | null>(null)
    actionRef.current = action

    const clearCompatibilityClickGuard = useCallback(() => {
        compatibilityClickUntilRef.current = 0
        if (resetTimerRef.current !== null) {
            clearTimeout(resetTimerRef.current)
            resetTimerRef.current = null
        }
    }, [])

    useEffect(() => clearCompatibilityClickGuard, [clearCompatibilityClickGuard])

    const armCompatibilityClickGuard = useCallback(() => {
        compatibilityClickUntilRef.current = Date.now() + COMPATIBILITY_CLICK_GUARD_MS
        if (resetTimerRef.current !== null) {
            clearTimeout(resetTimerRef.current)
        }
        resetTimerRef.current = setTimeout(() => {
            compatibilityClickUntilRef.current = 0
            resetTimerRef.current = null
        }, COMPATIBILITY_CLICK_GUARD_MS)
    }, [])

    const activateTouchAction = useCallback(() => {
        if (touchActionHandledRef.current) {
            return
        }

        touchActionHandledRef.current = true
        armCompatibilityClickGuard()
        actionRef.current()
    }, [armCompatibilityClickGuard])

    const cancelTouchAction = useCallback(() => {
        touchGestureRef.current = null
        touchActionHandledRef.current = true
        // A cancelled scroll gesture can still produce a compatibility click
        // on standalone WebKit. Consume it instead of treating it as a tap.
        armCompatibilityClickGuard()
    }, [armCompatibilityClickGuard])

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        markUserInteraction()
        // A real mouse press must not be mistaken for the old touch's delayed
        // compatibility click.
        if (event.pointerType === 'mouse') {
            touchGestureRef.current = null
            touchActionHandledRef.current = false
            clearCompatibilityClickGuard()
            return
        }

        touchGestureRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            moved: false
        }
        touchActionHandledRef.current = false
        // Explicit capture keeps the terminal event attached to this control
        // if a live update repaints the message view mid-gesture.
        try {
            event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
            // Older WebKit already uses implicit touch capture.
        }

        if (options.activateOnTouchPointerDown) {
            activateTouchAction()
        }
    }, [activateTouchAction, clearCompatibilityClickGuard, options.activateOnTouchPointerDown])

    const onPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'mouse') {
            return
        }

        const gesture = touchGestureRef.current
        if (!gesture || gesture.pointerId !== event.pointerId || gesture.moved) {
            return
        }

        gesture.moved = Math.abs(event.clientX - gesture.clientX) > TOUCH_TAP_SLOP_PX
            || Math.abs(event.clientY - gesture.clientY) > TOUCH_TAP_SLOP_PX
    }, [])

    const onPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.pointerType === 'mouse') {
            return
        }

        markUserInteraction()
        try {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
            }
        } catch {
            // The control may already have been repainted or unmounted.
        }

        const gesture = touchGestureRef.current
        if (gesture && gesture.pointerId === event.pointerId && gesture.moved) {
            event.preventDefault()
            cancelTouchAction()
            return
        }

        touchGestureRef.current = null
        event.preventDefault()
        activateTouchAction()
    }, [activateTouchAction, cancelTouchAction])

    const onPointerCancel = useCallback(() => {
        cancelTouchAction()
    }, [cancelTouchAction])

    const onTouchEnd = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
        markUserInteraction()
        event.preventDefault()

        if (touchGestureRef.current?.moved) {
            cancelTouchAction()
            return
        }

        touchGestureRef.current = null
        // Some standalone WebKit builds lose pointer-up during a re-render but
        // still deliver touch-end. This is a one-shot fallback for that case.
        activateTouchAction()
    }, [activateTouchAction, cancelTouchAction])

    const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
        const isDelayedPointerClick = event.detail !== 0
            && compatibilityClickUntilRef.current > Date.now()
        touchGestureRef.current = null
        touchActionHandledRef.current = false
        clearCompatibilityClickGuard()
        if (isDelayedPointerClick) {
            return
        }
        actionRef.current()
    }, [clearCompatibilityClickGuard])

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onTouchEnd, onClick }
}
