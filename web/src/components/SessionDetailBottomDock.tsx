import { forwardRef, type CSSProperties, type ReactNode } from 'react'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'

/**
 * The vertical gap used by every detail-page accessory (queue, plan, or git
 * summary).  Keeping it next to the dock primitives prevents the native
 * Codex detail page from drifting away from the HAPI detail page.
 */
export const SESSION_DETAIL_BOTTOM_ACCESSORY_GAP_PX = 8

type BottomValue = CSSProperties['bottom']

export const SessionDetailBottomDock = forwardRef<HTMLDivElement, {
    children: ReactNode
    bottom?: BottomValue
    className?: string
    testId?: string
}>((props, ref) => (
    <div
        ref={ref}
        className={props.className ?? 'pointer-events-none absolute inset-x-0 z-10'}
        style={{ bottom: props.bottom ?? 0 }}
        data-testid={props.testId}
    >
        {props.children}
    </div>
))
SessionDetailBottomDock.displayName = 'SessionDetailBottomDock'

export const SessionDetailBottomDockComposer = forwardRef<HTMLDivElement, {
    children: ReactNode
    className?: string
    testId?: string
}>((props, ref) => (
    <div
        ref={ref}
        className={props.className ?? 'pointer-events-auto'}
        data-testid={props.testId}
    >
        {props.children}
    </div>
))
SessionDetailBottomDockComposer.displayName = 'SessionDetailBottomDockComposer'

export const SessionDetailBottomDockAccessory = forwardRef<HTMLDivElement, {
    children: ReactNode
    className?: string
    gapPx?: number
    testId?: string
    contractState?: string
}>((props, ref) => (
    <div
        ref={ref}
        className={props.className ?? 'pointer-events-none absolute inset-x-0'}
        style={{ bottom: `calc(100% + ${props.gapPx ?? SESSION_DETAIL_BOTTOM_ACCESSORY_GAP_PX}px)` }}
        data-testid={props.testId ?? MOBILE_LAYOUT_CONTRACT.bottomAccessory.testId}
        data-mobile-layout-contract={props.contractState ?? MOBILE_LAYOUT_CONTRACT.bottomAccessory.state}
    >
        {props.children}
    </div>
))
SessionDetailBottomDockAccessory.displayName = 'SessionDetailBottomDockAccessory'
