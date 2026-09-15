import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { HappyChatProvider, type HappyChatFileLinkTarget } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import {
    closeAutoExpandedToolGroups,
    type ToolGroupExpansionState,
    type ToolGroupExpansionStates
} from '@/components/ToolCard/toolGroupExpansion'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'
import { ArrowDownIcon, CloseIcon } from '@/components/icons'
import { SessionDetailStatusNotice } from '@/components/SessionDetailStatusNotice'

type ScrollAnchor = {
    id: string
    topOffset?: number
    bottomOffset?: number
    element?: HTMLElement
}

type PendingScrollRestore = {
    anchor: ScrollAnchor | null
    scrollTop: number
    scrollHeight: number
    restored: boolean
    direction: 'older' | 'newer'
}

type PendingLoadBaseline = {
    messagesVersion: number
    sourceMessagesVersion: number
    hasMoreMessages: boolean
    hasNewerMessages: boolean
}

const MESSAGE_ANCHOR_SELECTOR = '.happy-thread-messages > [id]'
const MANUAL_SCROLL_EPSILON_PX = 1
const INITIAL_SCROLL_SETTLE_MS = 1800
const INITIAL_SCROLL_SETTLE_DELAYS_MS = [0, 16, 50, 120, 250, 500, 900, 1400, 1800] as const
const TOP_LOAD_SCROLL_EDGE_PX = 2
const TOP_LOAD_WHEEL_DELTA_EPSILON_PX = 0.5
const PULL_TO_LOAD_OLDER_THRESHOLD_PX = 72
const PULL_TO_LOAD_OLDER_MAX_OFFSET_PX = 48
const PULL_TO_LOAD_OLDER_LOADING_OFFSET_PX = 34
const MANUAL_SCROLL_INTENT_WINDOW_MS = 250
const PAGINATION_RENDER_SETTLE_MS = 200
const PAGINATION_SCROLL_STABILIZE_MS = 400
const PAGINATION_RESTORED_NOTICE_MS = 1800

export type PullToLoadOlderPhase = 'idle' | 'pulling' | 'ready' | 'loading'

type PullToLoadOlderIndicatorState = {
    phase: PullToLoadOlderPhase
    progress: number
    offset: number
}

type PullToLoadOlderGestureState = {
    touchId: number | null
    startY: number
    active: boolean
}

type ScrollIntent = {
    distanceFromBottom: number
    isAtBottom: boolean
    isScrollingUp: boolean
}

type LocateOutlineTargetOptions = {
    targetMessageId: string
    findTarget: (anchorId: string) => HTMLElement | null
    hasMoreMessages: () => boolean
    loadOlderPreservingScroll: () => Promise<boolean>
}

export function getScrollIntent(params: {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
    previousScrollTop: number
}): ScrollIntent {
    const distanceFromBottom = params.scrollHeight - params.scrollTop - params.clientHeight
    return {
        distanceFromBottom,
        isAtBottom: distanceFromBottom <= MANUAL_SCROLL_EPSILON_PX,
        isScrollingUp: params.scrollTop < params.previousScrollTop - MANUAL_SCROLL_EPSILON_PX
    }
}

export function shouldCancelInitialScrollSettling(intent: ScrollIntent): boolean {
    return intent.isScrollingUp && intent.distanceFromBottom > MANUAL_SCROLL_EPSILON_PX
}

export function shouldCancelLatestMessageFollow(params: {
    followingLatest: boolean
    isAtBottom: boolean
    isScrollingUp: boolean
    userInitiated: boolean
}): boolean {
    return params.followingLatest
        && params.userInitiated
        && params.isScrollingUp
        && !params.isAtBottom
}

export function shouldEnableTopSentinelAutoLoad(matchMedia: ((query: string) => MediaQueryList) | undefined): boolean {
    if (!matchMedia) {
        return true
    }
    return matchMedia('(any-hover: hover) and (any-pointer: fine)').matches
}

/**
 * Keep the initial messages below the transparent title controls, while
 * leaving the viewport edge-to-edge. Once the user scrolls, messages may pass
 * under the transparent shell exactly as the visual design intends.
 *
 * The bottom remains measured from the independent composer overlay. That
 * padding is the single endpoint reservation which keeps the newest message
 * and in-progress agent block above the input capsule.
 */
export function getThreadContentPadding(props: {
    topInset?: number
    bottomInset?: number
    bottomSafeAreaInset?: boolean
}): Pick<CSSProperties, 'paddingTop' | 'paddingBottom'> {
    return {
        paddingTop: props.topInset !== undefined
            ? `calc(var(${MOBILE_LAYOUT_CONTRACT.thread.topSafeAreaVariable}) + ${props.topInset}px)`
            : undefined,
        paddingBottom: props.bottomInset
            ? props.bottomSafeAreaInset
                ? `calc(${props.bottomInset + 12}px + var(--app-safe-area-bottom))`
                : `${props.bottomInset + 12}px`
            : undefined
    }
}

export function shouldFollowBottomInsetChange(params: {
    autoScrollEnabled: boolean
    atBottom: boolean
    restoringScroll: boolean
}): boolean {
    return params.autoScrollEnabled && params.atBottom && !params.restoringScroll
}

/** Keep the pagination anchor until deferred history has reached the DOM. */
export function shouldWaitForDeferredHistoryRender(params: {
    hasPendingRestore: boolean
    baselineSourceMessagesVersion: number | null
    sourceMessagesVersion: number
    renderedMessagesVersion: number
}): boolean {
    return params.hasPendingRestore
        && params.baselineSourceMessagesVersion !== null
        && params.sourceMessagesVersion > params.baselineSourceMessagesVersion
        && params.renderedMessagesVersion < params.sourceMessagesVersion
}

export function shouldLoadOlderFromTopWheel(params: {
    scrollTop: number
    deltaY: number
    deltaX?: number
    edgePx?: number
}): boolean {
    if (params.scrollTop > (params.edgePx ?? TOP_LOAD_SCROLL_EDGE_PX)) {
        return false
    }
    if (params.deltaY >= -TOP_LOAD_WHEEL_DELTA_EPSILON_PX) {
        return false
    }
    return Math.abs(params.deltaY) >= Math.abs(params.deltaX ?? 0)
}

export function getPullToLoadOlderIndicator(params: {
    enabled: boolean
    loading: boolean
    distancePx: number
    thresholdPx?: number
    maxOffsetPx?: number
}): PullToLoadOlderIndicatorState {
    if (params.loading) {
        return {
            phase: 'loading',
            progress: 1,
            offset: PULL_TO_LOAD_OLDER_LOADING_OFFSET_PX
        }
    }

    const distancePx = Math.max(0, params.distancePx)
    if (!params.enabled || distancePx === 0) {
        return {
            phase: 'idle',
            progress: 0,
            offset: 0
        }
    }

    const thresholdPx = params.thresholdPx ?? PULL_TO_LOAD_OLDER_THRESHOLD_PX
    const maxOffsetPx = params.maxOffsetPx ?? PULL_TO_LOAD_OLDER_MAX_OFFSET_PX
    const progress = Math.min(distancePx / thresholdPx, 1)

    return {
        phase: progress >= 1 ? 'ready' : 'pulling',
        progress,
        offset: Math.min(maxOffsetPx, distancePx * 0.58)
    }
}

