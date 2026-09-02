import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isObject, toSessionSummary } from '@hapi/protocol'
import { MachinePatchSchema, MachineSchema, SessionPatchSchema, SessionSchema } from '@hapi/protocol/schemas'
import type {
    Machine,
    MachinesResponse,
    Session,
    SessionPatch,
    SessionResponse,
    SessionsResponse,
    SessionSummary,
    SyncEvent
} from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow, enqueueIncomingMessages, getMessageWindowState, markMessagesConsumed, removeOptimisticMessage, updateMessageStatus } from '@/lib/message-window-store'
import { scheduleBackgroundWork } from '@/lib/interaction-priority'
import { publishNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'

type SSESubscription = {
    all?: boolean
    sessionId?: string
    machineId?: string
}

export type SSEScope = 'global' | 'full'

const MESSAGE_STREAM_EVENT_TYPES = new Set<SyncEvent['type']>([
    'message-received',
    'messages-consumed',
    'message-cancelled',
    'scheduled-matured'
])

export function isGlobalScopedMessageStreamEvent(scope: SSEScope, eventType: SyncEvent['type']): boolean {
    return scope === 'global' && MESSAGE_STREAM_EVENT_TYPES.has(eventType)
}

type VisibilityState = 'visible' | 'hidden'

type ToastEvent = Extract<SyncEvent, { type: 'toast' }>

const HEARTBEAT_STALE_MS = 90_000
const HEARTBEAT_WATCHDOG_INTERVAL_MS = 10_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
const RECONNECT_JITTER_MS = 500
const INVALIDATION_BATCH_MS = 16
const SESSION_UPDATE_BATCH_MS = 80

type SessionCacheEvent = Extract<SyncEvent, {
    type: 'session-added' | 'session-updated' | 'session-removed'
}>

function sortSessionSummaries(left: SessionSummary, right: SessionSummary): number {
    if (left.active !== right.active) {
        return left.active ? -1 : 1
    }
    if (left.active && left.pendingRequestsCount !== right.pendingRequestsCount) {
        return right.pendingRequestsCount - left.pendingRequestsCount
    }
    return right.updatedAt - left.updatedAt
}

function isSessionRecord(value: unknown): value is Session {
    return SessionSchema.safeParse(value).success
}

function getSessionPatch(value: unknown): SessionPatch | null {
    const parsed = SessionPatchSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return Object.keys(parsed.data).length > 0 ? parsed.data : null
}

function isMachineRecord(value: unknown): value is Machine {
    return MachineSchema.safeParse(value).success
}

function getMachinePatch(value: unknown): { active?: boolean; activeAt?: number; updatedAt?: number } | null {
    const parsed = MachinePatchSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return Object.keys(parsed.data).length > 0 ? parsed.data : null
}

function isSkillsUpdateMessage(event: Extract<SyncEvent, { type: 'message-received' }>): boolean {
    const content = event.message.content
    if (!isObject(content) || content.type !== 'codex') return false
    const data = content.data
    return isObject(data)
        && data.type === 'codex-session-event'
        && (data.eventType === 'skills_update_available' || data.event_type === 'skills_update_available')
}

function getVisibilityState(): VisibilityState {
    if (typeof document === 'undefined') {
        return 'hidden'
    }
    return document.visibilityState === 'visible' ? 'visible' : 'hidden'
}

function buildEventsUrl(
    baseUrl: string,
    token: string,
    subscription: SSESubscription,
    visibility: VisibilityState,
    lastEventId: number | null
): string {
    const params = new URLSearchParams()
    params.set('token', token)
    params.set('visibility', visibility)
    if (subscription.all) {
        params.set('all', 'true')
    }
    if (subscription.sessionId) {
        params.set('sessionId', subscription.sessionId)
    }
    if (subscription.machineId) {
        params.set('machineId', subscription.machineId)
    }
    if (lastEventId !== null) {
        params.set('lastEventId', `${lastEventId}`)
    }

    const path = `/api/events?${params.toString()}`
    try {
        return new URL(path, baseUrl).toString()
    } catch {
        return path
    }
}

export function useSSE(options: {
    enabled: boolean
    token: string
    baseUrl: string
    /** Changes only when the operator explicitly asks to rebuild this stream. */
    reconnectKey?: number
    subscription?: SSESubscription
    scope?: SSEScope
    onEvent: (event: SyncEvent) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onError?: (error: unknown) => void
    onToast?: (event: ToastEvent) => void
}): { subscriptionId: string | null } {
    const queryClient = useQueryClient()
    const onEventRef = useRef(options.onEvent)
    const onConnectRef = useRef(options.onConnect)
    const onDisconnectRef = useRef(options.onDisconnect)
    const onErrorRef = useRef(options.onError)
    const onToastRef = useRef(options.onToast)
    const eventSourceRef = useRef<EventSource | null>(null)
    const invalidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const pendingInvalidationsRef = useRef<{
        sessions: boolean
        machines: boolean
        sessionIds: Set<string>
    }>({ sessions: false, machines: false, sessionIds: new Set() })
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const reconnectAttemptRef = useRef(0)
    const lastActivityAtRef = useRef(0)
    const lastEventIdRef = useRef<number | null>(null)
    const streamIdentityRef = useRef<string | null>(null)
    const [reconnectNonce, setReconnectNonce] = useState(0)
    const [subscriptionId, setSubscriptionId] = useState<string | null>(null)

    useEffect(() => {
        onEventRef.current = options.onEvent
    }, [options.onEvent])

    useEffect(() => {
        onErrorRef.current = options.onError
    }, [options.onError])

    useEffect(() => {
        onConnectRef.current = options.onConnect
    }, [options.onConnect])

    useEffect(() => {
        onDisconnectRef.current = options.onDisconnect
    }, [options.onDisconnect])

    useEffect(() => {
        onToastRef.current = options.onToast
    }, [options.onToast])

    const subscription = options.subscription ?? {}
    const scope = options.scope ?? 'full'

    const subscriptionKey = useMemo(() => {
        return `${scope}|${subscription.all ? '1' : '0'}|${subscription.sessionId ?? ''}|${subscription.machineId ?? ''}`
    }, [scope, subscription.all, subscription.sessionId, subscription.machineId])

    useEffect(() => {
        if (!options.enabled) {
            eventSourceRef.current?.close()
            eventSourceRef.current = null
            if (invalidationTimerRef.current) {
                clearTimeout(invalidationTimerRef.current)
                invalidationTimerRef.current = null
            }
            pendingInvalidationsRef.current.sessions = false
            pendingInvalidationsRef.current.machines = false
            pendingInvalidationsRef.current.sessionIds.clear()
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
            reconnectAttemptRef.current = 0
            setSubscriptionId(null)
            return
        }

        setSubscriptionId(null)
        const streamIdentity = JSON.stringify([options.baseUrl, options.token, subscriptionKey])
        if (streamIdentityRef.current !== streamIdentity) {
            streamIdentityRef.current = streamIdentity
            lastEventIdRef.current = null
        }
        const url = buildEventsUrl(options.baseUrl, options.token, {
            ...subscription,
            sessionId: subscription.sessionId ?? undefined
        }, getVisibilityState(), lastEventIdRef.current)
        const eventSource = new EventSource(url)
        let disconnectNotified = false
        let reconnectRequested = false
        let sessionUpdateTimer: ReturnType<typeof setTimeout> | null = null
        let pendingSessionUpdates: SessionCacheEvent[] = []
        let flushPendingSessionUpdates = () => {}
        eventSourceRef.current = eventSource
        lastActivityAtRef.current = Date.now()

        const scheduleReconnect = () => {
            const attempt = reconnectAttemptRef.current
            const exponentialDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** attempt))
            const jitter = Math.floor(Math.random() * (RECONNECT_JITTER_MS + 1))
            reconnectAttemptRef.current = attempt + 1
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
            }
            reconnectTimerRef.current = setTimeout(() => {
                reconnectTimerRef.current = null
                setReconnectNonce((value) => value + 1)
            }, exponentialDelay + jitter)
        }

        const notifyDisconnect = (reason: string) => {
            if (disconnectNotified) {
                return
            }
            disconnectNotified = true
            onDisconnectRef.current?.(reason)
        }

        const requestReconnect = (reason: string) => {
            if (reconnectRequested) {
                return
            }
            reconnectRequested = true
            // The cursor already acknowledges transport receipt. Apply the
            // short UI batch before closing this source so the rebuilt stream
            // cannot start after an event that was never committed locally.
            flushPendingSessionUpdates()
            flushInvalidations()
            notifyDisconnect(reason)
            eventSource.close()
            if (eventSourceRef.current === eventSource) {
                eventSourceRef.current = null
            }
            setSubscriptionId(null)
            scheduleReconnect()
        }

        const flushInvalidations = () => {
            const pending = pendingInvalidationsRef.current
            if (!pending.sessions && !pending.machines && pending.sessionIds.size === 0) {
                return
            }

            const shouldInvalidateSessions = pending.sessions
            const shouldInvalidateMachines = pending.machines
            const sessionIds = Array.from(pending.sessionIds)

            pending.sessions = false
            pending.machines = false
            pending.sessionIds.clear()

            const tasks: Array<Promise<unknown>> = []
            if (shouldInvalidateSessions) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.sessions }))
            }
            for (const sessionId of sessionIds) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }))
            }
            if (shouldInvalidateMachines) {
                tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.machines }))
            }

            if (tasks.length === 0) {
                return
            }
            void Promise.all(tasks).catch(() => {})
        }

        const scheduleInvalidationFlush = () => {
            if (invalidationTimerRef.current) {
                return
            }
            invalidationTimerRef.current = setTimeout(() => {
                invalidationTimerRef.current = null
                flushInvalidations()
            }, INVALIDATION_BATCH_MS)
        }

        const queueSessionListInvalidation = () => {
            pendingInvalidationsRef.current.sessions = true
            scheduleInvalidationFlush()
        }

        const queueSessionDetailInvalidation = (sessionId: string) => {
            pendingInvalidationsRef.current.sessionIds.add(sessionId)
            scheduleInvalidationFlush()
        }

        const queueMachinesInvalidation = () => {
            pendingInvalidationsRef.current.machines = true
            scheduleInvalidationFlush()
        }

        const upsertSessionSummary = (session: Session) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const existingIndex = previous.sessions.findIndex((item) => item.id === session.id)
                const existing = existingIndex >= 0 ? previous.sessions[existingIndex] : undefined
                const summary = {
                    ...toSessionSummary(session),
                    futureScheduledMessageCount: existing?.futureScheduledMessageCount ?? 0,
                    nextScheduledAt: existing?.nextScheduledAt ?? null
                }
                const nextSessions = previous.sessions.slice()
                if (existingIndex >= 0) {
                    nextSessions[existingIndex] = summary
                } else {
                    nextSessions.push(summary)
                }
                nextSessions.sort(sortSessionSummaries)
                return { ...previous, sessions: nextSessions }
            })
        }

        const patchSessionSummary = (sessionId: string, patch: SessionPatch): boolean => {
            let patched = false
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }

                const nextSessions = previous.sessions.slice()
                const index = nextSessions.findIndex((item) => item.id === sessionId)
                if (index < 0) {
                    return previous
                }

                const current = nextSessions[index]
                if (!current) {
                    return previous
                }

                const nextSummary: SessionSummary = {
                    ...current,
                    active: patch.active ?? current.active,
                    thinking: patch.thinking ?? current.thinking,
                    activeAt: patch.activeAt ?? current.activeAt,
                    updatedAt: patch.updatedAt ?? current.updatedAt,
                    backgroundTaskCount: Object.prototype.hasOwnProperty.call(patch, 'backgroundTaskCount')
                        ? patch.backgroundTaskCount ?? 0
                        : current.backgroundTaskCount,
                    model: Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model ?? null : current.model,
                    effort: Object.prototype.hasOwnProperty.call(patch, 'effort') ? patch.effort ?? null : current.effort
                }

                patched = true
                nextSessions[index] = nextSummary
                nextSessions.sort(sortSessionSummaries)
                return { ...previous, sessions: nextSessions }
            })
            return patched
        }

        const patchSessionDetail = (sessionId: string, patch: SessionPatch): boolean => {
            let patched = false
            queryClient.setQueryData<SessionResponse | undefined>(queryKeys.session(sessionId), (previous) => {
                if (!previous?.session) {
                    return previous
                }
                patched = true
                return {
                    ...previous,
                    session: {
                        ...previous.session,
                        ...patch
                    }
                }
            })
            return patched
        }

        const removeSessionSummary = (sessionId: string) => {
            queryClient.setQueryData<SessionsResponse | undefined>(queryKeys.sessions, (previous) => {
                if (!previous) {
                    return previous
                }
                const nextSessions = previous.sessions.filter((item) => item.id !== sessionId)
                if (nextSessions.length === previous.sessions.length) {
                    return previous
                }
                return { ...previous, sessions: nextSessions }
            })
        }

        const upsertMachine = (machine: Machine) => {
            queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
                if (!previous) {
                    return previous
                }

                const nextMachines = previous.machines.slice()
                const index = nextMachines.findIndex((item) => item.id === machine.id)
                if (!machine.active) {
                    if (index >= 0) {
                        nextMachines.splice(index, 1)
                        return { ...previous, machines: nextMachines }
                    }
                    return previous
                }

                if (index >= 0) {
                    nextMachines[index] = machine
                } else {
                    nextMachines.push(machine)
                }
                return { ...previous, machines: nextMachines }
            })
        }

        const removeMachine = (machineId: string) => {
            queryClient.setQueryData<MachinesResponse | undefined>(queryKeys.machines, (previous) => {
                if (!previous) {
                    return previous
                }
                const nextMachines = previous.machines.filter((item) => item.id !== machineId)
                if (nextMachines.length === previous.machines.length) {
                    return previous
                }
                return { ...previous, machines: nextMachines }
            })
        }

        const applySessionCacheEvent = (event: SessionCacheEvent) => {
            if (event.type === 'session-removed') {
                removeSessionSummary(event.sessionId)
                void queryClient.removeQueries({ queryKey: queryKeys.session(event.sessionId) })
                clearMessageWindow(event.sessionId)
                return
            }

            if (isSessionRecord(event.data) && event.data.id === event.sessionId) {
                queryClient.setQueryData<SessionResponse>(queryKeys.session(event.sessionId), { session: event.data })
                upsertSessionSummary(event.data)
                return
            }

            const patch = getSessionPatch(event.data)
            if (patch) {
                const detailPatched = patchSessionDetail(event.sessionId, patch)
                const summaryPatched = patchSessionSummary(event.sessionId, patch)

                if (!detailPatched) {
                    queueSessionDetailInvalidation(event.sessionId)
                }
                if (!summaryPatched) {
                    queueSessionListInvalidation()
                }
            } else {
                queueSessionDetailInvalidation(event.sessionId)
                queueSessionListInvalidation()
            }
        }

        const flushSessionUpdates = (notify = true) => {
            if (eventSourceRef.current !== eventSource || pendingSessionUpdates.length === 0) {
                pendingSessionUpdates = []
                return
            }
            const updates = pendingSessionUpdates
            pendingSessionUpdates = []
            for (const update of updates) {
                applySessionCacheEvent(update)
                if (notify) onEventRef.current(update)
            }
        }
        flushPendingSessionUpdates = () => flushSessionUpdates(true)

        const queueSessionUpdate = (event: SessionCacheEvent) => {
            pendingSessionUpdates.push(event)
            if (sessionUpdateTimer !== null) return
            sessionUpdateTimer = setTimeout(() => {
                sessionUpdateTimer = null
                // One short batch replaces many whole-list sorts/renders while
                // preserving the exact event order. The interaction scheduler
                // lets an in-progress mobile tap finish before React work.
                scheduleBackgroundWork(flushPendingSessionUpdates)
            }, SESSION_UPDATE_BATCH_MS)
        }

        const handleSyncEvent = (event: SyncEvent) => {
            lastActivityAtRef.current = Date.now()

            if (event.type === 'heartbeat') {
                return
            }

            if (event.type === 'message-received' && isSkillsUpdateMessage(event)) {
                void queryClient.invalidateQueries({ queryKey: queryKeys.skills(event.sessionId) })
            }

            if (event.type === 'connection-changed') {
                const data = event.data
                if (data && typeof data === 'object' && 'subscriptionId' in data) {
                    const nextId = (data as { subscriptionId?: unknown }).subscriptionId
                    if (typeof nextId === 'string' && nextId.length > 0) {
                        setSubscriptionId(nextId)
                    }
                }
            }

            if (event.type === 'toast') {
                onToastRef.current?.(event)
                return
            }

            if (scope === 'global' && MESSAGE_STREAM_EVENT_TYPES.has(event.type)) {
                if (event.type === 'message-received' && event.message.scheduledAt != null) {
                    queueSessionListInvalidation()
                }
                if (
                    event.type === 'message-cancelled'
                    || event.type === 'messages-consumed'
                    || event.type === 'scheduled-matured'
                ) {
                    queueSessionListInvalidation()
                }
                // The global `all` subscription also receives message-stream events.
                // Session-scoped SSE normally drives the message window, but during
                // reconnect gaps or while another session is selected, only the global
                // connection may be alive — still clear the queued bar / optimistic rows.
                if (event.type === 'messages-consumed') {
                    markMessagesConsumed(event.sessionId, event.localIds, event.invokedAt)
                }
                if (event.type === 'message-cancelled') {
                    removeOptimisticMessage(event.sessionId, event.messageId)
                }
                onEventRef.current(event)
                return
            }

            if (event.type === 'messages-consumed') {
                markMessagesConsumed(event.sessionId, event.localIds, event.invokedAt)
            }

            if (event.type === 'message-cancelled') {
                // Remove the cancelled message from the store. If the local
                // optimistic removal already cleared it, this is a no-op.
                removeOptimisticMessage(event.sessionId, event.messageId)
            }

            if (event.type === 'message-received') {
                enqueueIncomingMessages(event.sessionId, [event.message])
            }

            if (event.type === 'session-added' || event.type === 'session-updated' || event.type === 'session-removed') {
                queueSessionUpdate(event)
                return
            }

            if (event.type === 'machine-updated') {
                if (isMachineRecord(event.data)) {
                    upsertMachine(event.data)
                } else if (event.data === null) {
                    removeMachine(event.machineId)
                } else {
                    const patch = getMachinePatch(event.data)
                    if (patch?.active === false) {
                        removeMachine(event.machineId)
                    } else {
                        queueMachinesInvalidation()
                    }
                }
                if (event.data === undefined) {
                    queueMachinesInvalidation()
                }
            }

            if (event.type === 'codex-session-updated') {
                publishNativeCodexSessionUpdated(event)
            }

            onEventRef.current(event)
        }

        const handleMessage = (message: MessageEvent<string>) => {
            if (eventSourceRef.current !== eventSource) {
                return
            }
            if (typeof message.lastEventId === 'string' && message.lastEventId.trim() !== '') {
                const eventId = Number(message.lastEventId)
                if (Number.isSafeInteger(eventId) && eventId >= 0) {
                    lastEventIdRef.current = eventId
                }
            }
            if (typeof message.data !== 'string') {
                return
            }

            let parsed: unknown
            try {
                parsed = JSON.parse(message.data)
            } catch {
                return
            }

            if (!isObject(parsed)) {
                return
            }
            if (typeof parsed.type !== 'string') {
                return
            }

            const event = parsed as SyncEvent
            // Token/message events already flow through the frame-batched
            // message store. Put every other server-driven cache update behind
            // a task boundary so it cannot steal a simultaneous tap/click.
            if (
                event.type === 'heartbeat'
                || event.type === 'message-received'
                || event.type === 'session-added'
                || event.type === 'session-updated'
                || event.type === 'session-removed'
            ) {
                handleSyncEvent(event)
            } else {
                scheduleBackgroundWork(() => {
                    if (eventSourceRef.current !== eventSource) return
                    handleSyncEvent(event)
                })
            }
        }

        eventSource.onmessage = handleMessage
        eventSource.onopen = () => {
            if (eventSourceRef.current !== eventSource) {
                return
            }
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
            reconnectAttemptRef.current = 0
            disconnectNotified = false
            lastActivityAtRef.current = Date.now()
            onConnectRef.current?.()
        }
        eventSource.onerror = (error) => {
            onErrorRef.current?.(error)
            // Safari/iOS PWA can leave EventSource in CONNECTING indefinitely
            // after a background transition. Close and rebuild it ourselves
            // instead of relying on the browser's opaque retry loop.
            if (eventSourceRef.current !== eventSource) {
                return
            }
            requestReconnect(eventSource.readyState === EventSource.CLOSED ? 'closed' : 'error')
        }

        const watchdogTimer = setInterval(() => {
            if (eventSourceRef.current !== eventSource) {
                return
            }
            if (getVisibilityState() === 'hidden') {
                return
            }
            if (Date.now() - lastActivityAtRef.current < HEARTBEAT_STALE_MS) {
                return
            }
            requestReconnect('heartbeat-timeout')
        }, HEARTBEAT_WATCHDOG_INTERVAL_MS)

        // iOS PWA can preserve a seemingly-open EventSource across a background
        // transition while silently dropping future events. Rebuild every stream
        // on foreground instead of waiting for its 90-second heartbeat watchdog.
        const onVisibilityChange = () => {
            if (getVisibilityState() !== 'visible') return
            if (eventSourceRef.current !== eventSource) return
            requestReconnect('visibility-recovery')
        }
        document.addEventListener('visibilitychange', onVisibilityChange)

        return () => {
            clearInterval(watchdogTimer)
            document.removeEventListener('visibilitychange', onVisibilityChange)
            // Commit cursor-acknowledged session events before this effect
            // discards its local queue. Skip App callbacks during unmount.
            flushSessionUpdates(false)
            flushInvalidations()
            if (sessionUpdateTimer !== null) {
                clearTimeout(sessionUpdateTimer)
                sessionUpdateTimer = null
            }
            pendingSessionUpdates = []
            if (invalidationTimerRef.current) {
                clearTimeout(invalidationTimerRef.current)
                invalidationTimerRef.current = null
            }
            pendingInvalidationsRef.current.sessions = false
            pendingInvalidationsRef.current.machines = false
            pendingInvalidationsRef.current.sessionIds.clear()
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current)
                reconnectTimerRef.current = null
            }
            eventSource.close()
            if (eventSourceRef.current === eventSource) {
                eventSourceRef.current = null
            }
            setSubscriptionId(null)
        }
    }, [options.baseUrl, options.enabled, options.reconnectKey, options.scope, options.token, scope, subscriptionKey, queryClient, reconnectNonce])

    return { subscriptionId }
}
