import { ComposerPrimitive } from '@assistant-ui/react'
import {
    Mic as MicIconNode,
    Square as SquareIconNode,
    Volume2 as Volume2IconNode,
    VolumeX as VolumeXIconNode,
} from 'lucide'
import { Filter, Lock as LockIcon, Puzzle, Search, Zap } from 'lucide-react'
import type { PermissionMode, SkillSummary } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import { useTranslation } from '@/lib/use-translation'
import { ScheduleIcon } from '@/components/icons'
import { MotionIcon, toMotionIcon } from '@/components/MotionIcon'
import { getProjectRecentSkills, markProjectSkillUsed } from '@/lib/recent-skills'
import { ScheduleTimePicker } from './ScheduleTimePicker'
import type { PendingSchedule } from './ScheduleTimePicker'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

function ChevronIcon() {
    return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 3.75L5 6.25L7.5 3.75" /></svg>
}

function PlusIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

function SwitchToRemoteIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
            <polyline points="7 9 10 12 7 15" />
            <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
    )
}

function AttachmentIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
        </svg>
    )
}

export function PlanModeIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
    )
}

export function GoalModeIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    )
}

function AbortIcon(props: { spinning: boolean }) {
    if (props.spinning) {
        return (
            <svg
                className="animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
            </svg>
        )
    }

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="currentColor"
        >
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4Z" />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function ScratchlistToggleIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3.5 2.5h6L12.5 5.5v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
            <path d="M9.5 2.5v3h3M5 8.5h6M5 11h4" />
        </svg>
    )
}

function PermissionHandIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-[18px] w-[18px]'}
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M10.25 4a.75.75 0 0 0-.75.75V10a1 1 0 1 1-2 0V6.75a.75.75 0 0 0-1.5 0V14a6 6 0 0 0 12 0V9.333A.333.333 0 0 0 17.667 9C16.747 9 16 9.746 16 10.667V12.5a1 1 0 0 1-.684.949l-.628.21A2.469 2.469 0 0 0 13 16a1 1 0 1 1-2 0 4.469 4.469 0 0 1 3-4.22v-1.113c0-.675.182-1.307.5-1.85V5.75a.75.75 0 0 0-1.5 0V9a1 1 0 1 1-2 0V4.75a.75.75 0 0 0-.75-.75Zm2.316-.733A2.75 2.75 0 0 1 16.5 5.75v1.44A3.66 3.66 0 0 1 17.667 7 2.333 2.333 0 0 1 20 9.333V14a8 8 0 1 1-16 0V6.75a2.75 2.75 0 0 1 3.571-2.625 2.751 2.751 0 0 1 4.995-.858Z"
            />
        </svg>
    )
}

function PermissionAutoReviewIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-[18px] w-[18px]'}
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M15.344 10.036a1 1 0 1 0-1.688-1.072l-2.474 3.896-.943-1.034a1 1 0 0 0-1.478 1.348l1.826 2a1 1 0 0 0 1.583-.138l3.174-5Z" />
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M13.203 1.935a3 3 0 0 0-2.405 0l-6 2.625A3 3 0 0 0 3 7.308V13a9 9 0 1 0 18 0V7.308a3 3 0 0 0-1.797-2.748l-6-2.625Zm-1.604 1.832a1 1 0 0 1 .802 0l6 2.625a1 1 0 0 1 .599.916V13a7 7 0 1 1-14 0V7.308a1 1 0 0 1 .6-.916l6-2.625Z"
            />
        </svg>
    )
}

function PermissionFullAccessIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-[18px] w-[18px]'}
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path d="M11 12C11 12.5523 11.4477 13 12 13C12.5523 13 13 12.5523 13 12V8C13 7.44772 12.5523 7 12 7C11.4477 7 11 7.44772 11 8V12Z" />
            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z" />
            <path d="M12 14.7C11.3649 14.7 10.85 15.2148 10.85 15.85C10.85 16.4851 11.3649 17 12 17C12.6351 17 13.15 16.4851 13.15 15.85C13.15 15.2148 12.6351 14.7 12 14.7Z" />
        </svg>
    )
}

function PermissionGearIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-[18px] w-[18px]'}
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M11.568 3.5a1 1 0 0 0-.863.494l-.811 1.381A3.001 3.001 0 0 1 7.33 6.856l-1.596.013a1 1 0 0 0-.858.501l-.439.761a1 1 0 0 0-.004.992l.792 1.4a3 3 0 0 1 0 2.954l-.792 1.4a1 1 0 0 0 .004.992l.439.76a1 1 0 0 0 .858.502l1.596.013a3 3 0 0 1 2.564 1.48l.811 1.382a1 1 0 0 0 .863.494h.87a1 1 0 0 0 .862-.494l.812-1.381a3.001 3.001 0 0 1 2.563-1.481l1.596-.013a1 1 0 0 0 .86-.501l.438-.761a1 1 0 0 0 .004-.992l-.793-1.4a3 3 0 0 1 0-2.954l.793-1.4a1 1 0 0 0-.004-.992l-.439-.76a1 1 0 0 0-.858-.502l-1.597-.013a3 3 0 0 1-2.563-1.48L13.3 3.993a1 1 0 0 0-.862-.494h-.87ZM8.98 2.981A3.001 3.001 0 0 1 11.568 1.5h.87c1.064 0 2.049.564 2.588 1.481l.811 1.382a1 1 0 0 0 .855.494l1.596.013a3 3 0 0 1 2.575 1.502l.44.76a3 3 0 0 1 .011 2.975l-.792 1.4a1 1 0 0 0 0 .985l.792 1.401a3 3 0 0 1-.012 2.974l-.439.761a3.001 3.001 0 0 1-2.575 1.503l-1.597.012a1 1 0 0 0-.854.494l-.811 1.382a3.001 3.001 0 0 1-2.588 1.481h-.87a3.001 3.001 0 0 1-2.588-1.481l-.811-1.382a1 1 0 0 0-.855-.494l-1.596-.012a3.001 3.001 0 0 1-2.576-1.503l-.438-.76a3 3 0 0 1-.013-2.975l.793-1.4a1 1 0 0 0 0-.985l-.793-1.4a3 3 0 0 1 .013-2.975l.438-.761A3.001 3.001 0 0 1 5.718 4.87l1.596-.013a1 1 0 0 0 .855-.494l.81-1.382Z"
            />
            <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12.003 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM8.502 12a3.5 3.5 0 1 1 7 .001 3.5 3.5 0 0 1-7-.001Z"
            />
        </svg>
    )
}

function PermissionCheckIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m5 12 4 4L19 6" />
        </svg>
    )
}

function PermissionModeIcon(props: { mode?: PermissionMode; className?: string }) {
    switch (props.mode) {
        case 'default':
        case 'ask':
            return <PermissionHandIcon className={props.className} />
        case 'plan':
            return <PlanModeIcon />
        case 'debug':
            return <PermissionGearIcon className={props.className} />
        case 'read-only':
        case 'acceptEdits':
            return <PermissionHandIcon className={props.className} />
        case 'safe-yolo':
        case 'auto':
            return <PermissionAutoReviewIcon className={props.className} />
        case 'yolo':
        case 'bypassPermissions':
            return <PermissionFullAccessIcon className={props.className} />
        default:
            return <PermissionGearIcon className={props.className} />
    }
}

function getPermissionToneClass(mode: PermissionMode | undefined): string {
    if (mode === 'safe-yolo') {
        return 'text-blue-500 dark:text-blue-400'
    }

    if (mode === 'yolo' || mode === 'bypassPermissions') {
        return 'text-orange-500 dark:text-orange-400'
    }

    return mode === 'default'
        ? 'text-black/55 dark:text-white/70'
        : 'text-black/62 dark:text-white/62'
}

