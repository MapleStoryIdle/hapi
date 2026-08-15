import { describe, expect, it } from 'vitest'
import {
    getIosStandaloneSystemTopChromeState,
    getKeyboardViewportState,
    IOS_STANDALONE_SYSTEM_TOP_CHROME_MIN_PX,
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

    it('keeps the safe area until a visual viewport resize confirms the keyboard', () => {
        const beforeKeyboardResize = getKeyboardViewportState({
            layoutViewportHeight: 844,
            visualViewportHeight: 520,
            hasFocusedTextEntry: true,
            stableViewportHeight: 844,
            wasKeyboardOpen: false,
            confirmKeyboardOpen: false
        })
        expect(beforeKeyboardResize).toEqual({
            keyboardOpen: false,
            stableViewportHeight: 844
        })

        expect(getKeyboardViewportState({
            layoutViewportHeight: 844,
            visualViewportHeight: 520,
            hasFocusedTextEntry: true,
            stableViewportHeight: beforeKeyboardResize.stableViewportHeight,
            wasKeyboardOpen: beforeKeyboardResize.keyboardOpen,
            confirmKeyboardOpen: true
        })).toEqual({
            keyboardOpen: true,
            stableViewportHeight: 844
        })
    })
})

describe('getIosStandaloneSystemTopChromeState', () => {
    it('recognizes the iOS standalone system strip when the DOM cannot reach it', () => {
        expect(getIosStandaloneSystemTopChromeState({
            isIosStandalone: true,
            screenHeight: 874,
            layoutViewportHeight: 812,
            visualViewportOffsetTop: 0,
            safeAreaTopInset: 0,
            keyboardViewportActive: false
        })).toEqual({
            unreachable: true,
            height: 62
        })
    })

    it('keeps the normal standalone fallback when WebKit reports a real top inset', () => {
        expect(getIosStandaloneSystemTopChromeState({
            isIosStandalone: true,
            screenHeight: 874,
            layoutViewportHeight: 812,
            visualViewportOffsetTop: 0,
            safeAreaTopInset: 44,
            keyboardViewportActive: false
        })).toEqual({
            unreachable: false,
            height: 0
        })
    })

    it('does not confuse the keyboard viewport with unreachable top chrome', () => {
        expect(getIosStandaloneSystemTopChromeState({
            isIosStandalone: true,
            screenHeight: 844,
            layoutViewportHeight: 520,
            visualViewportOffsetTop: 0,
            safeAreaTopInset: 0,
            keyboardViewportActive: true
        })).toEqual({
            unreachable: false,
            height: 0
        })
    })

    it('requires a status-bar-sized gap in an installed iOS web app', () => {
        expect(getIosStandaloneSystemTopChromeState({
            isIosStandalone: true,
            screenHeight: 844,
            layoutViewportHeight: 844 - IOS_STANDALONE_SYSTEM_TOP_CHROME_MIN_PX + 1,
            visualViewportOffsetTop: 0,
            safeAreaTopInset: 0,
            keyboardViewportActive: false
        })).toEqual({
            unreachable: false,
            height: 0
        })

        expect(getIosStandaloneSystemTopChromeState({
            isIosStandalone: false,
            screenHeight: 844,
            layoutViewportHeight: 700,
            visualViewportOffsetTop: 0,
            safeAreaTopInset: 0,
            keyboardViewportActive: false
        })).toEqual({
            unreachable: false,
            height: 0
        })
    })
})