export function captureScrollAnchor(
    viewport: HTMLElement,
    edge: 'top' | 'bottom' = 'top'
): ScrollAnchor | null {
    const viewportRect = viewport.getBoundingClientRect()
    const messages = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR))
    const visibleMessages = messages.filter((message) => {
        const rect = message.getBoundingClientRect()
        return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
    })
    const message = edge === 'bottom' ? visibleMessages.at(-1) : visibleMessages[0]
    if (!message) {
        return null
    }
    const rect = message.getBoundingClientRect()
    return {
        id: message.id,
        ...(edge === 'bottom'
            ? { bottomOffset: rect.bottom - viewportRect.bottom }
            : { topOffset: rect.top - viewportRect.top }),
        element: message,
    }
}

export function restoreScrollAnchor(viewport: HTMLElement, anchor: ScrollAnchor): boolean {
    const target = anchor.element?.isConnected && viewport.contains(anchor.element)
        ? anchor.element
        : Array.from(viewport.querySelectorAll<HTMLElement>('[id]'))
            .find((element) => element.id === anchor.id) ?? null
    if (!target || !viewport.contains(target)) {
        return false
    }
    const viewportRect = viewport.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    viewport.scrollTop += anchor.bottomOffset !== undefined
        ? targetRect.bottom - viewportRect.bottom - anchor.bottomOffset
        : targetRect.top - viewportRect.top - (anchor.topOffset ?? 0)
    return true
}

export async function locateOutlineTargetMessage(options: LocateOutlineTargetOptions): Promise<HTMLElement | null> {
    const anchorId = getConversationMessageAnchorId(options.targetMessageId)
    let target = options.findTarget(anchorId)
    while (!target && options.hasMoreMessages()) {
        const loaded = await options.loadOlderPreservingScroll()
        if (!loaded) {
            break
        }
        target = options.findTarget(anchorId)
    }
    return target
}

function getTouchById(touches: TouchList, touchId: number | null): Touch | null {
    if (touchId === null) {
        return touches[0] ?? null
    }
    for (let index = 0; index < touches.length; index += 1) {
        const touch = touches.item(index)
        if (touch?.identifier === touchId) {
            return touch
        }
    }
    return null
}

export function ScrollToBottomButton(props: {
    count: number
    visible: boolean
    hidden?: boolean
    bottomInset?: number
    bottomSafeAreaInset?: boolean
    bottomAccessoryVisible?: boolean
    onClick: () => void
}) {
    const { t } = useTranslation()
    if (props.hidden) {
        return null
    }

    if (!props.visible && props.count === 0) {
        return null
    }

    const hasNewMessages = props.count > 0
    const newMessageLabel = t('misc.newMessage', { n: props.count, s: props.count === 1 ? '' : 's' })
    const label = hasNewMessages ? newMessageLabel : t('misc.backToBottom')
    const bottomOffsetPx = (props.bottomInset ?? 0) + (props.bottomAccessoryVisible ? 8 : 0)
    const bottomOffset = props.bottomSafeAreaInset
        ? `calc(${bottomOffsetPx}px + var(--app-safe-area-bottom))`
        : `${bottomOffsetPx}px`
    const rightOffset = 'max(1rem, calc((100% - var(--content-max-w, 960px)) / 2 + 0.75rem))'
    const contentClass = hasNewMessages
        ? 'inline-flex h-8 items-center gap-1 rounded-full border border-[var(--app-button)] bg-[var(--app-button)] px-3 text-xs font-medium text-[var(--app-button-text)] shadow-[0_8px_22px_rgba(15,23,42,0.14)] animate-bounce-in'
        : 'flex h-8 w-8 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-[0_8px_22px_rgba(15,23,42,0.14)] animate-bounce-in'

    return (
        <button
            type="button"
            onClick={props.onClick}
            style={{ bottom: bottomOffset, right: rightOffset }}
            className="absolute z-10 bg-transparent p-0 opacity-90 transition-[bottom,opacity] duration-150 ease-out hover:opacity-100"
            aria-label={label}
            title={label}
        >
            <span className={contentClass}>
                {hasNewMessages ? (
                    <>
                        {newMessageLabel}
                        <ArrowDownIcon className="h-3 w-3" />
                    </>
                ) : (
                    <ArrowDownIcon className="h-4 w-4" />
                )}
            </span>
        </button>
    )
}

export function shouldHideScrollToBottomButton(params: {
    bottomAccessoryExpanded?: boolean
    bottomAccessoryVisible?: boolean
    pendingCount: number
}): boolean {
    return params.bottomAccessoryExpanded === true
}

function MessageSkeleton() {
    const { t } = useTranslation()
    const rows = [
        { align: 'end', width: 'w-3/5', height: 'h-10' },
        { align: 'start', width: 'w-5/6', height: 'h-14' },
        { align: 'end', width: 'w-1/2', height: 'h-9' },
        { align: 'start', width: 'w-3/4', height: 'h-12' },
        { align: 'end', width: 'w-2/3', height: 'h-14' },
        { align: 'start', width: 'w-3/5', height: 'h-9' },
        { align: 'end', width: 'w-4/5', height: 'h-11' },
        { align: 'start', width: 'w-2/3', height: 'h-12' }
    ]

    return (
        <div
            className="flex min-h-full flex-col justify-between gap-4 py-1"
            role="status"
            aria-live="polite"
            aria-label={t('misc.loadingMessages')}
            aria-busy="true"
            data-testid="happy-thread-message-skeleton"
            data-session-loading-animation="refresh-loop"
        >
            {rows.map((row, index) => (
                <div key={`skeleton-${index}`} className={row.align === 'end' ? 'flex justify-end' : 'flex justify-start'} aria-hidden="true">
                    <div
                        className={`${row.height} ${row.width} session-message-skeleton-refresh rounded-2xl`}
                        style={{ animationDelay: `${index * 140}ms` }}
                    />
                </div>
            ))}
        </div>
    )
}

function PullToLoadOlderIndicator(props: PullToLoadOlderIndicatorState) {
    const { t } = useTranslation()

    if (props.phase === 'idle') {
        return null
    }

    const isLoading = props.phase === 'loading'
    const isReady = props.phase === 'ready'
    const label = isLoading
        ? t('misc.loading')
        : isReady
            ? t('misc.releaseToLoadOlder')
            : t('misc.pullToLoadOlder')

    return (
        <div
            className="pointer-events-none absolute inset-x-0 top-[calc(var(--app-safe-area-top)+4.25rem)] z-10 flex justify-center transition-[opacity,transform] duration-150 ease-out"
            style={{
                opacity: isLoading ? 1 : Math.max(0.35, props.progress),
                transform: `translateY(${props.offset}px)`
            }}
        >
            <div
                role="status"
                aria-live="polite"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-xs font-medium text-[var(--app-hint)] shadow-[0_8px_22px_rgba(15,23,42,0.10)]"
            >
                {isLoading ? (
                    <Spinner size="sm" label={null} className="text-current" />
                ) : (
                    <ArrowDownIcon
                        className={cn(
                            'h-3.5 w-3.5 transition-transform duration-150',
                            isReady ? 'rotate-180' : ''
                        )}
                    />
                )}
                <span>{label}</span>
            </div>
        </div>
    )
}

