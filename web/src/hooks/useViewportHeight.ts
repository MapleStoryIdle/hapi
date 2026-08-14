import { useEffect } from 'react'
import { isTelegramApp } from '@/hooks/useTelegram'

/**
 * iOS standalone PWAs with `viewport-fit=cover` can report a visual viewport
 * that is only the bottom safe-area inset shorter while no keyboard is open.
 * A real software keyboard is substantially taller than that on mobile.
 */
export const KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX = 120

export function shouldUseVisualViewportHeight(
    layoutViewportHeight: number,
    visualViewportHeight: number,
    hasFocusedTextEntry: boolean
): boolean {
    return hasFocusedTextEntry
        && layoutViewportHeight - visualViewportHeight > KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX
}

function hasFocusedTextEntry(): boolean {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLTextAreaElement) return true

    if (activeElement instanceof HTMLInputElement) {
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(activeElement.type)
    }

    return activeElement instanceof HTMLElement && activeElement.isContentEditable
}

/**
 * Sets a CSS custom property `--app-viewport-height` on <html> that tracks the
 * visual viewport height. This is a fallback for browsers that do not support
 * the `interactive-widget=resizes-content` viewport meta attribute — on those
 * browsers `100dvh` does NOT shrink when the virtual keyboard opens, so the
 * composer input is hidden behind the keyboard.
 *
 * The hook listens to `window.visualViewport.resize` and writes the viewport
 * height into the CSS variable. The CSS height chain is:
 *   var(--tg-viewport-stable-height, var(--app-viewport-height, 100dvh))
 *
 * Skipped in Telegram Mini Apps (Telegram SDK provides its own height variable).
 */
export function useViewportHeight(): void {
    useEffect(() => {
        // Telegram Mini App has its own viewport management via --tg-viewport-stable-height
        if (isTelegramApp()) return

        const viewport = window.visualViewport
        if (!viewport) return

        const root = document.documentElement

        function update() {
            if (!viewport) return
            // Do not treat every visual-viewport difference as a keyboard. In
            // particular, installed iOS PWAs with viewport-fit=cover can report
            // visualViewport.height minus the bottom safe area after the
            // keyboard has closed. Require focused text entry and a keyboard-
            // sized delta before shrinking the app root.
            if (shouldUseVisualViewportHeight(window.innerHeight, viewport.height, hasFocusedTextEntry())) {
                root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
                // The visual viewport ends at the keyboard, so retaining the
                // hardware home-indicator fallback here would leave a gap
                // above it.
                root.style.setProperty('--app-safe-area-bottom', '0px')
                // On iOS PWA (black-translucent status bar + viewport-fit=cover),
                // the browser scrolls the page upward when the keyboard opens to
                // keep the focused input visible. This pushes the header behind
                // the iOS status bar. Reset the page scroll so the app stays
                // pinned to the top — the inner flex layout already handles
                // keeping the composer visible.
                if (window.scrollY > 0) {
                    window.scrollTo(0, 0)
                }
            } else {
                root.style.removeProperty('--app-viewport-height')
                root.style.removeProperty('--app-safe-area-bottom')
            }
        }

        viewport.addEventListener('resize', update)
        viewport.addEventListener('scroll', update)
        document.addEventListener('focusin', update)
        document.addEventListener('focusout', update)

        return () => {
            viewport.removeEventListener('resize', update)
            viewport.removeEventListener('scroll', update)
            document.removeEventListener('focusin', update)
            document.removeEventListener('focusout', update)
            root.style.removeProperty('--app-viewport-height')
            root.style.removeProperty('--app-safe-area-bottom')
        }
    }, [])
}
