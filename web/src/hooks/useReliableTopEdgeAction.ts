import {
    useCallback,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type TouchEvent as ReactTouchEvent
} from 'react'
import { markUserInteraction } from '@/lib/interaction-priority'

// A standalone WebKit view can dispatch one compatibility click after the
// touch action has already run. Consume only that next click, rather than
// imposing a time-based cooldown on a later real tap. Keyboard clicks
// (detail === 0) remain untouched.
const TOUCH_TAP_SLOP_PX = 10

type TouchGesture = {
    pointerId: number
    clientX: number
    clientY: number
    moved: boolean
}

type ReliableTopEdgeActionOptions = {
    /**
     * Opt in only for a reversible, local UI toggle. It lets a small popover
     * react on touch-down, while the normal top-edge controls still wait for
     * a completed tap before navigating or starting work.
     */
    activateOnTouchPointerDown?: boolean
    /** Runs immediately before the speculative touch-down action. */
    onTouchActivationStart?: () => void
    /** Restores that local UI state if the gesture becomes a scroll. */
    onTouchActivationCancelled?: () => void
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
    const compatibilityClickPendingRef = useRef(false)
    const touchGestureRef = useRef<TouchGesture | null>(null)
    // This is deliberately separate from the gesture: after rolling a
    // speculative action back for a scroll, the terminal pointer/click must
    // still be consumed instead of firing the action a second time.
    const touchActionHandledRef = useRef(false)
    const touchActivationActiveRef = useRef(false)
    const touchActivationStartRef = useRef(options.onTouchActivationStart)
    const touchActivationCancelledRef = useRef(options.onTouchActivationCancelled)
    const activateOnTouchPointerDown = options.activateOnTouchPointerDown === true
    actionRef.current = action
    touchActivationStartRef.current = options.onTouchActivationStart
    touchActivationCancelledRef.current = options.onTouchActivationCancelled

    const clearCompatibilityClickPending = useCallback(() => {
        compatibilityClickPendingRef.current = false
    }, [])

    const consumeNextCompatibilityClick = useCallback(() => {
        compatibilityClickPendingRef.current = true
    }, [])

    const activateTouchAction = useCallback(() => {
        consumeNextCompatibilityClick()
        actionRef.current()
    }, [consumeNextCompatibilityClick])

    const onPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        markUserInteraction()
        // Mouse presses and a fresh touch must always be allowed to start a
        // new action; neither should inherit an old compatibility-click state.
        clearCompatibilityClickPending()
        if (event.pointerType === 'mouse') {
            touchGestureRef.current = null
            touchActionHandledRef.current = false
            touchActivationActiveRef.current = false
            return
        }

        touchGestureRef.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            moved: false
        }
        touchActionHandledRef.current = false
        touchActivationActiveRef.current = false
        if (activateOnTouchPointerDown) {
            touchActivationStartRef.current?.()
            touchActionHandledRef.current = true
            touchActivationActiveRef.current = true
            activateTouchAction()
        }
    }, [activateOnTouchPointerDown, activateTouchAction, clearCompatibilityClickPending])

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
        if (gesture.moved && touchActivationActiveRef.current) {
            touchActivationActiveRef.current = false
            touchActivationCancelledRef.current?.()
        }
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
            consumeNextCompatibilityClick()
            touchActionHandledRef.current = false
            touchActivationActiveRef.current = false
            return
        }

        event.preventDefault()
        if (touchActionHandledRef.current) {
            touchActionHandledRef.current = false
            touchActivationActiveRef.current = false
            return
        }
        activateTouchAction()
    }, [activateTouchAction, consumeNextCompatibilityClick])

    const onPointerCancel = useCallback(() => {
        const wasScrolling = touchGestureRef.current?.moved === true
        const hadSpeculativeActivation = touchActionHandledRef.current
        touchGestureRef.current = null
        touchActionHandledRef.current = false
        touchActivationActiveRef.current = false
        // A plain cancellation can happen while WebKit repaints. Leave the
        // click fallback available in that case instead of locking the button.
        // The exception is a popover already toggled on touch-down: its
        // follow-up compatibility click must not toggle it back immediately.
        if (wasScrolling || hadSpeculativeActivation) {
            consumeNextCompatibilityClick()
        } else {
            clearCompatibilityClickPending()
        }
    }, [clearCompatibilityClickPending, consumeNextCompatibilityClick])

    const onTouchEnd = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
        const gesture = touchGestureRef.current
        if (!gesture) {
            return
        }

        markUserInteraction()
        touchGestureRef.current = null
        if (gesture.moved) {
            consumeNextCompatibilityClick()
            touchActionHandledRef.current = false
            touchActivationActiveRef.current = false
            return
        }

        // Fallback only: when pointer-up already ran it cleared the gesture,
        // so this path cannot double-trigger the action.
        event.preventDefault()
        if (touchActionHandledRef.current) {
            touchActionHandledRef.current = false
            touchActivationActiveRef.current = false
            return
        }
        activateTouchAction()
    }, [activateTouchAction, consumeNextCompatibilityClick])

    const onClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
        touchGestureRef.current = null
        touchActionHandledRef.current = false
        touchActivationActiveRef.current = false
        const isCompatibilityClick = event.detail !== 0 && compatibilityClickPendingRef.current
        clearCompatibilityClickPending()
        if (isCompatibilityClick) {
            return
        }
        actionRef.current()
    }, [clearCompatibilityClickPending])

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onTouchEnd, onClick }
}
