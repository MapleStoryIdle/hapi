import { ComposerPrimitive } from '@assistant-ui/react'
import type { PermissionMode, Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import type { ConversationStatus } from '@/realtime/types'
import { useTranslation } from '@/lib/use-translation'
import { ScheduleIcon } from '@/components/icons'
import { ScheduleTimePicker } from './ScheduleTimePicker'
import type { PendingSchedule } from './ScheduleTimePicker'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { RemoteServerContextMenuContent, ServerIcon, useRemoteServerContextSelection } from '@/components/RemoteServers'

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

function SpeakerIcon(props: { muted?: boolean }) {
    if (props.muted) {
        // Speaker with X (muted)
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
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
        )
    }

    // Speaker with sound waves
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
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
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

function PlanModeIcon() {
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

function GoalModeIcon() {
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

function StopIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
    )
}

function LoadingIcon() {
    return (
        <svg
            className="animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
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

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

function ToolbarMenu(props: {
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
    const [position, setPosition] = useState<{
        top: number
        left: number
        maxHeight: number
        arrowLeft: number
        enterY: string
        bounceY: string
        settleY: string
        transformOrigin: string
    } | null>(null)
    const [entered, setEntered] = useState(false)

    useLayoutEffect(() => {
        function measure() {
            const anchor = props.anchorRef.current
            if (!anchor) return
            const panel = panelRef.current
            const viewport = window.visualViewport
            const viewportLeft = viewport?.offsetLeft ?? 0
            const viewportTop = viewport?.offsetTop ?? 0
            const viewportWidth = viewport?.width ?? window.innerWidth
            const viewportHeight = viewport?.height ?? window.innerHeight
            const margin = 8
            const gap = 8
            const panelWidth = props.width ?? panel?.offsetWidth ?? 220
            const fullHeight = Math.min(panel?.scrollHeight ?? props.maxHeight ?? 260, props.maxHeight ?? 260)
            const rect = anchor.getBoundingClientRect()
            const minLeft = viewportLeft + margin
            const maxLeft = viewportLeft + viewportWidth - panelWidth - margin
            const preferredLeft = props.align === 'right' ? rect.right - panelWidth : rect.left
            const left = clamp(preferredLeft, minLeft, Math.max(minLeft, maxLeft))
            const aboveTop = rect.top - gap - fullHeight
            const belowTop = rect.bottom + gap
            const opensAbove = aboveTop >= viewportTop + margin
            const top = opensAbove
                ? aboveTop
                : clamp(belowTop, viewportTop + margin, viewportTop + viewportHeight - margin - fullHeight)
            const maxHeight = Math.max(120, Math.min(fullHeight, viewportTop + viewportHeight - margin - top))
            const arrowLeft = clamp(rect.left + rect.width / 2 - left - 6, 20, panelWidth - 20)
            setPosition({
                top,
                left,
                maxHeight,
                arrowLeft,
                enterY: opensAbove ? '8px' : '-8px',
                bounceY: opensAbove ? '-3px' : '3px',
                settleY: opensAbove ? '1px' : '-1px',
                transformOrigin: `${arrowLeft + 6}px ${opensAbove ? 'bottom' : 'top'}`
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
    }, [props.anchorRef, props.align, props.width, props.maxHeight])

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

    return (
        <div
            ref={panelRef}
            style={position
                ? {
                    position: 'fixed',
                    top: position.top,
                    left: position.left,
                    width: props.width ?? 220,
                    maxHeight: position.maxHeight,
                    transformOrigin: position.transformOrigin,
                    opacity: entered ? 1 : 0,
                    transform: entered ? 'translateY(0) scale(1)' : `translateY(${position.enterY}) scale(0.88)`,
                    willChange: 'opacity, transform',
                    '--hapi-menu-enter-y': position.enterY,
                    '--hapi-menu-bounce-y': position.bounceY,
                    '--hapi-menu-settle-y': position.settleY
                } as CSSProperties
                : { position: 'fixed', visibility: 'hidden', width: props.width ?? 220 }
            }
            className={
                props.surface === 'permission'
                    ? `pointer-events-auto z-50 overflow-visible ${entered ? 'animate-menu-pop' : ''}`
                    : `pointer-events-auto z-50 overflow-hidden rounded-xl border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-lg ${entered ? 'animate-menu-pop' : ''}`
            }
            onPointerDown={(event) => event.stopPropagation()}
        >
            {props.showArrow && position ? (
                <div
                    className="pointer-events-none absolute -bottom-1.5 h-3 w-3 rotate-45 border-b border-r border-[var(--app-divider)] bg-[var(--app-bg)]"
                    style={{ left: position.arrowLeft }}
                    aria-hidden="true"
                />
            ) : null}
            <div
                className={
                    props.surface === 'permission'
                        ? 'overflow-y-auto rounded-[26px] border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-[0_18px_48px_rgba(15,23,42,0.18)]'
                        : 'overflow-y-auto'
                }
                style={{ maxHeight: position?.maxHeight ?? props.maxHeight ?? 260 }}
            >
                {props.children}
            </div>
        </div>
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

function ContextUsageIndicator(props: {
    percentage: number | null | undefined
    label?: string
    details?: ContextUsageDetails | null
    active?: boolean
    buttonRef?: RefObject<HTMLButtonElement | null>
    onClick?: () => void
}) {
    if (props.percentage == null) return null

    const percentage = Math.min(100, Math.max(0, props.percentage))
    const radius = 6
    const circumference = 2 * Math.PI * radius
    const shade = Math.round(185 - percentage * 1.25)
    const progressColor = `rgb(${shade}, ${shade}, ${shade})`

    return (
        <button
            ref={props.buttonRef}
            type="button"
            className={`flex h-[42px] w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--app-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${
                props.active ? 'bg-[var(--app-bg)]' : ''
            }`}
            aria-label={props.label}
            title={props.label}
            aria-expanded={props.active ? true : false}
            onClick={props.onClick}
        >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r={radius} fill="none" stroke="rgb(229, 231, 235)" strokeWidth="2" />
                <circle
                    cx="8"
                    cy="8"
                    r={radius}
                    fill="none"
                    stroke={progressColor}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - percentage / 100)}
                    transform="rotate(-90 8 8)"
                />
            </svg>
        </button>
    )
}

function RemoteServerSelectedButton(props: {
    context: {
        api: ApiClient
        session: Session
        onChanged: () => void
    }
    buttonRef: RefObject<HTMLButtonElement | null>
    active: boolean
    controlsDisabled: boolean
    onClick: () => void
}) {
    const { selected } = useRemoteServerContextSelection(props.context.api, props.context.session)
    if (!selected) return null

    return (
        <button
            ref={props.buttonRef}
            type="button"
            aria-label={`远程服务器: ${selected.name}`}
            title={`远程服务器: ${selected.name}`}
            disabled={props.controlsDisabled}
            className={`flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                props.active
                    ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                    : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
            }`}
            onClick={props.onClick}
        >
            <ServerIcon className="h-[22px] w-[22px]" />
        </button>
    )
}

export function UnifiedButton(props: {
    canSend: boolean
    voiceStatus: ConversationStatus
    voiceEnabled: boolean
    controlsDisabled: boolean
    onSend: () => void
    onVoiceToggle: () => void
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

    const handleClick = () => {
        if (isVoiceActive) {
            props.onVoiceToggle() // Stop voice
        } else if (hasText) {
            props.onSend() // Send message (or scratchlist add — wrapper decides)
        }
    }

    let icon: ReactNode
    let className: string
    let ariaLabel: string

    if (isConnecting) {
        icon = <LoadingIcon />
        className = 'bg-black text-white'
        ariaLabel = t('voice.connecting')
    } else if (isConnected) {
        icon = <StopIcon />
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
    const isDisabled = props.controlsDisabled || (
        routesToScratchlist
            ? !hasText
            : !hasText && !isVoiceActive
    )

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={isDisabled}
            aria-label={ariaLabel}
            title={ariaLabel}
            className={`flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[22px] [&_svg]:w-[22px] ${className}`}
        >
            {icon}
        </button>
    )
}

export function ComposerButtons(props: {
    canSend: boolean
    controlsDisabled: boolean
    showSettingsButton: boolean
    onSettingsToggle: () => void
    settingsLabel?: string
    settingsModelLabel?: string
    settingsReasoningLabel?: string | null
    settingsOpen?: boolean
    contextUsagePercent?: number | null
    contextUsageLabel?: string
    contextUsageDetails?: ContextUsageDetails | null
    permissionMode?: PermissionMode
    permissionLabel?: string
    permissionModeOptions?: Array<{ mode: PermissionMode; label: string }>
    onPermissionModeChange?: (mode: PermissionMode) => void
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
    // The backend rejects scheduled-send + attachment combinations (the per-CLI
    // upload directory is torn down before a mature emit could read the files).
    // The composer must surface that constraint at UI time so the user never
    // builds a submission the hub will reject — see hub/web/routes/messages.ts.
    hasAttachments?: boolean
    // Pi-specific toolbar buttons
    piModelLabel?: string
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
    remoteServerContext?: {
        api: ApiClient
        session: Session
        onChanged: () => void
    }
    compact?: boolean
}) {
    const { t } = useTranslation()
    const isVoiceConnected = props.voiceStatus === 'connected'
    const [showSchedulePicker, setShowSchedulePicker] = useState(false)
    const [showToolsMenu, setShowToolsMenu] = useState(false)
    const [showPermissionMenu, setShowPermissionMenu] = useState(false)
    const [showRemoteServerMenu, setShowRemoteServerMenu] = useState(false)
    const [showContextUsageMenu, setShowContextUsageMenu] = useState(false)
    const [remoteServerAnchor, setRemoteServerAnchor] = useState<'tools' | 'button'>('tools')
    const toolsButtonRef = useRef<HTMLButtonElement>(null)
    const permissionButtonRef = useRef<HTMLButtonElement>(null)
    const remoteServerButtonRef = useRef<HTMLButtonElement>(null)
    const contextUsageButtonRef = useRef<HTMLButtonElement>(null)
    const hasRemoteServerContext = Boolean(props.remoteServerContext)

    const hasSchedule = props.pendingSchedule != null
    const hasAttachments = props.hasAttachments ?? false
    const showPermissionButton = Boolean(props.onPermissionModeChange && props.permissionModeOptions?.length)
    const permissionLabel = props.permissionLabel
        ?? props.permissionModeOptions?.find((option) => option.mode === props.permissionMode)?.label
        ?? props.permissionMode
        ?? t('misc.permissionMode')
    const toolMenuItemClass = 'flex w-full items-center gap-2 px-3 py-3 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:h-[22px] [&_svg]:w-[22px]'
    const routesToScratchlist = (props.scratchlistMode ?? false)
        && !hasAttachments
        && props.pendingSchedule == null
    const toolsMenuContent = (
        <div className="py-1">
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

            {(props.showPlanModeButton || props.showGoalModeButton) ? (
                <div className="my-1 h-px bg-[var(--app-divider)]" />
            ) : null}

            {hasRemoteServerContext ? (
                <button
                    type="button"
                    aria-label="远程服务器"
                    title="远程服务器"
                    disabled={props.controlsDisabled}
                    onClick={() => {
                        setShowToolsMenu(false)
                        setShowPermissionMenu(false)
                        setShowSchedulePicker(false)
                        setRemoteServerAnchor('tools')
                        setShowRemoteServerMenu(true)
                    }}
                    className={toolMenuItemClass}
                >
                    <ServerIcon className="h-[22px] w-[22px]" />
                    <span className="flex-1">远程服务器</span>
                </button>
            ) : null}

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

            {props.onSchedule ? (
                <button
                    type="button"
                    aria-label={t('composer.scheduleSend')}
                    title={t('composer.scheduleSend')}
                    disabled={props.controlsDisabled || hasAttachments}
                    onClick={() => {
                        setShowToolsMenu(false)
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
        </div>
    )

    if (props.compact) {
        return (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-between px-3">
                <button
                    ref={toolsButtonRef}
                    type="button"
                    aria-label={t('composer.moreTools')}
                    title={t('composer.moreTools')}
                    className="pointer-events-auto flex h-[42px] w-[42px] items-center justify-center rounded-full text-[var(--app-fg)]/80 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] [&_svg]:h-[22px] [&_svg]:w-[22px]"
                    onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                    }}
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setShowToolsMenu((open) => !open)
                        setShowPermissionMenu(false)
                        setShowSchedulePicker(false)
                        setShowRemoteServerMenu(false)
                        setShowContextUsageMenu(false)
                    }}
                >
                    <PlusIcon />
                </button>

                <div className="pointer-events-auto">
                    <UnifiedButton
                        canSend={props.canSend}
                        voiceStatus={props.voiceStatus}
                        voiceEnabled={props.voiceEnabled}
                        controlsDisabled={props.controlsDisabled}
                        onSend={props.onSend}
                        onVoiceToggle={props.onVoiceToggle}
                        routesToScratchlist={routesToScratchlist}
                    />
                </div>
                {showToolsMenu ? (
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

                {showRemoteServerMenu && props.remoteServerContext ? (
                    <ToolbarMenu
                        anchorRef={toolsButtonRef}
                        align="left"
                        width={300}
                        maxHeight={320}
                        onClose={() => setShowRemoteServerMenu(false)}
                    >
                        <RemoteServerContextMenuContent
                            api={props.remoteServerContext.api}
                            session={props.remoteServerContext.session}
                            onChanged={props.remoteServerContext.onChanged}
                            onClose={() => setShowRemoteServerMenu(false)}
                        />
                    </ToolbarMenu>
                ) : null}
            </div>
        )
    }

    return (
        <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
                <button
                    ref={toolsButtonRef}
                    type="button"
                    aria-label={t('composer.moreTools')}
                    title={t('composer.moreTools')}
                    className={`flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors [&_svg]:h-[22px] [&_svg]:w-[22px] ${
                        showToolsMenu
                            ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                            : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                    }`}
                    onPointerDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                    }}
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setShowToolsMenu((open) => !open)
                        setShowPermissionMenu(false)
                        setShowSchedulePicker(false)
                        setShowRemoteServerMenu(false)
                        setShowContextUsageMenu(false)
                    }}
                >
                    <PlusIcon />
                </button>

                {showPermissionButton ? (
                    <button
                        ref={permissionButtonRef}
                        type="button"
                        aria-label={`${t('misc.permissionMode')}: ${permissionLabel}`}
                        title={`${t('misc.permissionMode')}: ${permissionLabel}`}
                        disabled={props.controlsDisabled}
                        className={`flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[22px] [&_svg]:w-[22px] ${
                            showPermissionMenu
                                ? `bg-[var(--app-bg)] ${getPermissionToneClass(props.permissionMode)}`
                                : `${getPermissionToneClass(props.permissionMode)} hover:bg-[var(--app-bg)]`
                        }`}
                        onClick={() => {
                            setShowPermissionMenu((open) => !open)
                            setShowToolsMenu(false)
                            setShowSchedulePicker(false)
                            setShowRemoteServerMenu(false)
                            setShowContextUsageMenu(false)
                        }}
                    >
                        <PermissionModeIcon mode={props.permissionMode} />
                    </button>
                ) : null}

                {props.remoteServerContext ? (
                    <RemoteServerSelectedButton
                        context={props.remoteServerContext}
                        buttonRef={remoteServerButtonRef}
                        active={showRemoteServerMenu && remoteServerAnchor === 'button'}
                        controlsDisabled={props.controlsDisabled}
                        onClick={() => {
                            setRemoteServerAnchor('button')
                            setShowRemoteServerMenu((open) => !(open && remoteServerAnchor === 'button'))
                            setShowToolsMenu(false)
                            setShowPermissionMenu(false)
                            setShowSchedulePicker(false)
                            setShowContextUsageMenu(false)
                        }}
                    />
                ) : null}

                {showToolsMenu ? (
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

                {showPermissionMenu && props.permissionModeOptions ? (
                    <ToolbarMenu
                        anchorRef={permissionButtonRef}
                        align="left"
                        width={336}
                        maxHeight={360}
                        surface="permission"
                        showArrow
                        onClose={() => setShowPermissionMenu(false)}
                    >
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

                {props.piModelLabel ? (
                    <button
                        type="button"
                        aria-label={props.piModelLabel}
                        title={props.piModelLabel}
                        className={`flex h-[42px] items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors ${
                            props.piModelOpen
                                ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={props.onPiModelToggle}
                        disabled={props.piModelDisabled}
                    >
                        {props.piModelLabel}
                        <ChevronIcon />
                    </button>
                ) : null}

                {props.piThinkingLabel ? (
                    <button
                        type="button"
                        aria-label={props.piThinkingLabel}
                        title={props.piThinkingLabel}
                        className={`flex h-[42px] items-center gap-1.5 rounded-full px-4 text-sm font-medium transition-colors ${
                            props.piThinkingOpen
                                ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={props.onPiThinkingToggle}
                        disabled={props.piThinkingDisabled}
                    >
                        {props.piThinkingLabel}
                        <ChevronIcon />
                    </button>
                ) : null}

                {props.planModeActive && props.onPlanModeToggle ? (
                    <button
                        type="button"
                        aria-label={t('tool.exitPlan')}
                        title={t('tool.exitPlan')}
                        disabled={props.controlsDisabled}
                        className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-[#EAF2FF] text-[#1D4ED8] transition-colors hover:bg-[#DBEAFE] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[22px] [&_svg]:w-[22px]"
                        onClick={props.onPlanModeToggle}
                    >
                        <PlanModeIcon />
                    </button>
                ) : null}

                {props.showAbortButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.abort')}
                        title={t('composer.abort')}
                        disabled={props.abortDisabled}
                        className="flex h-[42px] w-[42px] items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[22px] [&_svg]:w-[22px]"
                        onClick={props.onAbort}
                    >
                        <AbortIcon spinning={props.isAborting} />
                    </button>
                ) : null}

                {props.showSwitchButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.switchRemote')}
                        title={t('composer.switchRemote')}
                        disabled={props.switchDisabled}
                        className="flex h-[42px] w-[42px] items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:h-[22px] [&_svg]:w-[22px]"
                        onClick={props.onSwitch}
                    >
                        <SwitchToRemoteIcon />
                    </button>
                ) : null}
            </div>

            <div className="flex items-center gap-1">
                <ContextUsageIndicator
                    percentage={props.contextUsagePercent}
                    label={props.contextUsageLabel}
                    details={props.contextUsageDetails}
                    active={showContextUsageMenu}
                    buttonRef={contextUsageButtonRef}
                    onClick={() => {
                        setShowContextUsageMenu((open) => !open)
                        setShowToolsMenu(false)
                        setShowPermissionMenu(false)
                        setShowSchedulePicker(false)
                        setShowRemoteServerMenu(false)
                    }}
                />

                {showContextUsageMenu ? (
                    <ToolbarMenu
                        anchorRef={contextUsageButtonRef}
                        align="right"
                        width={292}
                        maxHeight={280}
                        showArrow
                        onClose={() => setShowContextUsageMenu(false)}
                    >
                        <ContextUsagePanel details={props.contextUsageDetails ?? null} />
                    </ToolbarMenu>
                ) : null}

                {props.showSettingsButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.settings')}
                        title={t('composer.settings')}
                        className={`settings-button flex h-[42px] items-center gap-2 rounded-full px-3 text-base transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            props.settingsOpen
                                ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                                : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={() => {
                            setShowToolsMenu(false)
                            setShowPermissionMenu(false)
                            setShowSchedulePicker(false)
                            setShowRemoteServerMenu(false)
                            setShowContextUsageMenu(false)
                            props.onSettingsToggle()
                        }}
                        disabled={props.controlsDisabled}
                    >
                        {props.settingsModelLabel ? (
                            <>
                                <span className="whitespace-nowrap font-bold text-[var(--app-fg)]">{props.settingsModelLabel}</span>
                                {props.settingsReasoningLabel ? (
                                    <span className="whitespace-nowrap">{props.settingsReasoningLabel}</span>
                                ) : null}
                            </>
                        ) : (
                            <span className="whitespace-nowrap font-semibold">{props.settingsLabel ?? t('composer.settings')}</span>
                        )}
                        <ChevronIcon />
                    </button>
                ) : null}

                {showRemoteServerMenu && props.remoteServerContext ? (
                    <ToolbarMenu
                        anchorRef={remoteServerAnchor === 'button' ? remoteServerButtonRef : toolsButtonRef}
                        align="left"
                        width={300}
                        maxHeight={320}
                        onClose={() => setShowRemoteServerMenu(false)}
                    >
                        <RemoteServerContextMenuContent
                            api={props.remoteServerContext.api}
                            session={props.remoteServerContext.session}
                            onChanged={props.remoteServerContext.onChanged}
                            onClose={() => setShowRemoteServerMenu(false)}
                        />
                    </ToolbarMenu>
                ) : null}

                {isVoiceConnected && props.onVoiceMicToggle ? (
                    <button
                        type="button"
                        aria-label={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
                        title={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
                        className={`flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors [&_svg]:h-[22px] [&_svg]:w-[22px] ${
                            props.voiceMicMuted
                                ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                                : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={props.onVoiceMicToggle}
                    >
                        <SpeakerIcon muted={props.voiceMicMuted} />
                    </button>
                ) : null}

                <UnifiedButton
                    canSend={props.canSend}
                    voiceStatus={props.voiceStatus}
                    voiceEnabled={props.voiceEnabled}
                    controlsDisabled={props.controlsDisabled}
                    onSend={props.onSend}
                    onVoiceToggle={props.onVoiceToggle}
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
                    routesToScratchlist={
                        routesToScratchlist
                    }
                />
            </div>
        </div>
    )
}
