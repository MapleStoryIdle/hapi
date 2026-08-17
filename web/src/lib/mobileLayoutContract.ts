import type { CSSProperties } from 'react'

/**
 * Product-approved mobile layout invariants.
 *
 * The accompanying source guard (`bun run test:mobile-layout`) verifies that
 * the CSS variables below retain their approved values. Change this contract
 * only after explicit product approval and update the contract document and
 * regression checks in the same change.
 */
export const MOBILE_LAYOUT_CONTRACT = {
    header: {
        testId: 'mobile-layout-header-shell',
        state: 'transparent-no-blur',
        backgroundVariable: '--app-mobile-header-shell-background',
        backdropFilterVariable: '--app-mobile-header-shell-backdrop-filter',
        background: 'transparent',
        backdropFilter: 'none'
    },
    thread: {
        testId: 'mobile-layout-thread-root',
        state: 'scrolls-under-transparent-header',
        topSafeAreaVariable: '--app-safe-area-top'
    },
    bottomAccessory: {
        testId: 'mobile-layout-bottom-accessory',
        state: 'floating-above-composer'
    },
    composer: {
        keyboardOpenExpandedOffsetVariable: '--app-mobile-composer-expanded-keyboard-offset',
        keyboardOpenExpandedOffset: '4px'
    }
} as const

/**
 * Inline contract style deliberately wins over incidental utility classes.
 * The full-width header shell stays transparent while avoiding a backdrop filter.
 */
export const mobileLayoutHeaderShellStyle: CSSProperties = {
    backgroundColor: `var(${MOBILE_LAYOUT_CONTRACT.header.backgroundVariable})`,
    backdropFilter: `var(${MOBILE_LAYOUT_CONTRACT.header.backdropFilterVariable})`
}
