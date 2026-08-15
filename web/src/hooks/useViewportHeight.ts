import { useEffect } from 'react'
import { isTelegramApp } from '@/hooks/useTelegram'

/**
 * iOS standalone PWAs with `viewport-fit=cover` can report a visual viewport
 * that is only the bottom safe-area inset shorter while no keyboard is open.
 * A real software keyboard is substantially taller than that on mobile.
 */
export const KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX = 120
// WebKit bug 301994 can reserve a status-bar-sized strip above the DOM in a
// Home Screen PWA while reporting a zero top safe-area inset. Treat only a
// status-bar-sized gap as system-owned; ordinary bottom safe areas are smaller.
export const IOS_STANDALONE_SYSTEM_TOP_CHROME_MIN_PX = 48

export function getIosStandaloneSystemTopChromeState(params: {
    isIosStandalone: boolean
    screenHeight: number
    layoutViewportHeight: number
    visualViewportOffsetTop: number
    safeAreaTopInset: number
    keyboardViewportActive: boolean
}): {
    unreachable: boolean
    height: number
} {
    const height = Math.max(0, Math.round(params.screenHeight - params.layoutViewportHeight))
    const unreachable = params.isIosStandalone
        && params.safeAreaTopInset <= 0
        && Math.abs(params.visualViewportOffsetTop) < 1
        && !params.keyboardViewportActive
        && height >= IOS_STANDALONE_SYSTEM_TOP_CHROME_MIN_PX

    return {
        unreachable,
        height: unreachable ? height : 0
    }
}

export function shouldUseVisualViewportHeight(
    layoutViewportHeight: number,
    visualViewportHeight: number,
    hasFocusedTextEntry: boolean
): boolean {
    return hasFocusedTextEntry
        && layoutViewportHeight - visualViewportHeight > KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX
}

export function getKeyboardViewportState(params: {
    layoutViewportHeight: number
    visualViewportHeight: number
    hasFocusedTextEntry: boolean
    stableViewportHeight: number
    /** A keyboard-sized visual viewport shrink was previously confirmed. */
    wasKeyboardOpen?: boolean
    /** Only visualViewport.resize may confirm that the keyboard opened. */
    confirmKeyboardOpen?: boolean
}): {
    keyboardOpen: boolean
    stableViewportHeight: number
} {
    // On recent standalone iOS, window.innerHeight can follow the visual
    // viewport while the keyboard is open. Use the document layout height plus
    // the last stable value captured before the keyboard changed the root
    // height. Without that remembered baseline, the next resize sees two equal
    // heights and incorrectly removes the keyboard layout state again.
    const referenceViewportHeight = Math.max(
        params.layoutViewportHeight,
        params.stableViewportHeight
    )
    const hasKeyboardSizedViewport = shouldUseVisualViewportHeight(
        referenceViewportHeight,
        params.visualViewportHeight,
        params.hasFocusedTextEntry
    )
    const keyboardOpen = hasKeyboardSizedViewport
        && (params.wasKeyboardOpen === true || params.confirmKeyboardOpen !== false)

    return {
        keyboardOpen,
        stableViewportHeight: keyboardOpen
            ? referenceViewportHeight
            : Math.max(params.layoutViewportHeight, params.visualViewportHeight)
    }
}

function hasFocusedTextEntry(): boolean {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLTextAreaElement) return true

    if (activeElement instanceof HTMLInputElement) {
        return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(activeElement.type)
    }

    return activeElement instanceof HTMLElement && activeElement.isContentEditable
}

function isIosStandalone(): boolean {
    const nav = navigator as Navigator & { standalone?: boolean }
    const isIos = /iPad|iPhone|iPod/.test(nav.userAgent)
        || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
    const isStandalone = nav.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches

    return isIos && isStandalone
}

function markIosStandalone(root: HTMLElement): boolean {
    const standalone = isIosStandalone()

    // The synchronous document-head check handles first paint. Re-check here
    // because Home Screen WebKit can settle this state after the initial page
    // lifecycle event. Never remove the marker during this page lifetime: an
    // installed app cannot turn into browser Safari without a navigation.
    if (standalone) {
        root.setAttribute('data-ios-standalone', 'true')
    }

    return standalone
}

function getBrowserSafeAreaTopInset(): number {
    if (!document.body) {
        return 0
    }

    const probe = document.createElement('div')
    probe.style.cssText = [
        'position:fixed',
        'inset:0 auto auto 0',
        'visibility:hidden',
        'pointer-events:none',
        'padding-top:env(safe-area-inset-top, 0px)'
    ].join(';')
    document.body.appendChild(probe)
    const inset = Number.parseFloat(window.getComputedStyle(probe).paddingTop)
    probe.remove()

    return Number.isFinite(inset) ? inset : 0
}

