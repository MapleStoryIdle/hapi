import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Outlet, useLocation, useMatchRoute, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { getTelegramWebApp, isTelegramApp } from '@/hooks/useTelegram'
import { initializeChatSurfaceColors } from '@/hooks/useChatSurfaceColors'
import { initializeTheme } from '@/hooks/useTheme'
import { initializeThemeColors } from '@/hooks/useThemeColors'
import { useAuth } from '@/hooks/useAuth'
import { useAuthSource } from '@/hooks/useAuthSource'
import { useServerUrl } from '@/hooks/useServerUrl'
import { useSSE } from '@/hooks/useSSE'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { useViewportHeight } from '@/hooks/useViewportHeight'
import { useVisibilityReporter } from '@/hooks/useVisibilityReporter'
import { queryKeys } from '@/lib/query-keys'
import { AppContextProvider } from '@/lib/app-context'
import { SessionConnectionProvider, type SessionConnectionHealth } from '@/lib/session-connection-context'
import { NativeCodexRealtimeProvider } from '@/lib/native-codex-realtime-context'
import {
    clearMessageWindow,
    enqueueIncomingMessages,
    fetchLatestMessages,
    getMessageSequenceFrontier,
    getMessageWindowState
} from '@/lib/message-window-store'
import { markUserInteraction, scheduleBackgroundWork } from '@/lib/interaction-priority'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useTranslation } from '@/lib/use-translation'
import { VoiceProvider } from '@/lib/voice-context'
import { requireHubUrlForLogin } from '@/lib/runtime-config'
import {
    getAppGlobalSseSubscription,
    getAppSessionSseSubscription,
    shouldReconcileMessageSequenceGap,
    shouldUseGlobalMessageFallback
} from '@/lib/appSseSubscriptions'
import { LoginPrompt } from '@/components/LoginPrompt'
import { InstallPrompt } from '@/components/InstallPrompt'
import { OfflineBanner } from '@/components/OfflineBanner'
import { PwaUpdateBanner } from '@/components/PwaUpdateBanner'
import { VoiceErrorBanner } from '@/components/VoiceErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { ToastContainer } from '@/components/ToastContainer'
import { PwaUpdateProvider } from '@/lib/pwa-update-context'
import { ToastProvider, type ToastKind, useToast } from '@/lib/toast-context'
import type { SyncEvent } from '@/types/api'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const REQUIRE_SERVER_URL = requireHubUrlForLogin()
const DEGRADED_MESSAGE_PROBE_INTERVAL_MS = 30_000

function withPwaBanner(content: ReactNode) {
    return (
        <>
            <PwaUpdateBanner />
            {content}
        </>
    )
}

export function App() {
    return (
        <ToastProvider>
            <PwaUpdateProvider>
                <AppInner />
            </PwaUpdateProvider>
        </ToastProvider>
    )
}

