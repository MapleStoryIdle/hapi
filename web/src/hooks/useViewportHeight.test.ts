import { describe, expect, it } from 'vitest'
import {
    getKeyboardViewportState,
    KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX,
    shouldUseVisualViewportHeight
} from './useViewportHeight'

describe('shouldUseVisualViewportHeight', () => {
    it('uses the visual viewport for a focused text input with a keyboard-sized delta', () => {
        expect(shouldUseVisualViewportHeight(800, 400, true)).toBe(true)
    })

    it('does not shrink the app for an unfocused visual viewport difference', () => {
        expect(shouldUseVisualViewportHeight(800, 400, false)).toBe(false)
    })

    it('ignores the iOS safe-area-sized difference after the keyboard closes', () => {
        expect(shouldUseVisualViewportHeight(852, 818, true)).toBe(false)
    })

    it('requires a delta larger than the keyboard threshold', () => {
        expect(shouldUseVisualViewportHeight(800, 800 - KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX, true)).toBe(false)
        expect(shouldUseVisualViewportHeight(800, 800 - KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX - 1, true)).toBe(true)
    })

    it('keeps the pre-keyboard height while the root has already shrunk', () => {
        const keyboardOpen = getKeyboardViewportState({
            layoutViewportHeight: 844,
            visualViewportHeight: 520,
            hasFocusedTextEntry: true,
            stableViewportHeight: 844
        })
        expect(keyboardOpen).toEqual({
            keyboardOpen: true,
            stableViewportHeight: 844
        })

        const subsequentResize = getKeyboardViewportState({
            layoutViewportHeight: 520,
            visualViewportHeight: 520,
            hasFocusedTextEntry: true,
            stableViewportHeight: keyboardOpen.stableViewportHeight
        })
        expect(subsequentResize).toEqual({
            keyboardOpen: true,
            stableViewportHeight: 844
        })
    })
})