function syncIosStandaloneSystemTopChrome(root: HTMLElement, state: {
    unreachable: boolean
}): void {
    if (state.unreachable) {
        root.setAttribute('data-ios-system-top-chrome', 'unreachable')
        return
    }

    root.removeAttribute('data-ios-system-top-chrome')
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
        const root = document.documentElement
        let stableViewportHeight = 0
        let keyboardOpen = false
        let orientation = window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'

        function update(confirmKeyboardOpen = false) {
            const iosStandalone = markIosStandalone(root)

            if (!viewport) {
                root.removeAttribute('data-app-keyboard-open')
                root.removeAttribute('data-ios-system-top-chrome')
                root.style.removeProperty('--app-viewport-height')
                return
            }

            const nextOrientation = window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape'
            if (nextOrientation !== orientation) {
                orientation = nextOrientation
                stableViewportHeight = 0
            }

            const layoutViewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight)
            const keyboardViewportState = getKeyboardViewportState({
                // `innerHeight` is still useful on browsers that retain the
                // layout viewport there; `clientHeight` covers iOS versions
                // where it follows visualViewport instead.
                layoutViewportHeight,
                visualViewportHeight: viewport.height,
                hasFocusedTextEntry: hasFocusedTextEntry(),
                stableViewportHeight,
                wasKeyboardOpen: keyboardOpen,
                confirmKeyboardOpen
            })
            stableViewportHeight = keyboardViewportState.stableViewportHeight
            keyboardOpen = keyboardViewportState.keyboardOpen

            // During a keyboard transition, visualViewport is deliberately
            // smaller than the layout viewport. Keep the prior top-chrome
            // result rather than mistaking that keyboard delta for an iOS
            // status-bar strip.
            const keyboardViewportActive = layoutViewportHeight - viewport.height > KEYBOARD_VIEWPORT_HEIGHT_DELTA_PX
            if (!iosStandalone) {
                root.removeAttribute('data-ios-system-top-chrome')
            } else if (!keyboardViewportActive && !keyboardOpen) {
                syncIosStandaloneSystemTopChrome(root, getIosStandaloneSystemTopChromeState({
                    isIosStandalone: true,
                    screenHeight: window.screen.height,
                    layoutViewportHeight,
                    visualViewportOffsetTop: viewport.offsetTop,
                    safeAreaTopInset: getBrowserSafeAreaTopInset(),
                    keyboardViewportActive
                }))
            }

            // Do not treat every visual-viewport difference as a keyboard. In
            // particular, installed iOS PWAs with viewport-fit=cover can report
            // visualViewport.height minus the bottom safe area after the
            // keyboard has closed. Require focused text entry and a keyboard-
            // sized delta before shrinking the app root.
            if (keyboardOpen) {
                root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
                // Keep the physical safe-area token immutable. The composer
                // alone switches to a zero bottom inset while the visual
                // viewport ends at the software keyboard. Reusing the same
                // token for both states made iOS launch/focus event ordering
                // visibly flip the composer between flush and safe-area modes.
                root.setAttribute('data-app-keyboard-open', 'true')
                // On an iOS PWA with viewport-fit=cover,
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
                root.removeAttribute('data-app-keyboard-open')
            }
        }

        const frameIds: number[] = []
        const timerIds: number[] = []
        const settle = () => {
            update()
            frameIds.push(window.requestAnimationFrame(() => update()))
            // Home Screen WebKit can update safe-area and viewport values one
            // turn after pageshow. A short second pass covers that launch race.
            timerIds.push(window.setTimeout(update, 150))
        }
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                settle()
            }
        }
        const handleOrientationChange = () => {
            stableViewportHeight = 0
            keyboardOpen = false
            settle()
        }
        const handleViewportResize = () => update(true)
        const handleViewportScroll = () => update()
        const handleFocusChange = () => update()

        viewport?.addEventListener('resize', handleViewportResize)
        viewport?.addEventListener('scroll', handleViewportScroll)
        document.addEventListener('focusin', handleFocusChange)
        document.addEventListener('focusout', handleFocusChange)
        window.addEventListener('pageshow', settle)
        window.addEventListener('orientationchange', handleOrientationChange)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        settle()

        return () => {
            viewport?.removeEventListener('resize', handleViewportResize)
            viewport?.removeEventListener('scroll', handleViewportScroll)
            document.removeEventListener('focusin', handleFocusChange)
            document.removeEventListener('focusout', handleFocusChange)
            window.removeEventListener('pageshow', settle)
            window.removeEventListener('orientationchange', handleOrientationChange)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
            frameIds.forEach((id) => window.cancelAnimationFrame(id))
            timerIds.forEach((id) => window.clearTimeout(id))
            root.style.removeProperty('--app-viewport-height')
            root.removeAttribute('data-app-keyboard-open')
            root.removeAttribute('data-ios-system-top-chrome')
        }
    }, [])
}
