import {
    useCallback,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type TouchEvent as ReactTouchEvent
} from 'react'
import { markUserInteraction } from '@/lib/interaction-priority'

// A standalone WebKit view can still dispatch a delayed compatibility click
// after the touch action has already run. Keep keyboard clicks (detail === 0)
// untouched, and clear this guard as soon as the next real press begins.
const COMPATIBILITY_CLICK_GUARD_MS = 2_000
const TOUCH_TAP_SLOP_PX = 10

type TouchGesture = {
    pointerId: number
    clientX: number
    clientY: number
    moved: boolean
}

/**
 * One compact activation path for fixed top-edge controls:
 * - pointer-up is the normal touch path;
 * - touch-end only fills in when WebKit drops that pointer-up;
 * - click remains the mouse, keyboard, and last-resort fallback.
 *
 * Do not capture the pointer here. The browser needs to decide whether a
 * touch became a scroll; the touch-end fallback covers a dropped pointer-up
 * without taking that decision away from the browser.
 */
export function useReliableTopEdgeAction(action: () => void): {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void
    onPointerCancel: () => void
    onTouchEnd: (event: ReactTouchEvent<HTMLButtonElement>) => void
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void
} {
    const actionRef = useRef(action)
    const compatibilityClickUntilRef = useRef(0)
    const touchGestureRef = useRef<TouchGesture | null>(null)
    actionRef.current = action

    const clearCompatibilityClickGuard = useCallback(() => {
        compatibilityClickUntilRef.current = 0
    }, [])

    const armCompatibilityClickGuard = useCallback(() => {
        compatibilityClickUntilRef.current = Date.now() + COMPATIBILITY_CLICK_GUARD_MS
    }, [])

    const activateTouchAction = useCallback(() => {
        armCompatibilityClickGuard()
        actionRef.current()
    }, [armCompatibilityClickGuard])

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        markUserInteraction()
        // Mouse presses and a fresh touch must always be allowed to start a
        // new action; neither should inherit an old compatibility-click lock.
        clearCompatibilityClickGuard()
        if (event.pointerType === 'mouse') {
            touchGestureRef.current = null
            return
        }

        touchGestureRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            moved: false
        }
    }, [clearCompatibilityClickGuard])

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
        const gesture = touchGestureRef.current
        if (gesture && gesture.pointerId !== event.pointerId) {
            return
        }

        touchGestureRef.current = null
        if (gesture?.moved) {
            // A touch that became a scroll must not later reappear as a
            // compatibility click on this fixed header control.
            armCompatibilityClickGuard()
            return
        }

        event.preventDefault()
        activateTouchAction()
    }, [activateTouchAction, armCompatibilityClickGuard])

    const onPointerCancel = useCallback(() => {
        const wasScrolling = touchGestureRef.current?.moved === true
        touchGestureRef.current = null
        // A plain cancellation can happen while WebKit repaints. Leave the
        // click fallback available in that case instead of locking the button.
        if (wasScrolling) {
            armCompatibilityClickGuard()
        } else {
            clearCompatibilityClickGuard()
        }
    }, [armCompatibilityClickGuard, clearCompatibilityClickGuard])

    const onTouchEnd = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
        const gesture = touchGestureRef.current
        if (!gesture) {
            return
        }

        markUserInteraction()
        touchGestureRef.current = null
        if (gesture.moved) {
            armCompatibilityClickGuard()
            return
        }

        // Fallback only: when pointer-up already ran it cleared the gesture,
        // so this path cannot double-trigger the action.
        event.preventDefault()
        activateTouchAction()
    }, [activateTouchAction, armCompatibilityClickGuard])

    const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
        touchGestureRef.current = null
        const isCompatibilityClick = event.detail !== 0
            && compatibilityClickUntilRef.current > Date.now()
        clearCompatibilityClickGuard()
        if (isCompatibilityClick) {
            return
        }
        actionRef.current()
    }, [clearCompatibilityClickGuard])

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onTouchEnd, onClick }
}