function getPermissionCopy(mode: PermissionMode, fallbackLabel: string, t: ReturnType<typeof useTranslation>['t']) {
    switch (mode) {
        case 'default':
            return {
                title: t('permissionMode.default.title'),
                description: t('permissionMode.default.description')
            }
        case 'read-only':
            return {
                title: t('permissionMode.readOnly.title'),
                description: t('permissionMode.readOnly.description')
            }
        case 'safe-yolo':
            return {
                title: t('permissionMode.safeYolo.title'),
                description: t('permissionMode.safeYolo.description')
            }
        case 'yolo':
        case 'bypassPermissions':
            return {
                title: t('permissionMode.fullAccess.title'),
                description: t('permissionMode.fullAccess.description')
            }
        case 'acceptEdits':
            return {
                title: t('permissionMode.acceptEdits.title'),
                description: t('permissionMode.acceptEdits.description')
            }
        case 'auto':
            return {
                title: t('permissionMode.auto.title'),
                description: t('permissionMode.auto.description')
            }
        case 'plan':
            return {
                title: t('permissionMode.plan.title'),
                description: t('permissionMode.plan.description')
            }
        case 'ask':
            return {
                title: t('permissionMode.ask.title'),
                description: t('permissionMode.ask.description')
            }
        case 'debug':
            return {
                title: t('permissionMode.debug.title'),
                description: t('permissionMode.debug.description')
            }
        default:
            return {
                title: fallbackLabel,
                description: t('permissionMode.custom.description')
            }
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

type ToolbarMenuRect = Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width'>

export type ToolbarMenuViewport = {
    width: number
    height: number
    offsetTop?: number
    offsetLeft?: number
}

export type ToolbarMenuPlacement = {
    top: number
    left: number
    width: number
    maxHeight: number
    arrowLeft: number
    placement: 'above' | 'below' | 'viewport'
}

/**
 * Keep every composer menu inside the visual viewport. This matters while an
 * iOS keyboard is open: the layout viewport can remain tall, while only the
 * visual viewport is actually tappable.
 */
export function computeToolbarMenuPlacement(params: {
    anchor: ToolbarMenuRect
    panelWidth: number
    panelHeight: number
    viewport: ToolbarMenuViewport
    align?: 'left' | 'right'
    margin?: number
    gap?: number
}): ToolbarMenuPlacement {
    const margin = params.margin ?? 8
    const gap = params.gap ?? 8
    const viewportLeft = params.viewport.offsetLeft ?? 0
    const viewportTop = params.viewport.offsetTop ?? 0
    const viewportRight = viewportLeft + params.viewport.width
    const viewportBottom = viewportTop + params.viewport.height
    const availableWidth = Math.max(1, params.viewport.width - margin * 2)
    const width = Math.min(params.panelWidth, availableWidth)
    const minLeft = viewportLeft + margin
    const maxLeft = viewportRight - margin - width
    const preferredLeft = params.align === 'right'
        ? params.anchor.right - width
        : params.anchor.left
    const left = clamp(preferredLeft, minLeft, Math.max(minLeft, maxLeft))
    const spaceAbove = Math.max(0, params.anchor.top - gap - (viewportTop + margin))
    const spaceBelow = Math.max(0, viewportBottom - margin - (params.anchor.bottom + gap))
    const viewportMaxHeight = Math.max(0, params.viewport.height - margin * 2)
    const smallestUsableHeight = Math.min(params.panelHeight, Math.min(120, viewportMaxHeight))
    const largestAdjacentSpace = Math.max(spaceAbove, spaceBelow)
    const arrowLeft = clamp(
        params.anchor.left + params.anchor.width / 2 - left - 6,
        20,
        Math.max(20, width - 20)
    )

    // When the keyboard leaves too little room above or below its toolbar,
    // use the entire visible viewport instead of clipping a partially usable
    // menu behind the keyboard. It remains scrollable and every action stays
    // reachable without dismissing the keyboard.
    if (largestAdjacentSpace < smallestUsableHeight && viewportMaxHeight > largestAdjacentSpace) {
        const maxHeight = Math.min(params.panelHeight, viewportMaxHeight)
        return {
            top: viewportTop + margin + Math.max(0, (viewportMaxHeight - maxHeight) / 2),
            left,
            width,
            maxHeight,
            arrowLeft,
            placement: 'viewport'
        }
    }

    const placement = params.panelHeight <= spaceAbove
        || (params.panelHeight > spaceBelow && spaceAbove >= spaceBelow)
        ? 'above'
        : 'below'
    const maxHeight = Math.min(params.panelHeight, placement === 'above' ? spaceAbove : spaceBelow)

    return {
        top: placement === 'above'
            ? params.anchor.top - gap - maxHeight
            : params.anchor.bottom + gap,
        left,
        width,
        maxHeight,
        arrowLeft,
        placement
    }
}

export function ToolbarMenu(props: {
    anchorRef: RefObject<HTMLElement | null>
    align?: 'left' | 'right'
    width?: number
    maxHeight?: number
    surface?: 'default' | 'permission'
    showArrow?: boolean
    onClose: () => void
    children: ReactNode
}) {
    const panelRef = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<(ToolbarMenuPlacement & {
        enterY: string
        bounceY: string
        settleY: string
        transformOrigin: string
    }) | null>(null)
    const [entered, setEntered] = useState(false)

    useLayoutEffect(() => {
        function measure() {
            const anchor = props.anchorRef.current
            if (!anchor) return
            const panel = panelRef.current
            const viewport = window.visualViewport
            const panelWidth = props.width ?? panel?.offsetWidth ?? 220
            const fullHeight = Math.min(panel?.scrollHeight ?? props.maxHeight ?? 260, props.maxHeight ?? 260)
            const rect = anchor.getBoundingClientRect()
            const placement = computeToolbarMenuPlacement({
                anchor: rect,
                panelWidth,
                panelHeight: fullHeight,
                viewport: {
                    width: viewport?.width ?? window.innerWidth,
                    height: viewport?.height ?? window.innerHeight,
                    offsetLeft: viewport?.offsetLeft ?? 0,
                    offsetTop: viewport?.offsetTop ?? 0
                },
                align: props.align
            })
            const opensAbove = placement.placement === 'above'
            setPosition({
                ...placement,
                enterY: opensAbove ? '8px' : placement.placement === 'below' ? '-8px' : '4px',
                bounceY: opensAbove ? '-3px' : placement.placement === 'below' ? '3px' : '-2px',
                settleY: opensAbove ? '1px' : placement.placement === 'below' ? '-1px' : '0px',
                transformOrigin: placement.placement === 'viewport'
                    ? 'center center'
                    : `${placement.arrowLeft + 6}px ${opensAbove ? 'bottom' : 'top'}`
            })
        }

        measure()
        window.addEventListener('resize', measure, { passive: true })
        window.addEventListener('scroll', measure, { passive: true, capture: true })
        window.visualViewport?.addEventListener('resize', measure, { passive: true })
        window.visualViewport?.addEventListener('scroll', measure, { passive: true })
        return () => {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
            window.visualViewport?.removeEventListener('resize', measure)
            window.visualViewport?.removeEventListener('scroll', measure)
        }
    }, [props.anchorRef, props.align, props.width, props.maxHeight, props.children])

    const isPositioned = position !== null

    useEffect(() => {
        if (!isPositioned) {
            setEntered(false)
            return
        }

        setEntered(false)
        let firstFrame = 0
        let secondFrame = 0
        firstFrame = window.requestAnimationFrame(() => {
            secondFrame = window.requestAnimationFrame(() => setEntered(true))
        })
        return () => {
            window.cancelAnimationFrame(firstFrame)
            window.cancelAnimationFrame(secondFrame)
        }
    }, [isPositioned])

    useEffect(() => {
        function handlePointerDown(event: PointerEvent) {
            const target = event.target as Node
            if (panelRef.current?.contains(target)) return
            if (props.anchorRef.current?.contains(target)) return
            props.onClose()
        }
        document.addEventListener('pointerdown', handlePointerDown)
        return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [props.anchorRef, props.onClose])

    const menu = (
        <div
            ref={panelRef}
            data-testid="toolbar-menu"
            data-toolbar-menu-surface={props.surface ?? 'default'}
            style={position
                ? {
                    position: 'fixed',
                    top: position.top,
                    left: position.left,
                    width: position.width,
                    maxHeight: position.maxHeight,
                    transformOrigin: position.transformOrigin,
                    opacity: entered ? 1 : 0,
                    transform: entered ? 'translateY(0) scale(1)' : `translateY(${position.enterY}) scale(0.88)`,
                    willChange: 'opacity, transform',
                    '--hapi-menu-enter-y': position.enterY,
                    '--hapi-menu-bounce-y': position.bounceY,
                    '--hapi-menu-settle-y': position.settleY
                } as CSSProperties
                : {
                    position: 'fixed',
                    visibility: 'hidden',
                    width: props.width ?? 220,
                    maxWidth: 'calc(100vw - 16px)'
                }
            }
            className={
                props.surface === 'permission'
                    ? `pointer-events-auto z-50 overflow-visible ${entered ? 'animate-menu-pop' : ''}`
                    : `pointer-events-auto z-50 overflow-hidden rounded-xl border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-lg ${entered ? 'animate-menu-pop' : ''}`
            }
            onPointerDown={(event) => event.stopPropagation()}
        >
            {props.showArrow && position && position.placement !== 'viewport' ? (
                <div
                    className="pointer-events-none absolute -bottom-1.5 h-3 w-3 rotate-45 border-b border-r border-[var(--app-divider)] bg-[var(--app-bg)]"
                    style={{ left: position.arrowLeft }}
                    aria-hidden="true"
                />
            ) : null}
            <div
                data-toolbar-menu-scroll="true"
                className={
                    props.surface === 'permission'
                        ? 'overscroll-contain overflow-y-auto rounded-[26px] border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-[0_18px_48px_rgba(15,23,42,0.18)]'
                        : 'overscroll-contain overflow-y-auto'
                }
                style={{
                    maxHeight: position?.maxHeight ?? props.maxHeight ?? 260,
                    WebkitOverflowScrolling: 'touch'
                }}
            >
                {props.children}
            </div>
        </div>
    )

    // Composer rows use clipping for their expand/collapse animation. Portaling
    // keeps fixed menus out of that stacking context, so iOS can place them
    // against the keyboard-sized VisualViewport instead of the composer box.
    return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}

function ToolbarMenuSection(props: { title: string; children: ReactNode }) {
    return (
        <div className="py-1">
            <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.title}
            </div>
            {props.children}
        </div>
    )
}

function ContextUsageRingIcon() {
    return (
        <span
            className="h-[22px] w-[22px] rounded-full border-2 border-[var(--app-border)]"
            aria-hidden="true"
        />
    )
}

export type ContextUsageDetails = {
    usedTokens: number
    windowTokens: number | null
    cacheReadTokens?: number
    source: 'model' | 'estimated' | 'unknown'
    usedLabel: string
    remainingLabel: string | null
    windowLabel: string | null
    cacheReadLabel: string | null
    remainingPercent: number | null
}

function ContextUsagePanel(props: { details: ContextUsageDetails | null }) {
    const { t } = useTranslation()

    if (!props.details) {
        return (
            <div className="px-4 py-4 text-sm text-[var(--app-hint)]">
                {t('contextUsage.empty')}
            </div>
        )
    }

    const details = props.details
    const usedPercent = details.remainingPercent === null
        ? 0
        : Math.min(100, Math.max(0, 100 - details.remainingPercent))
    const windowCopy = details.source === 'model'
        ? t('contextUsage.modelWindow', { value: details.windowLabel ?? '-' })
        : details.source === 'estimated'
            ? t('contextUsage.estimatedWindow', { value: details.windowLabel ?? '-' })
            : t('contextUsage.unknownWindow')

    return (
        <div className="px-4 py-4">
            <div className="flex items-center justify-between gap-3">
                <div className="text-[15px] font-semibold text-[var(--app-fg)]">
                    {t('contextUsage.title')}
                </div>
                <div className="shrink-0 text-xs font-medium text-[var(--app-hint)]">
                    {windowCopy}
                </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
                <div>
                    <div className="text-[11px] font-medium text-[var(--app-hint)]">{t('contextUsage.used')}</div>
                    <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">{details.usedLabel}</div>
                </div>
                <div>
                    <div className="text-[11px] font-medium text-[var(--app-hint)]">{t('contextUsage.remaining')}</div>
                    <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">{details.remainingLabel ?? '-'}</div>
                </div>
                <div>
                    <div className="text-[11px] font-medium text-[var(--app-hint)]">{t('contextUsage.window')}</div>
                    <div className="mt-1 text-sm font-semibold text-[var(--app-fg)]">{details.windowLabel ?? '-'}</div>
                </div>
            </div>

            {details.remainingPercent !== null ? (
                <div className="mt-4">
                    <div className="h-2 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                        <div
                            className="h-full rounded-full bg-[rgb(88,88,88)]"
                            style={{ width: `${usedPercent}%` }}
                        />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-4 text-xs font-medium text-[var(--app-hint)]">
                        <div>
                            {details.cacheReadLabel ? t('contextUsage.cacheRead', { value: details.cacheReadLabel }) : null}
                        </div>
                        <div className="shrink-0">
                            {t('contextUsage.remainingPercent', { percent: Math.round(details.remainingPercent) })}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export function ContextUsageProgressRail(props: {
    percentage: number | null | undefined
    label?: string
    className?: string
}) {
    if (props.percentage == null) return null

    const percentage = Math.min(100, Math.max(0, props.percentage))
    const fillClass = percentage >= 90
        ? 'bg-red-500'
        : percentage >= 75
            ? 'bg-amber-500'
            : 'bg-[var(--app-hint)]'

    return (
        <div
            data-testid="composer-context-usage-rail"
            role="progressbar"
            aria-label={props.label ?? 'Context usage'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percentage)}
            aria-valuetext={props.label}
            className={`pointer-events-none absolute inset-x-3 bottom-0 z-20 h-[3px] overflow-hidden rounded-full bg-[var(--app-border)] ${props.className ?? ''}`}
        >
            <div
                className={`h-full rounded-full transition-[width,background-color] duration-300 ease-out motion-reduce:transition-none ${fillClass}`}
                style={{ width: `${percentage}%` }}
            />
        </div>
    )
}

type SkillPickerGroup = 'project' | 'user' | 'plugin' | 'system'
const LARK_SKILL_PREFIX = 'lark-'

function getSkillPickerGroup(skill: SkillSummary): SkillPickerGroup {
    switch (skill.scope) {
        case 'project':
        case 'user':
        case 'plugin':
        case 'system':
            return skill.scope
        case 'admin':
            return 'system'
        default:
            return 'user'
    }
}

function getSkillScopeLabel(
    skill: SkillSummary,
    t: ReturnType<typeof useTranslation>['t'],
): string {
    switch (skill.scope) {
        case 'project':
            return t('composer.skills.scope.project')
        case 'user':
            return t('composer.skills.scope.user')
        case 'plugin':
            return t('composer.skills.scope.plugin')
        case 'system':
            return t('composer.skills.scope.system')
        case 'admin':
            return t('composer.skills.scope.admin')
        default:
            return t('composer.skills.scope.user')
    }
}

export function UnifiedButton(props: {
    canSend: boolean
    voiceStatus: ConversationStatus
    voiceEnabled: boolean
    controlsDisabled: boolean
    /** Locked send affordance; the draft stays in the composer. */
    locked?: boolean
    onSend: () => void
    onVoiceToggle: () => void
    showAbortButton?: boolean
    abortDisabled?: boolean
    isAborting?: boolean
    onAbort?: () => void
    /**
     * When true, the send button repaints amber and the aria-label
     * announces "Send to scratchlist" instead of "Send message". The
     * actual routing happens in SessionChat's wrapped onSend - the
     * button itself is content-agnostic.
     *
     * Caller MUST compute this from the actual routing decision (mode
     * AND no-attachments AND no-pending-schedule), not the raw
     * scratchlist toggle. If the toggle is on but the submission would
     * fall back to chat (because the scratchlist can't represent the
     * payload), the button must look like a normal chat send. Per
     * upstream review on PR #798: [Major] "Send button advertises
     * scratchlist routing even when the submit will go to chat".
     */
    routesToScratchlist?: boolean
}) {
    const { t } = useTranslation()

    const isConnecting = props.voiceStatus === 'connecting'
    const isConnected = props.voiceStatus === 'connected'
    const isVoiceActive = isConnecting || isConnected
    const hasText = props.canSend
    const routesToScratchlist = props.routesToScratchlist ?? false
    // Preserve a drafted message while the session is running: sending the
    // draft takes precedence over aborting the current response. An empty
    // composer still exposes the abort control as before.
    const showAbort = Boolean(
        !props.locked
        &&
        props.showAbortButton
        && !hasText
        && (!(props.abortDisabled ?? false) || props.isAborting)
    )

    const handleClick = () => {
        if (props.locked) {
            return
        } else if (showAbort) {
            props.onAbort?.()
        } else if (isVoiceActive) {
            props.onVoiceToggle() // Stop voice
        } else if (hasText) {
            props.onSend() // Send message (or scratchlist add — wrapper decides)
        }
    }

    let icon: ReactNode
    let className: string
    let ariaLabel: string

    if (props.locked) {
        icon = <LockIcon data-testid="composer-send-lock" aria-hidden="true" />
        className = 'bg-[var(--app-hint)] text-white'
        ariaLabel = t('recentCodex.sshControl.sendLocked')
    } else if (showAbort) {
        icon = <AbortIcon spinning={props.isAborting ?? false} />
        className = `bg-red-600 text-white shadow-[0_0_0_3px_rgba(239,68,68,0.12)] hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-400${props.isAborting ? '' : ' animate-stop-button-breathe'}`
        ariaLabel = t('composer.abort')
    } else if (isConnecting) {
        icon = (
            <MotionIcon
                icon={toMotionIcon(MicIconNode)}
                className="h-[18px] w-[18px] motion-safe:animate-pulse"
                data-motion-icon="mic"
                aria-hidden="true"
            />
        )
        className = 'bg-black text-white'
        ariaLabel = t('voice.connecting')
    } else if (isConnected) {
        icon = (
            <MotionIcon
                icon={toMotionIcon(SquareIconNode)}
                className="h-[18px] w-[18px]"
                data-motion-icon="square"
                aria-hidden="true"
            />
        )
        className = 'bg-black text-white'
        ariaLabel = t('composer.stop')
    } else if (routesToScratchlist) {
        // Amber send button - matches the scratchlist drawer accent.
        // Single visual signal carries the "this goes to the scratchlist"
        // contract; without it, the modal state is invisible to the user.
        icon = <SendIcon />
        className = 'bg-amber-500 text-white hover:bg-amber-600'
        ariaLabel = t('scratchlist.sendToScratchlist')
    } else if (hasText) {
        icon = <SendIcon />
        className = 'bg-black text-white'
        ariaLabel = t('composer.send')
    } else {
        icon = <SendIcon />
        className = 'bg-[#C0C0C0] text-white'
        ariaLabel = t('composer.send')
    }

    // Voice launch is hidden from the composer for now. Empty input keeps
    // the regular disabled send affordance; connected voice sessions still
    // expose the stop state above so users can end an existing session.
    const isDisabled = props.locked || (showAbort
        ? (props.abortDisabled ?? false)
        : props.controlsDisabled || (
            routesToScratchlist
                ? !hasText
                : !hasText && !isVoiceActive
        ))

    return (
        <button
            type="button"
            // Do not cancel pointerdown here. iOS WebKit can then suppress the
            // compatibility mouse/click sequence. Mousedown still retains the
            // textarea focus while letting the button action fire.
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleClick}
            disabled={isDisabled}
            aria-label={ariaLabel}
            title={ariaLabel}
            className="flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
            <span className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors [&_svg]:h-[18px] [&_svg]:w-[18px] ${className}`}>
                {icon}
            </span>
        </button>
    )
}

const COMPOSER_TOOLBAR_HORIZONTAL_PADDING_PX = 16
const COMPOSER_TOOLBAR_GAP_PX = 4
const COMPOSER_ICON_BUTTON_WIDTH_PX = 42
const COMPOSER_OPTIONAL_CONTROL_SLOT_PX = COMPOSER_ICON_BUTTON_WIDTH_PX + COMPOSER_TOOLBAR_GAP_PX

export function getComposerOptionalControlsVisibility(
    toolbarWidth: number | null,
    requiredControlsWidth = 0,
    statusControlsWidth = 0,
    hasSkillControl = false,
    hasPermissionControl = true
): {
    permission: boolean
    skill?: boolean
} {
    // Unknown width happens before first layout/ResizeObserver tick; show by
    // default so wide toolbars do not flash as artificially collapsed.
    if (toolbarWidth === null) {
        return {
            permission: hasPermissionControl,
            ...(hasSkillControl ? { skill: true } : {})
        }
    }

    const requiredWidth = COMPOSER_TOOLBAR_HORIZONTAL_PADDING_PX
        + COMPOSER_ICON_BUTTON_WIDTH_PX
        + requiredControlsWidth
        + (COMPOSER_TOOLBAR_GAP_PX * 2)
        + statusControlsWidth
    const remainingWidth = toolbarWidth - requiredWidth
    let nextSlot = 1
    const hasSlotSpace = (slot: number) => remainingWidth >= COMPOSER_OPTIONAL_CONTROL_SLOT_PX * slot
    const permission = hasPermissionControl && hasSlotSpace(nextSlot)
    if (hasPermissionControl) {
        nextSlot += 1
    }
    const skill = hasSkillControl && hasSlotSpace(nextSlot)
    if (hasSkillControl) {
        nextSlot += 1
    }

    return {
        // Permission mode directly changes execution risk, so keep its icon in
        // the first optional slot. Skill follows it; context usage lives in
        // the bottom progress rail and remains detailed in the "+" menu.
        permission,
        ...(hasSkillControl ? { skill } : {})
    }
}

export function ComposerButtons(props: {
    canSend: boolean
    controlsDisabled: boolean
    locked?: boolean
    showSettingsButton: boolean
    onSettingsToggle: () => void
    settingsButtonRef?: RefObject<HTMLButtonElement | null>
    settingsLabel?: string
    settingsModelLabel?: string
    settingsReasoningLabel?: string | null
    fastModeActive?: boolean
    settingsOpen?: boolean
    /** Display the shared model control without allowing settings changes. */
    settingsReadOnly?: boolean
    contextUsageLabel?: string
    contextUsageDetails?: ContextUsageDetails | null
    permissionMode?: PermissionMode
    permissionLabel?: string
    permissionModeOptions?: Array<{ mode: PermissionMode; label: string }>
    onPermissionModeChange?: (mode: PermissionMode) => void
    skills?: SkillSummary[]
    skillsLoading?: boolean
    skillsError?: string | null
    onSkillSelect?: (skill: SkillSummary) => void
    projectPath?: string | null
    showPlanModeButton?: boolean
    planModeActive?: boolean
    onPlanModeToggle?: () => void
    showGoalModeButton?: boolean
    goalModeActive?: boolean
    onGoalModeOpen?: () => void
    showTerminalButton: boolean
    terminalDisabled: boolean
    terminalLabel: string
    onTerminal: () => void
    showAbortButton: boolean
    abortDisabled: boolean
    isAborting: boolean
    onAbort: () => void
    showSwitchButton: boolean
    switchDisabled: boolean
    isSwitching: boolean
    onSwitch: () => void
    voiceEnabled: boolean
    voiceStatus: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle: () => void
    onVoiceMicToggle?: () => void
    onSend: () => void
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    /** Hide the input-tools launcher when the transport is text-only. */
    showInputTools?: boolean
    // The backend rejects scheduled-send + attachment combinations (the per-CLI
    // upload directory is torn down before a mature emit could read the files).
    // The composer must surface that constraint at UI time so the user never
    // builds a submission the hub will reject — see hub/web/routes/messages.ts.
    hasAttachments?: boolean
    // Pi-specific toolbar buttons
    piModelLabel?: string
    piModelButtonRef?: RefObject<HTMLButtonElement | null>
    piModelDisabled?: boolean
    piModelOpen?: boolean
    onPiModelToggle?: () => void
    piThinkingLabel?: string
    piThinkingDisabled?: boolean
    piThinkingOpen?: boolean
    onPiThinkingToggle?: () => void
    // Scratchlist drawer toggle. When `onScratchlistToggle` is provided, a
    // notepad icon appears next to the schedule-send icon. Click toggles
    // composer-send-routing between chat and scratchlist; SessionChat owns
    // the actual routing decision via its wrapped onSend.
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
    compact?: boolean
}) {
    const { t } = useTranslation()
    const isVoiceConnected = props.voiceStatus === 'connected'
    const [showSchedulePicker, setShowSchedulePicker] = useState(false)
    const [showToolsMenu, setShowToolsMenu] = useState(false)
    const [showPermissionMenu, setShowPermissionMenu] = useState(false)
    const [showSkillMenu, setShowSkillMenu] = useState(false)
    const [showContextUsageMenu, setShowContextUsageMenu] = useState(false)
    const [skillQuery, setSkillQuery] = useState('')
    const [hideLarkSkills, setHideLarkSkills] = useState(true)
    const [recentSkillNames, setRecentSkillNames] = useState<string[]>(() => (
        getProjectRecentSkills(props.projectPath)
    ))
    const [permissionAnchor, setPermissionAnchor] = useState<'tools' | 'button'>('tools')
    const [skillAnchor, setSkillAnchor] = useState<'tools' | 'button'>('button')
    const [toolbarWidth, setToolbarWidth] = useState<number | null>(null)
    const [requiredControlsWidth, setRequiredControlsWidth] = useState(0)
    const [statusControlsWidth, setStatusControlsWidth] = useState(0)
    const toolbarRef = useRef<HTMLDivElement>(null)
    const requiredControlsRef = useRef<HTMLDivElement>(null)
    const statusControlsRef = useRef<HTMLDivElement>(null)
    const toolsButtonRef = useRef<HTMLButtonElement>(null)
    const permissionButtonRef = useRef<HTMLButtonElement>(null)
    const skillButtonRef = useRef<HTMLButtonElement>(null)

    const hasSchedule = props.pendingSchedule != null
    const hasAttachments = props.hasAttachments ?? false
    const showInputTools = props.showInputTools ?? true
    const scratchlistCount = props.scratchlistCount ?? 0
    const routesToScratchlist = (props.scratchlistMode ?? false)
        && !hasAttachments
        && props.pendingSchedule == null
    const showRunningStopButton = props.showAbortButton && (!props.abortDisabled || props.isAborting)
    const showScratchlistStatus = Boolean(props.onScratchlistToggle && (props.scratchlistMode || scratchlistCount > 0))
    const showScheduleStatus = Boolean(hasSchedule && props.onSchedule)
    const hasContextUsageControl = props.contextUsageDetails != null
    const skills = props.skills ?? []
    const hasSkillControl = Boolean(props.onSkillSelect && (skills.length > 0 || props.skillsLoading || props.skillsError))
    const showPermissionButton = Boolean(props.onPermissionModeChange && props.permissionModeOptions?.length)
    const optionalControlsVisibility = getComposerOptionalControlsVisibility(
        toolbarWidth,
        requiredControlsWidth,
        statusControlsWidth,
        hasSkillControl,
        showPermissionButton
    )
    const showInlinePermissionButton = showPermissionButton && optionalControlsVisibility.permission
    const showInlineSkillButton = hasSkillControl && optionalControlsVisibility.skill === true
    const permissionLabel = props.permissionLabel
        ?? props.permissionModeOptions?.find((option) => option.mode === props.permissionMode)?.label
        ?? props.permissionMode
        ?? t('misc.permissionMode')
    const toolMenuItemClass = 'flex w-full items-center gap-2 px-3 py-3 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:h-[22px] [&_svg]:w-[22px]'
    const showExecutionTools = Boolean(
        props.showPlanModeButton
        || props.showGoalModeButton
        || showPermissionButton
        || hasSkillControl
        || props.piThinkingLabel
    )
    const showSessionTools = Boolean(
        props.showTerminalButton
        || props.showSwitchButton
        || hasContextUsageControl
    )
    const showToolsLauncher = showInputTools || showExecutionTools || showSessionTools
    const openPermissionMenuFromTools = () => {
        setShowToolsMenu(false)
        setShowSkillMenu(false)
        setShowSchedulePicker(false)
        setShowContextUsageMenu(false)
        setPermissionAnchor('tools')
        setShowPermissionMenu(true)
    }
    const openSkillMenuFromTools = () => {
        setShowToolsMenu(false)
        setShowPermissionMenu(false)
        setShowSchedulePicker(false)
        setShowContextUsageMenu(false)
        setSkillAnchor('tools')
        setShowSkillMenu(true)
    }
    const openContextUsageFromTools = () => {
        setShowToolsMenu(false)
        setShowPermissionMenu(false)
        setShowSkillMenu(false)
        setShowSchedulePicker(false)
        setShowContextUsageMenu(true)
    }
    const toolsMenuContent = (
        <div className="py-1">
            {showInputTools ? (
                <ToolbarMenuSection title={t('composer.menu.input')}>
                    <ComposerPrimitive.AddAttachment
                        aria-label={t('composer.attach')}
                        title={t('composer.attach')}
                        disabled={props.controlsDisabled || hasSchedule}
                        onClick={() => setShowToolsMenu(false)}
                        className={toolMenuItemClass}
                    >
                        <AttachmentIcon />
                        <span className="flex-1">{t('composer.attach')}</span>
                    </ComposerPrimitive.AddAttachment>

                    {props.onSchedule ? (
                    <button
                        type="button"
                        aria-label={t('composer.scheduleSend')}
                        title={t('composer.scheduleSend')}
                        disabled={props.controlsDisabled || hasAttachments}
                            onClick={() => {
                                setShowToolsMenu(false)
                                setShowSkillMenu(false)
                                if (hasSchedule && props.onClearSchedule) {
                                    props.onClearSchedule()
                                    return
                            }
                            setShowSchedulePicker(true)
                        }}
                        className={toolMenuItemClass}
                    >
                        <ScheduleIcon className="h-[22px] w-[22px]" />
                        <span className="flex-1">{t('composer.scheduleSend')}</span>
                        {hasSchedule ? <span className="text-[var(--app-hint)]">✓</span> : null}
                    </button>
                    ) : null}

                    {props.onScratchlistToggle ? (
                    <button
                        type="button"
                        aria-label={t('scratchlist.toggleAriaLabel')}
                        title={t('scratchlist.toggleTooltip')}
                        aria-pressed={props.scratchlistMode ? true : false}
                        disabled={props.controlsDisabled}
                        onClick={() => {
                            setShowToolsMenu(false)
                            props.onScratchlistToggle?.()
                        }}
                        className={toolMenuItemClass}
                    >
                        <ScratchlistToggleIcon />
                        <span className="flex-1">{t('scratchlist.title')}</span>
                        {props.scratchlistMode ? <span className="text-amber-500">✓</span> : null}
                        {!props.scratchlistMode && (props.scratchlistCount ?? 0) > 0 ? (
                            <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                                {(props.scratchlistCount ?? 0) > 99 ? '99+' : props.scratchlistCount}
                            </span>
                        ) : null}
                    </button>
                    ) : null}
                </ToolbarMenuSection>
            ) : null}

            {showExecutionTools ? (
                <ToolbarMenuSection title={t('composer.menu.execution')}>
                    {props.showPlanModeButton && props.onPlanModeToggle ? (
                        <button
                            type="button"
                            aria-label={t('composer.planMode')}
                            title={t('composer.planMode')}
                            disabled={props.controlsDisabled}
                            onClick={() => {
                                setShowToolsMenu(false)
                                props.onPlanModeToggle?.()
                            }}
                            className={toolMenuItemClass}
                        >
                            <PlanModeIcon />
                            <span className="flex-1">{t('composer.planMode')}</span>
                            {props.planModeActive ? <span className="text-[var(--app-hint)]">✓</span> : null}
                        </button>
                    ) : null}

                    {props.showGoalModeButton && props.onGoalModeOpen ? (
                        <button
                            type="button"
                            aria-label={t('composer.goalMode')}
                            title={t('composer.goalMode')}
                            disabled={props.controlsDisabled}
                            onClick={() => {
                                setShowToolsMenu(false)
                                props.onGoalModeOpen?.()
                            }}
                            className={toolMenuItemClass}
                        >
                            <GoalModeIcon />
                            <span className="flex-1">{t('composer.goalMode')}</span>
                            {props.goalModeActive ? <span className="text-[var(--app-hint)]">✓</span> : null}
                        </button>
                    ) : null}

                    {showPermissionButton ? (
                        <button
                            type="button"
                            aria-label={`${t('misc.permissionMode')}: ${permissionLabel}`}
                            title={`${t('misc.permissionMode')}: ${permissionLabel}`}
                            disabled={props.controlsDisabled}
                            onClick={openPermissionMenuFromTools}
                            className={toolMenuItemClass}
                        >
                            <PermissionModeIcon mode={props.permissionMode} />
                            <span className="flex-1">{t('misc.permissionMode')}</span>
                            <span className="text-[var(--app-hint)]">{permissionLabel}</span>
                        </button>
                    ) : null}

                    {hasSkillControl && !showInlineSkillButton ? (
                        <button
                            type="button"
                            aria-label={t('composer.skills.title')}
                            title={t('composer.skills.title')}
                            disabled={props.controlsDisabled}
                            onClick={openSkillMenuFromTools}
                            className={toolMenuItemClass}
                        >
                            <Puzzle />
                            <span className="flex-1">{t('composer.skills.title')}</span>
                            {skills.length > 0 ? (
                                <span className="text-[var(--app-hint)]">{skills.length}</span>
                            ) : null}
                        </button>
                    ) : null}

                    {props.piThinkingLabel ? (
                        <button
                            type="button"
                            aria-label={props.piThinkingLabel}
                            title={props.piThinkingLabel}
                            disabled={props.piThinkingDisabled}
                            onClick={() => {
                                setShowToolsMenu(false)
                                props.onPiThinkingToggle?.()
                            }}
                            className={toolMenuItemClass}
                        >
                            <PermissionGearIcon className="h-[22px] w-[22px]" />
                            <span className="flex-1">{props.piThinkingLabel}</span>
                        </button>
                    ) : null}
                </ToolbarMenuSection>
            ) : null}

            {showSessionTools ? (
                <ToolbarMenuSection title={t('composer.menu.session')}>
                    {props.showTerminalButton ? (
                        <button
                            type="button"
                            aria-label={props.terminalLabel}
                            title={props.terminalLabel}
                            className={toolMenuItemClass}
                            onClick={() => {
                                setShowToolsMenu(false)
                                props.onTerminal()
                            }}
                            disabled={props.terminalDisabled}
                        >
                            <TerminalIcon />
                            <span className="flex-1">{props.terminalLabel}</span>
                        </button>
                    ) : null}

                    {props.showSwitchButton ? (
                        <button
                            type="button"
                            aria-label={t('composer.switchRemote')}
                            title={t('composer.switchRemote')}
                            disabled={props.switchDisabled}
                            className={toolMenuItemClass}
                            onClick={() => {
                                setShowToolsMenu(false)
                                props.onSwitch()
                            }}
                        >
                            <SwitchToRemoteIcon />
                            <span className="flex-1">{t('composer.switchRemote')}</span>
                        </button>
                    ) : null}

                    {hasContextUsageControl ? (
                        <button
                            type="button"
                            aria-label={props.contextUsageLabel ?? t('contextUsage.title')}
                            title={props.contextUsageLabel ?? t('contextUsage.title')}
                            className={toolMenuItemClass}
                            onClick={openContextUsageFromTools}
                        >
                            <ContextUsageRingIcon />
                            <span className="flex-1">{t('contextUsage.title')}</span>
                            {props.contextUsageDetails?.remainingLabel ? (
                                <span className="text-[var(--app-hint)]">{props.contextUsageDetails.remainingLabel}</span>
                            ) : null}
                        </button>
                    ) : null}
                </ToolbarMenuSection>
            ) : null}
        </div>
    )
    const permissionMenuContent = props.permissionModeOptions ? (
        <div className="py-2">
            {props.permissionModeOptions.map((option) => {
                const selected = option.mode === props.permissionMode
                const copy = getPermissionCopy(option.mode, option.label, t)
                return (
                    <button
                        key={option.mode}
                        type="button"
                        disabled={props.controlsDisabled}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-45"
                        onClick={() => {
                            props.onPermissionModeChange?.(option.mode)
                            setShowPermissionMenu(false)
                        }}
                    >
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center [&_svg]:h-[22px] [&_svg]:w-[22px] ${getPermissionToneClass(option.mode)}`}>
                            <PermissionModeIcon mode={option.mode} />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[15px] font-semibold leading-5 text-[var(--app-fg)]">
                                {copy.title}
                            </span>
                            <span className="mt-0.5 block text-xs leading-4 text-[var(--app-hint)]">
                                {copy.description}
                            </span>
                        </span>
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center text-[var(--app-fg)]">
                            {selected ? <PermissionCheckIcon className="h-5 w-5" /> : null}
                        </span>
                    </button>
                )
            })}
        </div>
    ) : null
    const filteredSkills = hideLarkSkills
        ? skills.filter((skill) => !skill.name.startsWith(LARK_SKILL_PREFIX))
        : skills
    const normalizedSkillQuery = skillQuery.trim().toLowerCase()
    const visibleSkills = filteredSkills
        .filter((skill) => {
            if (!normalizedSkillQuery) return true
            return skill.name.toLowerCase().includes(normalizedSkillQuery)
                || (skill.description ?? '').toLowerCase().includes(normalizedSkillQuery)
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    const skillSections = [
        { key: 'project', label: t('composer.skills.scope.project') },
        { key: 'user', label: t('composer.skills.scope.user') },
        { key: 'plugin', label: t('composer.skills.scope.plugin') },
        { key: 'system', label: t('composer.skills.scope.system') },
    ].map((section) => ({
        ...section,
        skills: visibleSkills.filter((skill) => getSkillPickerGroup(skill) === section.key),
    })).filter((section) => section.skills.length > 0)
    const recentSkills = normalizedSkillQuery
        ? []
        : recentSkillNames
            .map((name) => filteredSkills.find((skill) => skill.name === name))
            .filter((skill): skill is SkillSummary => skill != null)

    const renderSkillOption = (skill: SkillSummary, recent = false) => (
        <button
            key={`${recent ? 'recent:' : ''}${skill.scope ?? 'unknown'}:${skill.name}`}
            type="button"
            className={`group flex min-h-11 w-full gap-3 rounded-lg px-3 text-left transition-colors hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${
                recent ? 'items-center py-2' : 'items-start py-2.5'
            }`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
                setRecentSkillNames(markProjectSkillUsed(props.projectPath, skill.name))
                props.onSkillSelect?.(skill)
                setShowSkillMenu(false)
                setSkillQuery('')
            }}
        >
            <span className={`${recent ? '' : 'mt-0.5'} flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-[var(--app-link)]`}>
                <Puzzle className="h-[17px] w-[17px]" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--app-fg)]">
                        {skill.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                        {getSkillScopeLabel(skill, t)}
                    </span>
                </span>
                {!recent && skill.description ? (
                    <span className="mt-0.5 block truncate text-xs leading-4 text-[var(--app-hint)]">
                        {skill.description}
                    </span>
                ) : null}
            </span>
        </button>
    )

    const skillMenuContent = (
        <div className="py-3">
            <div className="flex items-center justify-between gap-3 px-4">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--app-fg)]">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500/10 text-[var(--app-link)]">
                        <Puzzle className="h-[18px] w-[18px]" />
                    </span>
                    <span>{t('composer.skills.title')}</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button
                        type="button"
                        aria-pressed={hideLarkSkills}
                        aria-label={hideLarkSkills ? t('composer.skills.filterLark.show') : t('composer.skills.filterLark.hide')}
                        title={hideLarkSkills ? t('composer.skills.filterLark.show') : t('composer.skills.filterLark.hide')}
                        className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${
                            hideLarkSkills
                                ? 'border-blue-200 bg-blue-50 text-[var(--app-link)] dark:border-blue-400/25 dark:bg-blue-500/15'
                                : 'border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        }`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => setHideLarkSkills((value) => !value)}
                    >
                        <Filter className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>

            <div className="px-3 pt-3">
                <label className="relative block">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-hint)]" />
                    <input
                        value={skillQuery}
                        autoFocus={typeof document === 'undefined'
                            || document.documentElement.dataset.appKeyboardOpen !== 'true'}
                        placeholder={t('composer.skills.search')}
                        className="h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] pl-9 pr-3 text-sm text-[var(--app-fg)] outline-none transition-colors placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)]"
                        onChange={(event) => setSkillQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                setShowSkillMenu(false)
                            }
                        }}
                    />
                </label>
            </div>

            <div className="mt-3 px-2">
                {props.skillsLoading ? (
                    <div className="px-3 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('composer.skills.loading')}
                    </div>
                ) : props.skillsError ? (
                    <div className="px-3 py-8 text-center text-sm text-red-500">
                        {props.skillsError}
                    </div>
                ) : skillSections.length === 0 ? (
                    <div className="px-3 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('composer.skills.noResults')}
                    </div>
                ) : (
                    <div className="space-y-3 pb-1">
                        {recentSkills.length > 0 ? (
                            <div data-testid="composer-recent-skills">
                                <div className="px-3 pb-1 text-[11px] font-medium text-[var(--app-hint)]">
                                    {t('composer.skills.recent')}
                                </div>
                                <div className="space-y-0.5">
                                    {recentSkills.map((skill) => renderSkillOption(skill, true))}
                                </div>
                                <div className="mx-3 mt-3 border-t border-[var(--app-divider)]" />
                            </div>
                        ) : null}
                        {skillSections.map((section) => (
                            <div key={section.key}>
                                <div className="px-3 pb-1 text-[11px] font-medium text-[var(--app-hint)]">
                                    {section.label}
                                </div>
                                <div className="space-y-0.5">
                                    {section.skills.map((skill) => renderSkillOption(skill))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
    const scratchlistStatusLabel = props.scratchlistMode
        ? t('scratchlist.title')
        : t(scratchlistCount === 1 ? 'scratchlist.count.one' : 'scratchlist.count.other', { n: scratchlistCount })

    useLayoutEffect(() => {
        const toolbar = toolbarRef.current
        if (!toolbar) return

        const measure = () => {
            const width = Math.round(toolbar.getBoundingClientRect().width)
            setToolbarWidth(width > 0 ? width : null)
            const requiredControls = requiredControlsRef.current
            const requiredWidth = requiredControls
                ? Math.ceil(requiredControls.getBoundingClientRect().width)
                : 0
            setRequiredControlsWidth(requiredWidth)
            const statusControls = statusControlsRef.current
            const statusWidth = statusControls
                ? Math.ceil(statusControls.getBoundingClientRect().width)
                : 0
            setStatusControlsWidth(statusWidth)
        }

        measure()

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure, { passive: true })
            return () => window.removeEventListener('resize', measure)
        }

        const observer = new ResizeObserver(measure)
        observer.observe(toolbar)
        if (requiredControlsRef.current) {
            observer.observe(requiredControlsRef.current)
        }
        if (statusControlsRef.current) {
            observer.observe(statusControlsRef.current)
        }
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        setRecentSkillNames(getProjectRecentSkills(props.projectPath))
    }, [props.projectPath])

    if (props.compact) {
        return (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-between px-3">
                {showToolsLauncher ? (
                <button
                    ref={toolsButtonRef}
                    type="button"
                    aria-label={t('composer.moreTools')}
                    title={t('composer.moreTools')}
                    className="pointer-events-auto flex h-[42px] w-[42px] items-center justify-center rounded-full text-[var(--app-fg)]/80 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] [&_svg]:h-[22px] [&_svg]:w-[22px]"
                    onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                    }}
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setShowToolsMenu((open) => !open)
                        setShowPermissionMenu(false)
                        setShowSkillMenu(false)
                        setShowSchedulePicker(false)
                        setShowContextUsageMenu(false)
                    }}
                >
                    <PlusIcon />
                </button>
                ) : null}

                <div className="pointer-events-auto">
                    <UnifiedButton
                        canSend={props.canSend}
                        voiceStatus={props.voiceStatus}
                        voiceEnabled={props.voiceEnabled}
                        controlsDisabled={props.controlsDisabled}
                        locked={props.locked}
                        onSend={props.onSend}
                        onVoiceToggle={props.onVoiceToggle}
                        showAbortButton={showRunningStopButton}
                        abortDisabled={props.abortDisabled}
                        isAborting={props.isAborting}
                        onAbort={props.onAbort}
                        routesToScratchlist={routesToScratchlist}
                    />
                </div>
                {showToolsLauncher && showToolsMenu ? (
                    <ToolbarMenu
                        anchorRef={toolsButtonRef}
                        align="left"
                        width={220}
                        maxHeight={280}
                        onClose={() => setShowToolsMenu(false)}
                    >
                        {toolsMenuContent}
                    </ToolbarMenu>
                ) : null}

                {showSchedulePicker && props.onSchedule ? (
                    <ScheduleTimePicker
                        anchorRef={toolsButtonRef}
                        onSchedule={(pending) => {
                            props.onSchedule!(pending)
                            setShowSchedulePicker(false)
                        }}
                        onClose={() => setShowSchedulePicker(false)}
                        pendingSchedule={props.pendingSchedule}
                    />
                ) : null}

                {showPermissionMenu && permissionMenuContent ? (
                    <ToolbarMenu
                        anchorRef={toolsButtonRef}
                        align="left"
                        width={336}
                        maxHeight={360}
                        surface="permission"
                        showArrow
                        onClose={() => setShowPermissionMenu(false)}
                    >
                        {permissionMenuContent}
                    </ToolbarMenu>
                ) : null}

                {showSkillMenu ? (
                    <ToolbarMenu
                        anchorRef={toolsButtonRef}
                        align="left"
                        width={340}
                        maxHeight={430}
                        showArrow
                        onClose={() => setShowSkillMenu(false)}
                    >
                        {skillMenuContent}
                    </ToolbarMenu>
                ) : null}

                {showContextUsageMenu ? (
                    <ToolbarMenu
                        anchorRef={toolsButtonRef}
                        align="left"
                        width={292}
                        maxHeight={280}
                        showArrow
                        onClose={() => setShowContextUsageMenu(false)}
                    >
                        <ContextUsagePanel details={props.contextUsageDetails ?? null} />
                    </ToolbarMenu>
                ) : null}
            </div>
        )
    }

    return (
        <div ref={toolbarRef} className="flex flex-nowrap items-center gap-0.5 pb-2 pl-1 pr-2">
            {showToolsLauncher ? (
            <button
                ref={toolsButtonRef}
                type="button"
                aria-label={t('composer.moreTools')}
                title={t('composer.moreTools')}
                className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full transition-colors [&_svg]:h-[22px] [&_svg]:w-[22px] ${
                    showToolsMenu
                        ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                        : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                }`}
                onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                }}
                onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setShowToolsMenu((open) => !open)
                    setShowPermissionMenu(false)
                    setShowSkillMenu(false)
                    setShowSchedulePicker(false)
                    setShowContextUsageMenu(false)
                }}
            >
                <PlusIcon />
            </button>
            ) : null}

            {showInlinePermissionButton ? (
                <button
                    ref={permissionButtonRef}
                    type="button"
                    aria-label={`${t('misc.permissionMode')}: ${permissionLabel}`}
                    title={`${t('misc.permissionMode')}: ${permissionLabel}`}
                    disabled={props.controlsDisabled}
                    className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[25px] [&_svg]:w-[25px] ${
                        showPermissionMenu && permissionAnchor === 'button'
                            ? `bg-[var(--app-bg)] ${getPermissionToneClass(props.permissionMode)}`
                            : `${getPermissionToneClass(props.permissionMode)} hover:bg-[var(--app-bg)]`
                    }`}
                    onClick={() => {
                        setPermissionAnchor('button')
                        setShowPermissionMenu((open) => !(open && permissionAnchor === 'button'))
                        setShowToolsMenu(false)
                        setShowSkillMenu(false)
                        setShowSchedulePicker(false)
                        setShowContextUsageMenu(false)
                    }}
                >
                    <PermissionModeIcon mode={props.permissionMode} />
                </button>
            ) : null}

            {showInlineSkillButton ? (
                <button
                    ref={skillButtonRef}
                    type="button"
                    aria-label={t('composer.skills.title')}
                    title={t('composer.skills.title')}
                    disabled={props.controlsDisabled}
                    className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[22px] [&_svg]:w-[22px] ${
                        showSkillMenu && skillAnchor === 'button'
                            ? 'bg-[var(--app-bg)] text-[var(--app-link)]'
                            : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-link)]'
                    }`}
                    onClick={() => {
                        setSkillAnchor('button')
                        setShowSkillMenu((open) => !(open && skillAnchor === 'button'))
                        setShowToolsMenu(false)
                        setShowPermissionMenu(false)
                        setShowSchedulePicker(false)
                        setShowContextUsageMenu(false)
                    }}
                >
                    <Puzzle />
                </button>
            ) : null}

            <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div ref={statusControlsRef} className="flex w-max items-center gap-1">
                    {showScheduleStatus ? (
                        <button
                            type="button"
                            aria-label={t('composer.scheduleSend')}
                            title={t('composer.scheduleSend')}
                            disabled={props.controlsDisabled || hasAttachments}
                            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2.5 text-xs font-medium text-[var(--app-fg)]/75 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4"
                            onClick={() => {
                                setShowSkillMenu(false)
                                setShowSchedulePicker(true)
                            }}
                        >
                            <ScheduleIcon />
                            <span>{t('composer.scheduleSend')}</span>
                        </button>
                    ) : null}

                    {showScratchlistStatus ? (
                        <button
                            type="button"
                            aria-label={t('scratchlist.toggleAriaLabel')}
                            title={t('scratchlist.toggleTooltip')}
                            aria-pressed={props.scratchlistMode ? true : false}
                            disabled={props.controlsDisabled}
                            className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-amber-300/65 bg-amber-500/10 px-2.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-400/35 dark:text-amber-300 [&_svg]:h-4 [&_svg]:w-4"
                            onClick={props.onScratchlistToggle}
                        >
                            <ScratchlistToggleIcon />
                            <span>{scratchlistStatusLabel}</span>
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
                <div ref={requiredControlsRef} className="flex shrink-0 items-center gap-0.5">
                    {props.piModelLabel ? (
                        <button
                            ref={props.piModelButtonRef}
                            type="button"
                            aria-label={props.piModelLabel}
                            title={props.piModelLabel}
                            className={`flex h-[42px] max-w-[42vw] shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-none ${
                                props.piModelOpen
                                    ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                    : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                            }`}
                            onClick={props.onPiModelToggle}
                            disabled={props.piModelDisabled}
                        >
                            <span className="min-w-0 truncate">{props.piModelLabel}</span>
                            <ChevronIcon />
                        </button>
                    ) : null}

                    {props.showSettingsButton ? (
                        <button
                            ref={props.settingsButtonRef}
                            type="button"
                            data-testid={props.settingsReadOnly ? 'composer-model-info' : undefined}
                            aria-label={props.settingsReadOnly ? t('composer.modelReadOnly', { model: props.settingsLabel ?? t('misc.model') }) : t('composer.settings')}
                            title={props.settingsReadOnly ? t('composer.modelReadOnly', { model: props.settingsLabel ?? t('misc.model') }) : t('composer.settings')}
                            className={`settings-button flex h-[42px] max-w-[46vw] shrink-0 items-center gap-2 rounded-full px-3 text-base transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-none ${
                                props.settingsOpen
                                    ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                                    : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                            }`}
                            onClick={() => {
                                setShowToolsMenu(false)
                                setShowPermissionMenu(false)
                                setShowSkillMenu(false)
                                setShowSchedulePicker(false)
                                setShowContextUsageMenu(false)
                                props.onSettingsToggle()
                            }}
                            disabled={props.controlsDisabled || props.settingsReadOnly}
                        >
                            {props.fastModeActive ? (
                                <Zap
                                    aria-hidden="true"
                                    data-testid="composer-fast-mode-icon"
                                    className="h-4 w-4 shrink-0 text-[#34C759]"
                                    strokeWidth={2.4}
                                />
                            ) : null}
                            {props.settingsModelLabel ? (
                                <>
                                    <span className="min-w-0 truncate font-bold text-[var(--app-fg)]">{props.settingsModelLabel}</span>
                                    {props.settingsReasoningLabel ? (
                                        <span className="whitespace-nowrap">{props.settingsReasoningLabel}</span>
                                    ) : null}
                                </>
                            ) : (
                                <span className="min-w-0 truncate font-semibold">{props.settingsLabel ?? t('composer.settings')}</span>
                            )}
                            <ChevronIcon />
                        </button>
                    ) : null}

                    {isVoiceConnected && props.onVoiceMicToggle ? (
                        <button
                            type="button"
                            aria-label={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
                            title={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
                            className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full transition-colors [&_svg]:h-[22px] [&_svg]:w-[22px] ${
                                props.voiceMicMuted
                                    ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                                    : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                            }`}
                            onClick={props.onVoiceMicToggle}
                        >
                            <MotionIcon
                                icon={toMotionIcon(props.voiceMicMuted ? VolumeXIconNode : Volume2IconNode)}
                                className="h-[22px] w-[22px]"
                                data-motion-icon={props.voiceMicMuted ? 'volume-x' : 'volume-2'}
                                aria-hidden="true"
                            />
                        </button>
                    ) : null}

                    <UnifiedButton
                        canSend={props.canSend}
                        voiceStatus={props.voiceStatus}
                        voiceEnabled={props.voiceEnabled}
                        controlsDisabled={props.controlsDisabled}
                        locked={props.locked}
                        onSend={props.onSend}
                        onVoiceToggle={props.onVoiceToggle}
                        showAbortButton={showRunningStopButton}
                        abortDisabled={props.abortDisabled}
                        isAborting={props.isAborting}
                        onAbort={props.onAbort}
                        /*
                         * Derived, NOT raw scratchlistMode. Mirror SessionChat's
                         * shouldRouteToScratchlist so the visible send-button state
                         * matches the actual routing decision: amber + "Send to
                         * scratchlist" only when mode is on AND the payload would
                         * be a pure-text scratchlist add. Attachments or a pending
                         * schedule force a chat fallback in onSendForComposer; the
                         * button must reflect that, otherwise the UI lies about
                         * where the user's content is going.
                         */
                        routesToScratchlist={routesToScratchlist}
                    />
                </div>
            </div>

            {showToolsLauncher && showToolsMenu ? (
                <ToolbarMenu
                    anchorRef={toolsButtonRef}
                    align="left"
                    width={240}
                    maxHeight={360}
                    onClose={() => setShowToolsMenu(false)}
                >
                    {toolsMenuContent}
                </ToolbarMenu>
            ) : null}

            {showPermissionMenu && permissionMenuContent ? (
                <ToolbarMenu
                    anchorRef={permissionAnchor === 'button' && showInlinePermissionButton ? permissionButtonRef : toolsButtonRef}
                    align="left"
                    width={336}
                    maxHeight={360}
                    surface="permission"
                    showArrow
                    onClose={() => setShowPermissionMenu(false)}
                >
                    {permissionMenuContent}
                </ToolbarMenu>
            ) : null}

            {showSkillMenu ? (
                <ToolbarMenu
                    anchorRef={skillAnchor === 'button' && showInlineSkillButton ? skillButtonRef : toolsButtonRef}
                    align="left"
                    width={340}
                    maxHeight={430}
                    showArrow
                    onClose={() => setShowSkillMenu(false)}
                >
                    {skillMenuContent}
                </ToolbarMenu>
            ) : null}

            {showSchedulePicker && props.onSchedule ? (
                <ScheduleTimePicker
                    anchorRef={toolsButtonRef}
                    onSchedule={(pending) => {
                        props.onSchedule!(pending)
                        setShowSchedulePicker(false)
                    }}
                    onClose={() => setShowSchedulePicker(false)}
                    pendingSchedule={props.pendingSchedule}
                />
            ) : null}

            {showContextUsageMenu ? (
                <ToolbarMenu
                    anchorRef={toolsButtonRef}
                    align="left"
                    width={292}
                    maxHeight={280}
                    showArrow
                    onClose={() => setShowContextUsageMenu(false)}
                >
                    <ContextUsagePanel details={props.contextUsageDetails ?? null} />
                </ToolbarMenu>
            ) : null}
        </div>
    )
}