const THREAD_MESSAGE_COMPONENTS = {
    UserMessage: HappyUserMessage,
    AssistantMessage: HappyAssistantMessage,
    SystemMessage: HappySystemMessage
} as const

export function ConversationOutlinePanel(props: {
    title: string
    items: readonly ConversationOutlineItem[]
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    onLoadMore: () => void
    onSelect: (item: ConversationOutlineItem) => void
    onClose: () => void
}) {
    const { t } = useTranslation()

    return (
        <aside
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[24rem] flex-col border-l border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl sm:w-[24rem]"
            aria-label={t('session.outline.title')}
        >
            <div className="flex items-start gap-3 border-b border-[var(--app-border)] p-3">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{t('session.outline.title')}</div>
                    <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">{props.title}</div>
                </div>
                <button
                    type="button"
                    onClick={props.onClose}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    aria-label={t('button.close')}
                    title={t('button.close')}
                >
                    <CloseIcon className="h-4 w-4" />
                </button>
            </div>

            {props.hasMoreMessages ? (
                <div className="border-b border-[var(--app-border)] p-3">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={props.onLoadMore}
                        disabled={props.isLoadingMoreMessages}
                        aria-busy={props.isLoadingMoreMessages}
                        className="w-full gap-1.5 text-xs"
                    >
                        {props.isLoadingMoreMessages ? (
                            <>
                                <Spinner size="sm" label={null} className="text-current" />
                                {t('misc.loading')}
                            </>
                        ) : (
                            <>
                                <span aria-hidden="true">↑</span>
                                {t('session.outline.loadOlder')}
                            </>
                        )}
                    </Button>
                </div>
            ) : null}

            <div className="app-scroll-y min-h-0 flex-1 p-2">
                {props.items.length === 0 ? (
                    <div className="px-2 py-8 text-center text-sm text-[var(--app-hint)]">
                        {t('session.outline.empty')}
                    </div>
                ) : (
                    <div className="space-y-1">
                        {props.items.map((item) => {
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => props.onSelect(item)}
                                    className="group flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                >
                                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[11px] font-medium uppercase text-[var(--app-hint)]">
                                            {t('session.outline.kind.user')}
                                        </span>
                                        <span className="line-clamp-2 text-sm leading-snug text-[var(--app-fg)]">
                                            {item.label}
                                        </span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </aside>
    )
}

export function HappyThread(props: {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    fileLinkTarget?: HappyChatFileLinkTarget
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    onFlushPending: () => void
    onAtBottomChange: (atBottom: boolean) => void
    isLoadingMessages: boolean
    messagesWarning: string | null
    hasMoreMessages: boolean
    hasNewerMessages: boolean
    isLoadingMoreMessages: boolean
    isLoadingNewerMessages: boolean
    onLoadMore: () => Promise<unknown>
    onLoadNewer: () => Promise<unknown>
    pendingCount: number
    rawMessagesCount: number
    normalizedMessagesCount: number
    messagesVersion: number
    sourceMessagesVersion?: number
    toolGroupRunActive: boolean
    toolGroupCompletionKey: string | null
    forceScrollToken: number
    outlineOpen: boolean
    outlineTitle: string
    outlineItems: readonly ConversationOutlineItem[]
    topInset?: number
    bottomInset?: number
    bottomSafeAreaInset?: boolean
    scrollButtonBottomInset?: number
    bottomAccessoryVisible?: boolean
    bottomAccessoryExpanded?: boolean
    scrollButtonPositionReady?: boolean
    onOutlineOpenChange: (open: boolean) => void
    onOutlineItemClick?: (item: ConversationOutlineItem) => void
    trailingMessage?: ReactNode
}) {
    const { t } = useTranslation()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)
    const topSentinelRef = useRef<HTMLDivElement | null>(null)
    const loadLockRef = useRef(false)
    const pendingScrollRef = useRef<PendingScrollRestore | null>(null)
    const prevLoadingMoreRef = useRef(false)
    const loadStartedRef = useRef(false)
    const isLoadingMoreRef = useRef(props.isLoadingMoreMessages)
    const isLoadingNewerRef = useRef(props.isLoadingNewerMessages)
    const hasMoreMessagesRef = useRef(props.hasMoreMessages)
    const hasNewerMessagesRef = useRef(props.hasNewerMessages)
    const isLoadingMessagesRef = useRef(props.isLoadingMessages)
    const messagesVersionRef = useRef(props.messagesVersion)
    const sourceMessagesVersionRef = useRef(props.sourceMessagesVersion ?? props.messagesVersion)
    const onLoadMoreRef = useRef(props.onLoadMore)
    const onLoadNewerRef = useRef(props.onLoadNewer)
    const handleLoadMoreRef = useRef<() => void>(() => {})
    const handleLoadNewerRef = useRef<() => void>(() => {})
    const pendingLoadPromiseRef = useRef<Promise<boolean> | null>(null)
    const pendingLoadResolveRef = useRef<((value: boolean) => void) | null>(null)
    const pendingLoadBaselineRef = useRef<PendingLoadBaseline | null>(null)
    const pendingLoadDirectionRef = useRef<'older' | 'newer'>('older')
    const pendingLoadSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const scrollRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const restoredNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const atBottomRef = useRef(true)
    const onAtBottomChangeRef = useRef(props.onAtBottomChange)
    const onFlushPendingRef = useRef(props.onFlushPending)
    const forceScrollTokenRef = useRef(props.forceScrollToken)
    const lastScrollTopRef = useRef(0)
    const manualScrollIntentExpiresAtRef = useRef(0)
    const sessionIdRef = useRef(props.sessionId)
    const initialScrollSessionRef = useRef<string | null>(null)
    const initialScrollDeadlineRef = useRef(0)
    const initialScrollTimersRef = useRef<number[]>([])
    const [isAwayFromBottom, setIsAwayFromBottom] = useState(false)
    const [pullToLoadDistance, setPullToLoadDistanceState] = useState(0)
    const [pullToLoadLoading, setPullToLoadLoading] = useState(false)
    const [showHistoryRestoredNotice, setShowHistoryRestoredNotice] = useState(false)
    const [toolGroupExpansionStates, setToolGroupExpansionStates] = useState<ToolGroupExpansionStates>({})
    const pullToLoadDistanceRef = useRef(0)
    const pullToLoadLoadingRef = useRef(false)
    const pullGestureRef = useRef<PullToLoadOlderGestureState>({
        touchId: null,
        startY: 0,
        active: false
    })
    const previousToolGroupCompletionKeyRef = useRef(props.toolGroupCompletionKey)

    const setToolGroupExpansionState = useCallback((key: string, state: ToolGroupExpansionState) => {
        setToolGroupExpansionStates((current) => current[key] === state
            ? current
            : { ...current, [key]: state })
    }, [])

    useLayoutEffect(() => {
        const previous = previousToolGroupCompletionKeyRef.current
        if (previous === props.toolGroupCompletionKey) {
            return
        }
        previousToolGroupCompletionKeyRef.current = props.toolGroupCompletionKey
        if (props.toolGroupCompletionKey === null) {
            return
        }
        setToolGroupExpansionStates(closeAutoExpandedToolGroups)
    }, [props.toolGroupCompletionKey])

    // Follow state is enabled by a send and stays enabled until the user
    // intentionally scrolls away from the latest message.
    const autoScrollEnabledRef = useRef(true)
    const setPullToLoadDistance = useCallback((distance: number) => {
        const nextDistance = Math.max(0, distance)
        if (Math.abs(nextDistance - pullToLoadDistanceRef.current) < 0.5) {
            return
        }
        pullToLoadDistanceRef.current = nextDistance
        setPullToLoadDistanceState(nextDistance)
    }, [])
    const resetPullGesture = useCallback(() => {
        pullGestureRef.current = {
            touchId: null,
            startY: 0,
            active: false
        }
    }, [])
    useEffect(() => {
        onAtBottomChangeRef.current = props.onAtBottomChange
    }, [props.onAtBottomChange])
    useEffect(() => {
        onFlushPendingRef.current = props.onFlushPending
    }, [props.onFlushPending])
    useEffect(() => {
        hasMoreMessagesRef.current = props.hasMoreMessages
    }, [props.hasMoreMessages])
    useEffect(() => {
        hasNewerMessagesRef.current = props.hasNewerMessages
    }, [props.hasNewerMessages])
    useEffect(() => {
        isLoadingMessagesRef.current = props.isLoadingMessages
    }, [props.isLoadingMessages])
    useEffect(() => {
        messagesVersionRef.current = props.messagesVersion
    }, [props.messagesVersion])
    useEffect(() => {
        sourceMessagesVersionRef.current = props.sourceMessagesVersion ?? props.messagesVersion
    }, [props.messagesVersion, props.sourceMessagesVersion])
    useEffect(() => {
        onLoadMoreRef.current = props.onLoadMore
    }, [props.onLoadMore])
    useEffect(() => {
        onLoadNewerRef.current = props.onLoadNewer
    }, [props.onLoadNewer])

    useEffect(() => {
        sessionIdRef.current = props.sessionId
    }, [props.sessionId])

    const isInitialScrollSettling = useCallback(() => {
        return initialScrollSessionRef.current === sessionIdRef.current && Date.now() < initialScrollDeadlineRef.current
    }, [])

    const clearInitialScrollTimers = useCallback(() => {
        for (const timer of initialScrollTimersRef.current) {
            window.clearTimeout(timer)
        }
        initialScrollTimersRef.current = []
    }, [])

    const settlePendingLoad = useCallback((result: boolean) => {
        const resolve = pendingLoadResolveRef.current
        const baseline = pendingLoadBaselineRef.current
        pendingLoadResolveRef.current = null
        pendingLoadPromiseRef.current = null
        pendingLoadBaselineRef.current = null
        if (!resolve) {
            return
        }
        if (!result || !baseline) {
            resolve(result)
            return
        }
        resolve(
            messagesVersionRef.current !== baseline.messagesVersion
            || hasMoreMessagesRef.current !== baseline.hasMoreMessages
            || hasNewerMessagesRef.current !== baseline.hasNewerMessages
        )
    }, [])

    const clearPendingLoadSettleTimer = useCallback(() => {
        if (pendingLoadSettleTimerRef.current === null) {
            return
        }
        clearTimeout(pendingLoadSettleTimerRef.current)
        pendingLoadSettleTimerRef.current = null
    }, [])

    const clearScrollRestoreTimer = useCallback(() => {
        if (scrollRestoreTimerRef.current === null) return
        clearTimeout(scrollRestoreTimerRef.current)
        scrollRestoreTimerRef.current = null
    }, [])

    const clearRestoredNoticeTimer = useCallback(() => {
        if (restoredNoticeTimerRef.current === null) return
        clearTimeout(restoredNoticeTimerRef.current)
        restoredNoticeTimerRef.current = null
    }, [])

    const finishPendingScrollRestore = useCallback((result: boolean) => {
        const restored = pendingScrollRef.current?.restored === true
        pendingScrollRef.current = null
        loadLockRef.current = false
        clearScrollRestoreTimer()
        settlePendingLoad(result)
        if (!result || !restored) return
        clearRestoredNoticeTimer()
        setShowHistoryRestoredNotice(true)
        restoredNoticeTimerRef.current = setTimeout(() => {
            restoredNoticeTimerRef.current = null
            setShowHistoryRestoredNotice(false)
        }, PAGINATION_RESTORED_NOTICE_MS)
    }, [clearRestoredNoticeTimer, clearScrollRestoreTimer, settlePendingLoad])

    const restorePendingScrollPosition = useCallback((viewport: HTMLElement): boolean => {
        const pending = pendingScrollRef.current
        if (!pending) return false
        const restoredByAnchor = pending.anchor ? restoreScrollAnchor(viewport, pending.anchor) : false
        if (!restoredByAnchor) {
            viewport.scrollTop = pending.direction === 'older'
                ? pending.scrollTop + viewport.scrollHeight - pending.scrollHeight
                : pending.scrollTop
        }
        lastScrollTopRef.current = viewport.scrollTop
        pending.restored = true
        return true
    }, [])

    const schedulePendingScrollFinish = useCallback(() => {
        clearScrollRestoreTimer()
        scrollRestoreTimerRef.current = setTimeout(() => {
            scrollRestoreTimerRef.current = null
            const viewport = viewportRef.current
            if (viewport) restorePendingScrollPosition(viewport)
            finishPendingScrollRestore(true)
        }, PAGINATION_SCROLL_STABILIZE_MS)
    }, [clearScrollRestoreTimer, finishPendingScrollRestore, restorePendingScrollPosition])

    const markManualScrollIntent = useCallback(() => {
        manualScrollIntentExpiresAtRef.current = Date.now() + MANUAL_SCROLL_INTENT_WINDOW_MS
    }, [])

    const consumeManualScrollIntent = useCallback((): boolean => {
        const userInitiated = Date.now() <= manualScrollIntentExpiresAtRef.current
        manualScrollIntentExpiresAtRef.current = 0
        return userInitiated
    }, [])

    // Keep following after an accepted send. Only an actual wheel/touch scroll
    // away from the end may turn that mode off; browser layout and streaming
    // content also emit scroll events and must not cancel it.
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return

        lastScrollTopRef.current = viewport.scrollTop

        const setAutoScrollMode = (enabled: boolean) => {
            if (autoScrollEnabledRef.current === enabled) {
                return
            }
            autoScrollEnabledRef.current = enabled
        }

        const setAtBottomMode = (atBottom: boolean) => {
            setIsAwayFromBottom(!atBottom)
            if (atBottom === atBottomRef.current) {
                return
            }
            atBottomRef.current = atBottom
            onAtBottomChangeRef.current(atBottom)
            if (atBottom) {
                onFlushPendingRef.current()
            }
        }

        const handleScroll = () => {
            const userInitiated = consumeManualScrollIntent()
            const intent = getScrollIntent({
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                previousScrollTop: lastScrollTopRef.current
            })
            lastScrollTopRef.current = viewport.scrollTop

            if (isInitialScrollSettling()) {
                if (userInitiated && shouldCancelInitialScrollSettling(intent)) {
                    initialScrollDeadlineRef.current = 0
                    clearInitialScrollTimers()
                    setAutoScrollMode(false)
                    setAtBottomMode(false)
                }
                return
            }

            if (intent.isAtBottom) {
                if (hasNewerMessagesRef.current) {
                    setAutoScrollMode(false)
                    setAtBottomMode(false)
                    if (userInitiated && !intent.isScrollingUp) {
                        handleLoadNewerRef.current()
                    }
                    return
                }
                setAutoScrollMode(true)
                setAtBottomMode(true)
                return
            }

            if (shouldCancelLatestMessageFollow({
                followingLatest: autoScrollEnabledRef.current,
                isAtBottom: intent.isAtBottom,
                isScrollingUp: intent.isScrollingUp,
                userInitiated
            })) {
                setAutoScrollMode(false)
                setAtBottomMode(false)
                return
            }

            // The user previously left the end, so maintain the normal
            // unread indicator state. Otherwise preserve send-follow mode.
            if (autoScrollEnabledRef.current) {
                return
            }

            setAutoScrollMode(false)
            setAtBottomMode(false)
        }

        viewport.addEventListener('scroll', handleScroll, { passive: true })
        return () => viewport.removeEventListener('scroll', handleScroll)
    }, [clearInitialScrollTimers, consumeManualScrollIntent, isInitialScrollSettling])

    const scrollToBottomInstant = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            // Do not use ScrollToOptions' non-standard `instant` behavior
            // here. WebKit can defer/ignore it during a keyboard or layout
            // transition, leaving a freshly-sent message behind the bottom
            // overlay. Assigning scrollTop always lands on the padded end of
            // the thread in the same layout pass.
            viewport.scrollTop = viewport.scrollHeight
            lastScrollTopRef.current = viewport.scrollTop
        }
    }, [])

    // Scroll to bottom handler for the indicator button
    const scrollToBottom = useCallback(() => {
        const viewport = viewportRef.current
        if (viewport) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
            lastScrollTopRef.current = viewport.scrollTop
        }
        autoScrollEnabledRef.current = true
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onAtBottomChangeRef.current(true)
        }
        setIsAwayFromBottom(false)
        onFlushPendingRef.current()
    }, [])

    // A send is an explicit request to return to the newest message. Unlike
    // the indicator button, do this before paint and without a smooth-scroll
    // animation: the message list may grow in the same commit, while its end
    // padding reserves the measured composer + safe-area clearance.
    const forceScrollToBottom = useCallback(() => {
        scrollToBottomInstant()
        autoScrollEnabledRef.current = true
        if (!atBottomRef.current) {
            atBottomRef.current = true
            onAtBottomChangeRef.current(true)
        }
        setIsAwayFromBottom(false)
        onFlushPendingRef.current()
    }, [scrollToBottomInstant])

    // Reset state when session changes
    useLayoutEffect(() => {
        autoScrollEnabledRef.current = true
        lastScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
        atBottomRef.current = true
        setIsAwayFromBottom(false)
        setPullToLoadDistance(0)
        setPullToLoadLoading(false)
        pullToLoadLoadingRef.current = false
        resetPullGesture()
        manualScrollIntentExpiresAtRef.current = 0
        onAtBottomChangeRef.current(true)
        forceScrollTokenRef.current = props.forceScrollToken
        pendingScrollRef.current = null
        loadLockRef.current = false
        loadStartedRef.current = false
        initialScrollSessionRef.current = null
        initialScrollDeadlineRef.current = 0
        clearInitialScrollTimers()
        clearPendingLoadSettleTimer()
        clearRestoredNoticeTimer()
        setShowHistoryRestoredNotice(false)
        finishPendingScrollRestore(false)
    }, [props.sessionId, clearInitialScrollTimers, clearPendingLoadSettleTimer, clearRestoredNoticeTimer,
        finishPendingScrollRestore, resetPullGesture, setPullToLoadDistance])

    useLayoutEffect(() => {
        if (
            initialScrollSessionRef.current === props.sessionId
            || props.isLoadingMessages
            || props.rawMessagesCount === 0
            || pendingScrollRef.current
        ) {
            return
        }

        initialScrollSessionRef.current = props.sessionId
        autoScrollEnabledRef.current = true
        atBottomRef.current = true
        setIsAwayFromBottom(false)
        onAtBottomChangeRef.current(true)
        scrollToBottomInstant()

        initialScrollDeadlineRef.current = Date.now() + INITIAL_SCROLL_SETTLE_MS
        clearInitialScrollTimers()
        initialScrollTimersRef.current = INITIAL_SCROLL_SETTLE_DELAYS_MS.map((delay) => window.setTimeout(() => {
            if (
                initialScrollSessionRef.current !== props.sessionId
                || !autoScrollEnabledRef.current
                || pendingScrollRef.current
            ) {
                return
            }
            scrollToBottomInstant()
        }, delay))
    }, [
        props.sessionId,
        props.isLoadingMessages,
        props.rawMessagesCount,
        props.messagesVersion,
        scrollToBottomInstant,
        clearInitialScrollTimers
    ])

    useEffect(() => {
        return () => {
            clearInitialScrollTimers()
            clearPendingLoadSettleTimer()
            clearRestoredNoticeTimer()
            finishPendingScrollRestore(false)
        }
    }, [clearInitialScrollTimers, clearPendingLoadSettleTimer, clearRestoredNoticeTimer, finishPendingScrollRestore])

    useLayoutEffect(() => {
        if (forceScrollTokenRef.current === props.forceScrollToken) {
            return
        }
        forceScrollTokenRef.current = props.forceScrollToken
        forceScrollToBottom()
    }, [props.forceScrollToken, forceScrollToBottom])

    // The bottom overlay lives outside the thread and is measured by
    // SessionChat. Its updated height arrives after the composer has changed
    // size, while the thread's ResizeObserver only observes the content box
    // (not its padding). Re-align after the new endpoint padding commits so a
    // just-sent message never remains behind the input capsule.
    useLayoutEffect(() => {
        if (!shouldFollowBottomInsetChange({
            autoScrollEnabled: autoScrollEnabledRef.current,
            atBottom: atBottomRef.current,
            restoringScroll: pendingScrollRef.current !== null
        })) {
            return
        }
        scrollToBottomInstant()
    }, [props.bottomInset, props.bottomSafeAreaInset, scrollToBottomInstant])

    // A run can introduce its first "working" block before a persisted
    // message version changes. If the operator just sent a message and is
    // still following the end of the thread, pin that transient block above
    // the composer as well. Manual scroll-away remains respected.
    useLayoutEffect(() => {
        if (!shouldFollowBottomInsetChange({
            autoScrollEnabled: autoScrollEnabledRef.current,
            atBottom: atBottomRef.current,
            restoringScroll: pendingScrollRef.current !== null
        })) {
            return
        }
        scrollToBottomInstant()
    }, [props.toolGroupRunActive, scrollToBottomInstant])

    const loadPagePreservingScroll = useCallback((direction: 'older' | 'newer'): Promise<boolean> => {
        if (pendingLoadPromiseRef.current) {
            return pendingLoadPromiseRef.current
        }
        if (
            isInitialScrollSettling()
            || isLoadingMessagesRef.current
            || (direction === 'older' ? !hasMoreMessagesRef.current : !hasNewerMessagesRef.current)
            || (direction === 'older' ? isLoadingMoreRef.current : isLoadingNewerRef.current)
            || loadLockRef.current
        ) {
            return Promise.resolve(false)
        }
        const viewport = viewportRef.current
        if (!viewport) {
            return Promise.resolve(false)
        }
        pendingScrollRef.current = {
            // Older pages can be inserted into the same joined assistant block.
            // Anchoring its bottom preserves the visible source content even
            // when the root element itself does not move.
            anchor: captureScrollAnchor(viewport, direction === 'older' ? 'bottom' : 'top'),
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            restored: false,
            direction,
        }
        pendingLoadDirectionRef.current = direction
        clearRestoredNoticeTimer()
        setShowHistoryRestoredNotice(false)
        autoScrollEnabledRef.current = false
        loadLockRef.current = true
        loadStartedRef.current = false
        pendingLoadBaselineRef.current = {
            messagesVersion: messagesVersionRef.current,
            sourceMessagesVersion: sourceMessagesVersionRef.current,
            hasMoreMessages: hasMoreMessagesRef.current,
            hasNewerMessages: hasNewerMessagesRef.current,
        }
        const loadPromise = new Promise<boolean>((resolve) => {
            pendingLoadResolveRef.current = resolve
        })
        pendingLoadPromiseRef.current = loadPromise
        try {
            const load = direction === 'older' ? onLoadMoreRef.current : onLoadNewerRef.current
            void load().catch((error) => {
                finishPendingScrollRestore(false)
                console.error(`Failed to load ${direction} messages:`, error)
            }).finally(() => {
                if (!loadStartedRef.current && !isLoadingMoreRef.current && !isLoadingNewerRef.current) {
                    clearPendingLoadSettleTimer()
                    pendingLoadSettleTimerRef.current = setTimeout(() => {
                        pendingLoadSettleTimerRef.current = null
                        const baseline = pendingLoadBaselineRef.current
                        const waitForDeferredRender = shouldWaitForDeferredHistoryRender({
                            hasPendingRestore: pendingScrollRef.current !== null,
                            baselineSourceMessagesVersion: baseline?.sourceMessagesVersion ?? null,
                            sourceMessagesVersion: sourceMessagesVersionRef.current,
                            renderedMessagesVersion: messagesVersionRef.current,
                        })
                        if (waitForDeferredRender) {
                            return
                        }
                        if (pendingScrollRef.current) {
                            const renderedChanged = messagesVersionRef.current !== baseline?.messagesVersion
                            if (renderedChanged) {
                                const currentViewport = viewportRef.current
                                if (currentViewport) restorePendingScrollPosition(currentViewport)
                                schedulePendingScrollFinish()
                                return
                            }
                            finishPendingScrollRestore(true)
                            return
                        }
                        settlePendingLoad(true)
                    }, PAGINATION_RENDER_SETTLE_MS)
                }
            })
        } catch (error) {
            finishPendingScrollRestore(false)
            console.error('Failed to load older messages:', error)
        }
        return loadPromise
    }, [clearPendingLoadSettleTimer, clearRestoredNoticeTimer, finishPendingScrollRestore,
        isInitialScrollSettling, restorePendingScrollPosition, schedulePendingScrollFinish, settlePendingLoad])

    const loadOlderPreservingScroll = useCallback(
        () => loadPagePreservingScroll('older'),
        [loadPagePreservingScroll]
    )
    const loadNewerPreservingScroll = useCallback(
        () => loadPagePreservingScroll('newer'),
        [loadPagePreservingScroll]
    )

    const canStartPullToLoadOlder = useCallback(() => {
        return (
            !isInitialScrollSettling()
            && !isLoadingMessagesRef.current
            && hasMoreMessagesRef.current
            && !isLoadingMoreRef.current
            && !loadLockRef.current
            && !pendingLoadPromiseRef.current
            && !pullToLoadLoadingRef.current
        )
    }, [isInitialScrollSettling])

    useEffect(() => {
        if (props.hasMoreMessages && !props.isLoadingMessages) {
            return
        }
        resetPullGesture()
        setPullToLoadDistance(0)
    }, [props.hasMoreMessages, props.isLoadingMessages, resetPullGesture, setPullToLoadDistance])

    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }

        const handleTouchStart = (event: TouchEvent) => {
            if (event.touches.length !== 1) {
                resetPullGesture()
                setPullToLoadDistance(0)
                return
            }
            const touch = event.touches[0]
            pullGestureRef.current = {
                touchId: touch.identifier,
                startY: touch.clientY,
                active: viewport.scrollTop <= 0 && canStartPullToLoadOlder()
            }
            setPullToLoadDistance(0)
        }

        const handleTouchMove = (event: TouchEvent) => {
            const gesture = pullGestureRef.current
            const touch = getTouchById(event.touches, gesture.touchId)
            if (!touch) {
                return
            }

            markManualScrollIntent()

            if (!gesture.active) {
                if (viewport.scrollTop > 0 || !canStartPullToLoadOlder()) {
                    gesture.startY = touch.clientY
                    return
                }
                if (touch.clientY <= gesture.startY) {
                    gesture.startY = touch.clientY
                    return
                }
                gesture.active = true
                gesture.startY = touch.clientY
                return
            }

            const distance = touch.clientY - gesture.startY
            if (distance <= 0) {
                setPullToLoadDistance(0)
                return
            }

            if (event.cancelable) {
                event.preventDefault()
            }
            setPullToLoadDistance(distance)
        }

        const finishPull = (shouldLoad: boolean) => {
            const indicator = getPullToLoadOlderIndicator({
                enabled: canStartPullToLoadOlder(),
                loading: false,
                distancePx: pullToLoadDistanceRef.current
            })
            resetPullGesture()
            setPullToLoadDistance(0)

            if (!shouldLoad || indicator.phase !== 'ready') {
                return
            }

            pullToLoadLoadingRef.current = true
            setPullToLoadLoading(true)
            void loadOlderPreservingScroll().finally(() => {
                pullToLoadLoadingRef.current = false
                setPullToLoadLoading(false)
                setPullToLoadDistance(0)
            })
        }

        const handleTouchEnd = () => {
            finishPull(true)
        }

        const handleTouchCancel = () => {
            finishPull(false)
        }

        const handlePointerMove = (event: PointerEvent) => {
            // Wheel covers trackpads; this covers a desktop scrollbar drag.
            if (event.pointerType !== 'touch' && event.buttons !== 0) {
                markManualScrollIntent()
            }
        }

        viewport.addEventListener('touchstart', handleTouchStart, { passive: true })
        viewport.addEventListener('touchmove', handleTouchMove, { passive: false })
        viewport.addEventListener('touchend', handleTouchEnd)
        viewport.addEventListener('touchcancel', handleTouchCancel)
        viewport.addEventListener('pointermove', handlePointerMove, { passive: true })

        return () => {
            viewport.removeEventListener('touchstart', handleTouchStart)
            viewport.removeEventListener('touchmove', handleTouchMove)
            viewport.removeEventListener('touchend', handleTouchEnd)
            viewport.removeEventListener('touchcancel', handleTouchCancel)
            viewport.removeEventListener('pointermove', handlePointerMove)
        }
    }, [
        canStartPullToLoadOlder,
        loadOlderPreservingScroll,
        markManualScrollIntent,
        resetPullGesture,
        setPullToLoadDistance
    ])

    const handleOutlineSelect = useCallback(async (item: ConversationOutlineItem) => {
        const target = await locateOutlineTargetMessage({
            targetMessageId: item.targetMessageId,
            findTarget: (anchorId) => document.getElementById(anchorId),
            hasMoreMessages: () => hasMoreMessagesRef.current,
            loadOlderPreservingScroll
        })
        if (target) {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' })
            autoScrollEnabledRef.current = false
        }
        props.onOutlineItemClick?.(item)
        props.onOutlineOpenChange(false)
    }, [loadOlderPreservingScroll, props.onOutlineItemClick, props.onOutlineOpenChange])

    useEffect(() => {
        handleLoadMoreRef.current = () => {
            void loadOlderPreservingScroll()
        }
    }, [loadOlderPreservingScroll])

    useEffect(() => {
        handleLoadNewerRef.current = () => {
            void loadNewerPreservingScroll()
        }
    }, [loadNewerPreservingScroll])

    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }

        const handleWheel = (event: WheelEvent) => {
            if (
                Math.abs(event.deltaY) > TOP_LOAD_WHEEL_DELTA_EPSILON_PX
                && Math.abs(event.deltaY) >= Math.abs(event.deltaX)
            ) {
                markManualScrollIntent()
            }
            if (!shouldLoadOlderFromTopWheel({
                scrollTop: viewport.scrollTop,
                deltaY: event.deltaY,
                deltaX: event.deltaX
            })) {
                return
            }

            initialScrollDeadlineRef.current = 0
            clearInitialScrollTimers()
            autoScrollEnabledRef.current = false
            void loadOlderPreservingScroll()
        }

        viewport.addEventListener('wheel', handleWheel, { passive: true })
        return () => viewport.removeEventListener('wheel', handleWheel)
    }, [clearInitialScrollTimers, loadOlderPreservingScroll, markManualScrollIntent])

    useEffect(() => {
        const sentinel = topSentinelRef.current
        const viewport = viewportRef.current
        if (!sentinel || !viewport || !props.hasMoreMessages || props.isLoadingMessages) {
            return
        }
        if (typeof IntersectionObserver === 'undefined') {
            return
        }
        if (!shouldEnableTopSentinelAutoLoad(typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined)) {
            return
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        if (isInitialScrollSettling()) {
                            continue
                        }
                        handleLoadMoreRef.current()
                    }
                }
            },
            {
                root: viewport,
                rootMargin: '200px 0px 0px 0px'
            }
        )

        observer.observe(sentinel)
        return () => observer.disconnect()
    }, [props.hasMoreMessages, props.isLoadingMessages, isInitialScrollSettling])

    useEffect(() => {
        const content = contentRef.current
        const viewport = viewportRef.current
        if (!content || !viewport || typeof ResizeObserver === 'undefined') {
            return
        }

        const observer = new ResizeObserver(() => {
            if (pendingScrollRef.current?.restored) {
                restorePendingScrollPosition(viewport)
                schedulePendingScrollFinish()
                return
            }
            // Message DOM can grow after messagesVersion commits (assistant-ui
            // updates its external runtime in an effect, then markdown/tool
            // content may resize). Keep following while the user is at bottom.
            if (shouldFollowBottomInsetChange({
                autoScrollEnabled: autoScrollEnabledRef.current,
                atBottom: atBottomRef.current,
                restoringScroll: pendingScrollRef.current !== null
            })) {
                scrollToBottomInstant()
            }
        })
        observer.observe(content)
        return () => observer.disconnect()
    }, [restorePendingScrollPosition, schedulePendingScrollFinish, scrollToBottomInstant])

    useLayoutEffect(() => {
        const pending = pendingScrollRef.current
        const viewport = viewportRef.current
        if (!viewport) {
            return
        }
        if (pending) {
            const baseline = pendingLoadBaselineRef.current
            if (shouldWaitForDeferredHistoryRender({
                hasPendingRestore: true,
                baselineSourceMessagesVersion: baseline?.sourceMessagesVersion ?? null,
                sourceMessagesVersion: sourceMessagesVersionRef.current,
                renderedMessagesVersion: props.messagesVersion
            })) return
            restorePendingScrollPosition(viewport)
            schedulePendingScrollFinish()
            return
        }
        if (shouldFollowBottomInsetChange({
            autoScrollEnabled: autoScrollEnabledRef.current,
            atBottom: atBottomRef.current,
            restoringScroll: false
        })) {
            scrollToBottomInstant()
        }
    }, [props.messagesVersion, restorePendingScrollPosition, schedulePendingScrollFinish, scrollToBottomInstant])

    useEffect(() => {
        isLoadingMoreRef.current = props.isLoadingMoreMessages
        isLoadingNewerRef.current = props.isLoadingNewerMessages
        const isLoadingPage = props.isLoadingMoreMessages || props.isLoadingNewerMessages
        const wasLoadingPage = prevLoadingMoreRef.current
        if (isLoadingPage) {
            clearPendingLoadSettleTimer()
            loadStartedRef.current = true
        }
        if (wasLoadingPage && !isLoadingPage) {
            const baseline = pendingLoadBaselineRef.current
            const waitForDeferredRender = shouldWaitForDeferredHistoryRender({
                hasPendingRestore: pendingScrollRef.current !== null,
                baselineSourceMessagesVersion: baseline?.sourceMessagesVersion ?? null,
                sourceMessagesVersion: props.sourceMessagesVersion ?? props.messagesVersion,
                renderedMessagesVersion: props.messagesVersion,
            })
            if (pendingScrollRef.current && !waitForDeferredRender) {
                const renderedChanged = props.messagesVersion !== baseline?.messagesVersion
                const viewport = viewportRef.current
                if (renderedChanged && viewport) {
                    restorePendingScrollPosition(viewport)
                    schedulePendingScrollFinish()
                } else {
                    finishPendingScrollRestore(true)
                }
            }
            if (!waitForDeferredRender && !pendingScrollRef.current) {
                settlePendingLoad(true)
            }
        }
        prevLoadingMoreRef.current = isLoadingPage
    }, [clearPendingLoadSettleTimer, finishPendingScrollRestore, props.isLoadingMoreMessages, props.isLoadingNewerMessages, props.messagesVersion,
        props.sourceMessagesVersion, restorePendingScrollPosition, schedulePendingScrollFinish, settlePendingLoad])

    const showSkeleton = props.isLoadingMessages && props.rawMessagesCount === 0 && props.pendingCount === 0
    const pullToLoadIndicator = getPullToLoadOlderIndicator({
        enabled: props.hasMoreMessages && !props.isLoadingMessages,
        loading: pullToLoadLoading,
        distancePx: pullToLoadDistance
    })
    const showHistoryLoadingNotice = props.isLoadingMoreMessages || props.isLoadingNewerMessages
        || (loadLockRef.current && !showHistoryRestoredNotice)
    const historyNoticeTop = `calc(var(${MOBILE_LAYOUT_CONTRACT.thread.topSafeAreaVariable}) + ${(props.topInset ?? 0) + 8}px)`

    return (
        <HappyChatProvider value={{
            api: props.api,
            sessionId: props.sessionId,
            metadata: props.metadata,
            terminalToolDisplayMode,
            disabled: props.disabled,
            onRefresh: props.onRefresh,
            onRetryMessage: props.onRetryMessage,
            hasMoreMessages: props.hasMoreMessages,
            isLoadingMoreMessages: props.isLoadingMoreMessages,
            loadOlderMessagesPreservingScroll: loadOlderPreservingScroll,
            toolGroupExpansionStates,
            setToolGroupExpansionState,
            toolGroupRunActive: props.toolGroupRunActive,
            fileLinkTarget: props.fileLinkTarget
        }}>
            <ThreadPrimitive.Root
                className="relative flex min-h-0 flex-1 flex-col"
                data-testid={MOBILE_LAYOUT_CONTRACT.thread.testId}
                data-mobile-layout-contract={MOBILE_LAYOUT_CONTRACT.thread.state}
            >
                <ThreadPrimitive.Viewport
                    asChild
                    autoScroll={false}
                    scrollToBottomOnInitialize={false}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnThreadSwitch={false}
                >
                    <div
                        ref={viewportRef}
                        className="app-scroll-y min-h-0 flex-1 overflow-x-hidden"
                        data-testid="happy-thread-viewport"
                    >
                        <div
                            ref={contentRef}
                            className="session-thread-content mx-auto min-h-full w-full max-w-content min-w-0 bg-[var(--app-chat-canvas)] p-3"
                            style={getThreadContentPadding(props)}
                            data-testid="happy-thread-content"
                        >
                            <div ref={topSentinelRef} className="h-px w-full" aria-hidden="true" />
                            {showSkeleton ? (
                                <MessageSkeleton />
                            ) : (
                                <>
                                    {props.messagesWarning ? (
                                        <SessionDetailStatusNotice
                                            tone="warning"
                                            title={props.messagesWarning}
                                            className="mb-3 ml-0 max-w-full"
                                            testId="happy-thread-messages-warning"
                                        />
                                    ) : null}

                                    {import.meta.env.DEV && props.normalizedMessagesCount === 0 && props.rawMessagesCount > 0 ? (
                                        <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                                            Message normalization returned 0 items for {props.rawMessagesCount} messages (see `web/src/chat/normalize.ts`).
                                        </div>
                                    ) : null}
                                </>
                            )}
                            <div className="happy-thread-messages flex flex-col gap-5 sm:gap-6">
                                <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                                {props.trailingMessage}
                            </div>
                            {props.hasNewerMessages ? (
                                <div className="flex justify-center py-3" data-testid="load-newer-messages">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={props.isLoadingNewerMessages}
                                        onClick={() => { void loadNewerPreservingScroll() }}
                                    >
                                        {props.isLoadingNewerMessages ? <Spinner size="sm" label={null} /> : null}
                                        {t(props.isLoadingNewerMessages
                                            ? 'session.history.loadingNewer'
                                            : 'session.history.loadNewer')}
                                    </Button>
                                </div>
                            ) : null}
                        </div>
                    </div>
                </ThreadPrimitive.Viewport>
                {(showHistoryLoadingNotice || showHistoryRestoredNotice) ? (
                    <div
                        className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/95 px-3 py-1.5 text-xs text-[var(--app-hint)] shadow-sm"
                        style={{ top: historyNoticeTop }}
                        role="status"
                        data-testid="history-load-position-notice"
                    >
                        <span className="flex items-center gap-1.5 whitespace-nowrap">
                            {showHistoryLoadingNotice ? <Spinner size="sm" label={null} /> : null}
                            {t(showHistoryLoadingNotice
                                ? pendingLoadDirectionRef.current === 'newer'
                                    ? 'session.history.loadingNewer'
                                    : 'session.history.loadingOlder'
                                : 'session.history.positionRestored')}
                        </span>
                    </div>
                ) : null}
                <PullToLoadOlderIndicator {...pullToLoadIndicator} />
                {(props.scrollButtonPositionReady ?? true) ? (
                    <ScrollToBottomButton
                        count={props.pendingCount}
                        visible={isAwayFromBottom}
                        hidden={shouldHideScrollToBottomButton({
                            bottomAccessoryExpanded: props.bottomAccessoryExpanded,
                            bottomAccessoryVisible: props.bottomAccessoryVisible,
                            pendingCount: props.pendingCount
                        })}
                        bottomInset={props.scrollButtonBottomInset ?? props.bottomInset}
                        bottomSafeAreaInset={props.bottomSafeAreaInset}
                        bottomAccessoryVisible={props.scrollButtonBottomInset === undefined ? props.bottomAccessoryVisible : false}
                        onClick={scrollToBottom}
                    />
                ) : null}
                {props.outlineOpen ? (
                    <>
                        <button
                            type="button"
                            className="absolute inset-0 z-20 bg-black/20"
                            aria-label={t('session.outline.close')}
                            onClick={() => props.onOutlineOpenChange(false)}
                        />
                        <ConversationOutlinePanel
                            title={props.outlineTitle}
                            items={props.outlineItems}
                            hasMoreMessages={props.hasMoreMessages}
                            isLoadingMoreMessages={props.isLoadingMoreMessages}
                            onLoadMore={() => {
                                void loadOlderPreservingScroll()
                            }}
                            onSelect={handleOutlineSelect}
                            onClose={() => props.onOutlineOpenChange(false)}
                        />
                    </>
                ) : null}
            </ThreadPrimitive.Root>
        </HappyChatProvider>
    )
}