function AppInner() {
    const { t } = useTranslation()
    const { serverUrl, baseUrl, setServerUrl, clearServerUrl } = useServerUrl()
    const { authSource, isLoading: isAuthSourceLoading, setAccessToken } = useAuthSource(baseUrl)
    const { token, api, isLoading: isAuthLoading, error: authError, needsBinding, bind } = useAuth(authSource, baseUrl)
    const goBack = useAppGoBack()
    const pathname = useLocation({ select: (location) => location.pathname })
    const matchRoute = useMatchRoute()
    const router = useRouter()
    const { addToast } = useToast()

    useEffect(() => {
        const tg = getTelegramWebApp()
        tg?.ready()
        tg?.expand()
        initializeTheme()
        initializeThemeColors()
        initializeChatSurfaceColors()
    }, [])

    // Native capture runs before React's synthetic click handlers. Mark the
    // short interaction window here so SSE/reconnect work that arrives at the
    // same moment yields to every control, not only the session header.
    useEffect(() => {
        const handlePointerDown = () => {
            markUserInteraction()
        }
        const handleActivationKey = (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                markUserInteraction()
            }
        }

        document.addEventListener('pointerdown', handlePointerDown, true)
        document.addEventListener('keydown', handleActivationKey, true)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true)
            document.removeEventListener('keydown', handleActivationKey, true)
        }
    }, [])

    // Track visual viewport height for mobile keyboard avoidance (see useViewportHeight.ts)
    useViewportHeight()

    useEffect(() => {
        const preventDefault = (event: Event) => {
            event.preventDefault()
        }

        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey) {
                event.preventDefault()
            }
        }

        const onKeyDown = (event: KeyboardEvent) => {
            const modifier = event.ctrlKey || event.metaKey
            if (!modifier) return
            if (event.key === '+' || event.key === '-' || event.key === '=' || event.key === '0') {
                event.preventDefault()
            }
        }

        document.addEventListener('gesturestart', preventDefault as EventListener, { passive: false })
        document.addEventListener('gesturechange', preventDefault as EventListener, { passive: false })
        document.addEventListener('gestureend', preventDefault as EventListener, { passive: false })

        window.addEventListener('wheel', onWheel, { passive: false })
        window.addEventListener('keydown', onKeyDown)

        return () => {
            document.removeEventListener('gesturestart', preventDefault as EventListener)
            document.removeEventListener('gesturechange', preventDefault as EventListener)
            document.removeEventListener('gestureend', preventDefault as EventListener)

            window.removeEventListener('wheel', onWheel)
            window.removeEventListener('keydown', onKeyDown)
        }
    }, [])

    useEffect(() => {
        const tg = getTelegramWebApp()
        const backButton = tg?.BackButton
        if (!backButton) return

        if (pathname === '/' || pathname === '/sessions') {
            backButton.offClick(goBack)
            backButton.hide()
            return
        }

        backButton.show()
        backButton.onClick(goBack)
        return () => {
            backButton.offClick(goBack)
            backButton.hide()
        }
    }, [goBack, pathname])
    const queryClient = useQueryClient()
    const sessionMatch = matchRoute({ to: '/sessions/$sessionId' })
    const selectedSessionId = sessionMatch && sessionMatch.sessionId !== 'new' ? sessionMatch.sessionId : null
    const [sseDisconnected, setSseDisconnected] = useState(false)
    const [sessionSseDisconnected, setSessionSseDisconnected] = useState(false)
    const [globalSseConnected, setGlobalSseConnected] = useState(false)
    const [sessionSseConnected, setSessionSseConnected] = useState(false)
    const [isRecoveringSessionConnection, setIsRecoveringSessionConnection] = useState(false)
    const [sessionLastUpdatedAt, setSessionLastUpdatedAt] = useState<number | null>(null)
    const [sseReconnectKey, setSseReconnectKey] = useState(0)
    const syncTokenRef = useRef(0)
    const isFirstConnectRef = useRef(true)
    const sessionSseConnectedRef = useRef(false)
    const sessionReconcileInFlightRef = useRef<Set<string>>(new Set())
    const sessionRecoveryTokenRef = useRef(0)
    // Track every selected-session event without forcing App + Outlet to
    // re-render. The timestamp is only visualized while the connection is
    // unhealthy, where a throttled update is sufficient.
    const sessionLastUpdatedAtRef = useRef<number | null>(null)
    const sessionLastUpdatedAtVisibleRef = useRef(0)
    const baseUrlRef = useRef(baseUrl)
    const pushPromptedRef = useRef(false)
    const { isSupported: isPushSupported, permission: pushPermission, requestPermission, subscribe } = usePushNotifications(api)

    const recordSelectedSessionActivity = useCallback((publishWhenDisconnected = false) => {
        const now = Date.now()
        sessionLastUpdatedAtRef.current = now
        if (
            publishWhenDisconnected
            && !sessionSseConnectedRef.current
            && now - sessionLastUpdatedAtVisibleRef.current >= 1_000
        ) {
            sessionLastUpdatedAtVisibleRef.current = now
            setSessionLastUpdatedAt(now)
        }
    }, [])

    useEffect(() => {
        if (baseUrlRef.current === baseUrl) {
            return
        }
        baseUrlRef.current = baseUrl
        isFirstConnectRef.current = true
        syncTokenRef.current = 0
        sessionSseConnectedRef.current = false
        sessionReconcileInFlightRef.current.clear()
        setSseDisconnected(false)
        setSessionSseDisconnected(false)
        setGlobalSseConnected(false)
        sessionSseConnectedRef.current = false
        setSessionSseConnected(false)
        setIsRecoveringSessionConnection(false)
        sessionLastUpdatedAtRef.current = null
        sessionLastUpdatedAtVisibleRef.current = 0
        setSessionLastUpdatedAt(null)
        queryClient.clear()
    }, [baseUrl, queryClient])

    useEffect(() => {
        sessionSseConnectedRef.current = false
        sessionRecoveryTokenRef.current += 1
        if (selectedSessionId) {
            sessionReconcileInFlightRef.current.delete(selectedSessionId)
        }
        setSessionSseDisconnected(false)
        setSessionSseConnected(false)
        setIsRecoveringSessionConnection(false)
        sessionLastUpdatedAtRef.current = null
        sessionLastUpdatedAtVisibleRef.current = 0
        setSessionLastUpdatedAt(null)
    }, [selectedSessionId])

    // Clean up URL params after successful auth (for direct access links)
    useEffect(() => {
        if (!token || !api) return
        const { pathname, search, hash, state } = router.history.location
        const searchParams = new URLSearchParams(search)
        if (!searchParams.has('server') && !searchParams.has('hub') && !searchParams.has('token')) {
            return
        }
        searchParams.delete('server')
        searchParams.delete('hub')
        searchParams.delete('token')
        const nextSearch = searchParams.toString()
        const nextHref = `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`
        router.history.replace(nextHref, state)
    }, [token, api, router])

    useEffect(() => {
        if (!api || !token) {
            pushPromptedRef.current = false
            return
        }
        if (isTelegramApp() || !isPushSupported) {
            return
        }
        if (pushPromptedRef.current) {
            return
        }
        pushPromptedRef.current = true

        const run = async () => {
            if (pushPermission === 'granted') {
                await subscribe()
                return
            }
            if (pushPermission === 'default') {
                const granted = await requestPermission()
                if (granted) {
                    await subscribe()
                }
            }
        }

        void run()
    }, [api, isPushSupported, pushPermission, requestPermission, subscribe, token])

    const reconcileSelectedSessionMessages = useCallback((): Promise<void> => {
        if (!api || !selectedSessionId) {
            return Promise.resolve()
        }
        if (sessionReconcileInFlightRef.current.has(selectedSessionId)) {
            return Promise.resolve()
        }
        sessionReconcileInFlightRef.current.add(selectedSessionId)
        // SSE replays a short cursor window, while this HTTP read repairs gaps
        // outside that window and validates the authoritative message snapshot.
        // `force` queues one follow-up read behind an in-flight initial load.
        return fetchLatestMessages(api, selectedSessionId, { force: true })
            .then(() => {
                if (selectedSessionId) {
                    recordSelectedSessionActivity(true)
                }
            })
            .finally(() => {
                sessionReconcileInFlightRef.current.delete(selectedSessionId)
            })
    }, [api, recordSelectedSessionActivity, selectedSessionId])

    const reconcileOnMessageGap = useCallback((event: SyncEvent): void => {
        if (event.type !== 'message-received' || !api || event.sessionId !== selectedSessionId) {
            return
        }
        const incomingSeq = event.message.seq
        if (typeof incomingSeq !== 'number') {
            return
        }
        const knownFrontier = getMessageSequenceFrontier(event.sessionId)
        if (shouldReconcileMessageSequenceGap({ knownFrontier, incomingSeq })) {
            scheduleBackgroundWork(() => {
                void reconcileSelectedSessionMessages()
            })
        }
    }, [api, reconcileSelectedSessionMessages, selectedSessionId])

    const handleSseConnect = useCallback(() => {
        // Clear disconnected state on successful connection
        setSseDisconnected(false)
        setGlobalSseConnected(true)

        // Increment token to track this specific connection
        const token = ++syncTokenRef.current

        // A completed initial connection is enough to distinguish a later
        // disconnect from the first connection attempt when deriving session
        // connection health. Reconnect recovery itself stays silent: the
        // session header's connection indicator is the single network cue.
        if (isFirstConnectRef.current) {
            isFirstConnectRef.current = false
        }
        // Reconnect recovery is authoritative, but it can trigger a broad
        // cache refetch and a full chat reconciliation. Always put it on a
        // background task and let an in-progress click finish first.
        scheduleBackgroundWork(() => {
            // A newer connection superseded this recovery while it was queued.
            if (syncTokenRef.current !== token) {
                return
            }
            const invalidations = [
                queryClient.invalidateQueries({ queryKey: ['session-groups'] }),
                queryClient.invalidateQueries({ queryKey: ['session-labels'] }),
                queryClient.invalidateQueries({ queryKey: ['session-pins'] }),
                queryClient.invalidateQueries({ queryKey: ['kanban-order'] }),
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
                // Invalidate ALL cached session-detail entries on reconnect, not just
                // the selected one.  With `SESSION_DETAIL_STALE_TIME_MS` extending the
                // freshness window on `useSession`, a previously-viewed session that
                // received updates during the SSE gap would otherwise serve stale
                // cached data on remount.  See tiann/hapi#884.
                queryClient.invalidateQueries({ queryKey: ['session'] })
            ]
            const refreshMessages = reconcileSelectedSessionMessages()
            void Promise.all([...invalidations, refreshMessages])
                .catch((error) => {
                    console.error('Failed to invalidate queries on SSE connect:', error)
                })
        })
    }, [queryClient, reconcileSelectedSessionMessages])

    const handleSseDisconnect = useCallback(() => {
        setGlobalSseConnected(false)
        // Ignore the initial connection attempt when deriving session health.
        if (!isFirstConnectRef.current) {
            setSseDisconnected(true)
        }
    }, [])

    const handleSseEvent = useCallback((event: SyncEvent) => {
        if ('sessionId' in event && event.sessionId === selectedSessionId) {
            recordSelectedSessionActivity(true)
        }
        reconcileOnMessageGap(event)
        if (event.type === 'message-received') {
            return
        }
        if (event.type !== 'messages-invalidated') {
            return
        }
        if (!api || event.sessionId !== selectedSessionId) {
            return
        }
        scheduleBackgroundWork(() => {
            clearMessageWindow(event.sessionId)
            void reconcileSelectedSessionMessages()
        })
    }, [api, reconcileOnMessageGap, reconcileSelectedSessionMessages, recordSelectedSessionActivity, selectedSessionId])

    const handleGlobalSseEvent = useCallback((event: SyncEvent) => {
        // The all-session stream stays connected while the selected-session
        // stream is being opened or recovered. Feed its copy of a visible
        // message into the window as a lossless fallback. Once the narrow
        // stream is connected, leave its duplicate entirely alone: avoiding
        // the second handler is more important than a later idempotent merge.
        if (event.type === 'message-received') {
            if (event.sessionId === selectedSessionId && sessionSseConnectedRef.current) {
                return
            }
            if (shouldUseGlobalMessageFallback({
                eventSessionId: event.sessionId,
                selectedSessionId,
                sessionStreamConnected: sessionSseConnectedRef.current
            })) {
                enqueueIncomingMessages(event.sessionId, [event.message])
            }
        }
        handleSseEvent(event)
    }, [handleSseEvent, selectedSessionId])

    const handleSessionSseConnect = useCallback(() => {
        sessionSseConnectedRef.current = true
        setSessionSseDisconnected(false)
        setSessionSseConnected(true)
        recordSelectedSessionActivity()
        scheduleBackgroundWork(() => {
            void reconcileSelectedSessionMessages()
        })
    }, [reconcileSelectedSessionMessages, recordSelectedSessionActivity])

    const handleSessionSseDisconnect = useCallback(() => {
        setSessionSseConnected(false)
        const wasConnected = sessionSseConnectedRef.current
        sessionSseConnectedRef.current = false
        if (!wasConnected) {
            return
        }
        setSessionSseDisconnected(true)
    }, [])

    useEffect(() => {
        if (!api || !selectedSessionId || sessionSseConnected) {
            return
        }

        let cancelled = false
        let probeInFlight = false
        const probeLatestMessage = async () => {
            if (
                cancelled
                || sessionSseConnectedRef.current
                || document.visibilityState !== 'visible'
            ) {
                return
            }
            if (probeInFlight) {
                return
            }
            const before = getMessageWindowState(selectedSessionId)
            if (before.isLoading) {
                return
            }
            probeInFlight = true
            try {
                const response = await api.getMessages(selectedSessionId, { limit: 1 })
                if (cancelled) {
                    return
                }
                const latestSeq = response.messages.reduce<number | null>((latest, message) => (
                    typeof message.seq === 'number' && (latest === null || message.seq > latest)
                        ? message.seq
                        : latest
                ), null)
                const knownFrontier = getMessageSequenceFrontier(selectedSessionId)
                if (latestSeq !== null && (knownFrontier === null || latestSeq > knownFrontier)) {
                    scheduleBackgroundWork(() => {
                        void reconcileSelectedSessionMessages()
                    })
                }
            } catch {
                // The SSE reconnect path and the next probe will retry. The
                // message window owns the visible warning for a full refresh.
            } finally {
                probeInFlight = false
            }
        }

        const timer = window.setInterval(() => {
            void probeLatestMessage()
        }, DEGRADED_MESSAGE_PROBE_INTERVAL_MS)

        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [api, reconcileSelectedSessionMessages, selectedSessionId, sessionSseConnected])
    const translateIncomingToast = useCallback((title: string, body: string, kind?: ToastKind): { title: string; body: string; kind: ToastKind } => {
        const normalizedTitle = title.trim()
        const normalizedBody = body.trim()

        if (normalizedTitle === 'Ready for input') {
            const waitingMatch = normalizedBody.match(/^(.+)\s+is waiting in\s+(.+)$/i)
            if (waitingMatch) {
                const agent = waitingMatch[1]?.trim() ?? ''
                const sessionName = waitingMatch[2]?.trim() ?? ''
                return {
                    title: t('toast.ready.title'),
                    body: t('toast.ready.body', { agent, session: sessionName }),
                    kind: kind ?? 'info'
                }
            }
            return {
                title: t('toast.ready.title'),
                body: normalizedBody,
                kind: kind ?? 'info'
            }
        }

        if (normalizedTitle === 'Permission Request') {
            return {
                title: t('toast.permission.title'),
                body: normalizedBody,
                kind: kind ?? 'warning'
            }
        }

        if (normalizedTitle === 'Task completed') {
            return {
                title: t('toast.task.completed'),
                body: normalizedBody,
                kind: kind ?? 'success'
            }
        }

        if (normalizedTitle === 'Task failed') {
            return {
                title: t('toast.task.failed'),
                body: normalizedBody,
                kind: kind ?? 'error'
            }
        }

        return { title, body, kind: kind ?? 'info' }
    }, [t])

    const handleToast = useCallback((event: ToastEvent) => {
        const localized = translateIncomingToast(event.data.title, event.data.body, event.data.kind)
        addToast({
            title: localized.title,
            body: localized.body,
            sessionId: event.data.sessionId,
            url: event.data.url,
            kind: localized.kind
        })
    }, [addToast, translateIncomingToast])

    const globalEventSubscription = useMemo(() => getAppGlobalSseSubscription(), [])
    const sessionEventSubscription = useMemo(
        () => getAppSessionSseSubscription(selectedSessionId),
        [selectedSessionId]
    )
    const sseEnabled = Boolean(api && token)

    const recoverSessionConnection = useCallback(async (): Promise<void> => {
        if (!api || !selectedSessionId || isRecoveringSessionConnection) {
            return
        }

        const recoveryToken = ++sessionRecoveryTokenRef.current
        setIsRecoveringSessionConnection(true)
        // Rebuild both streams. The session stream is preferred, while the
        // global stream remains the lossless fallback for visible messages.
        setGlobalSseConnected(false)
        sessionSseConnectedRef.current = false
        setSessionSseConnected(false)
        setSseReconnectKey((value) => value + 1)

        try {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
                queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) }),
                reconcileSelectedSessionMessages()
            ])
        } catch {
            // The visible connection state remains in recovery/offline until
            // one of the rebuilt streams opens; avoid exposing transport text.
        } finally {
            if (sessionRecoveryTokenRef.current === recoveryToken) {
                setIsRecoveringSessionConnection(false)
            }
        }
    }, [api, isRecoveringSessionConnection, queryClient, reconcileSelectedSessionMessages, selectedSessionId])

    const sessionConnectionHealth = useMemo<SessionConnectionHealth>(() => {
        if (!selectedSessionId) {
            return 'offline'
        }
        if (isRecoveringSessionConnection) {
            return 'recovering'
        }
        if (sessionSseConnected) {
            return 'connected'
        }
        if (globalSseConnected) {
            return 'degraded'
        }
        if (sseDisconnected || sessionSseDisconnected) {
            return 'offline'
        }
        return 'recovering'
    }, [globalSseConnected, isRecoveringSessionConnection, selectedSessionId, sessionSseConnected, sessionSseDisconnected, sseDisconnected])

    useEffect(() => {
        if (sessionConnectionHealth === 'connected') {
            return
        }
        const lastUpdatedAt = sessionLastUpdatedAtRef.current
        if (lastUpdatedAt !== null) {
            sessionLastUpdatedAtVisibleRef.current = lastUpdatedAt
            setSessionLastUpdatedAt(lastUpdatedAt)
        }
    }, [sessionConnectionHealth])

    const sessionConnectionContext = useMemo(() => ({
        health: sessionConnectionHealth,
        recover: recoverSessionConnection,
        lastUpdatedAt: sessionLastUpdatedAt
    }), [recoverSessionConnection, sessionConnectionHealth, sessionLastUpdatedAt])
    const nativeCodexRealtimeContext = useMemo(() => ({
        connected: globalSseConnected
    }), [globalSseConnected])

    const { subscriptionId: globalSubscriptionId } = useSSE({
        enabled: sseEnabled,
        token: token ?? '',
        baseUrl,
        reconnectKey: sseReconnectKey,
        subscription: globalEventSubscription,
        scope: 'global',
        onConnect: handleSseConnect,
        onDisconnect: handleSseDisconnect,
        onEvent: handleGlobalSseEvent,
        onToast: handleToast
    })

    const { subscriptionId: sessionSubscriptionId } = useSSE({
        enabled: sseEnabled && Boolean(sessionEventSubscription),
        token: token ?? '',
        baseUrl,
        reconnectKey: sseReconnectKey,
        subscription: sessionEventSubscription ?? undefined,
        scope: 'full',
        onConnect: handleSessionSseConnect,
        onDisconnect: handleSessionSseDisconnect,
        onEvent: handleSseEvent
    })

    useEffect(() => {
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') {
                return
            }
            scheduleBackgroundWork(() => {
                void reconcileSelectedSessionMessages()
            })
        }

        document.addEventListener('visibilitychange', onVisibilityChange)
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [reconcileSelectedSessionMessages])

    useVisibilityReporter({
        api,
        subscriptionId: globalSubscriptionId,
        enabled: sseEnabled
    })

    useVisibilityReporter({
        api,
        subscriptionId: sessionSubscriptionId,
        enabled: sseEnabled && Boolean(sessionEventSubscription)
    })

    // Loading auth source
    if (isAuthSourceLoading) {
        return withPwaBanner(
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('loading')} className="text-sm" />
            </div>,
        )
    }

    // No auth source (browser environment, not logged in)
    if (!authSource) {
        return withPwaBanner(
            <LoginPrompt
                onLogin={setAccessToken}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
            />,
        )
    }

    if (needsBinding) {
        return withPwaBanner(
            <LoginPrompt
                mode="bind"
                onBind={bind}
                baseUrl={baseUrl}
                serverUrl={serverUrl}
                setServerUrl={setServerUrl}
                clearServerUrl={clearServerUrl}
                requireServerUrl={REQUIRE_SERVER_URL}
                error={authError ?? undefined}
            />,
        )
    }

    // Authenticating (also covers the gap before useAuth effect starts)
    if (isAuthLoading || (authSource && !token && !authError)) {
        return withPwaBanner(
            <div className="h-full flex items-center justify-center p-4">
                <LoadingState label={t('authorizing')} className="text-sm" />
            </div>,
        )
    }

    // Auth error
    if (authError || !token || !api) {
        // If using access token and auth failed, show login again
        if (authSource.type === 'accessToken') {
            return withPwaBanner(
                <LoginPrompt
                    onLogin={setAccessToken}
                    baseUrl={baseUrl}
                    serverUrl={serverUrl}
                    setServerUrl={setServerUrl}
                    clearServerUrl={clearServerUrl}
                    requireServerUrl={REQUIRE_SERVER_URL}
                    error={authError ?? t('login.error.authFailed')}
                />,
            )
        }

        // Telegram auth failed
        return withPwaBanner(
            <div className="p-4 space-y-3">
                <div className="text-base font-semibold">{t('login.title')}</div>
                <div className="text-sm text-red-600">
                    {authError ?? t('login.error.authFailed')}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Open this page from Telegram using the bot's "Open App" button (not "Open in browser").
                </div>
            </div>,
        )
    }

    return (
        <AppContextProvider value={{ api, token, baseUrl }}>
            <NativeCodexRealtimeProvider value={nativeCodexRealtimeContext}>
                <SessionConnectionProvider value={sessionConnectionContext}>
                    <VoiceProvider>
                        <PwaUpdateBanner />
                        <VoiceErrorBanner offsetFromTitleBar={Boolean(selectedSessionId)} />
                        <OfflineBanner offsetFromTitleBar={Boolean(selectedSessionId)} />
                        <div className="h-full min-h-0 flex flex-col" data-drawer-page-background>
                            <Suspense fallback={
                                <div className="flex flex-1 items-center justify-center p-4">
                                    <LoadingState label={t('loading.session')} className="text-sm" />
                                </div>
                            }>
                                <Outlet />
                            </Suspense>
                        </div>
                        <ToastContainer />
                        <InstallPrompt />
                    </VoiceProvider>
                </SessionConnectionProvider>
            </NativeCodexRealtimeProvider>
        </AppContextProvider>
    )
}
