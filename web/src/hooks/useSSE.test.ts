import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { markUserInteraction, resetInteractionPriorityForTests } from '@/lib/interaction-priority'
import { subscribeNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'
import { queryKeys } from '@/lib/query-keys'
import type { SessionSummary, SessionsResponse } from '@/types/api'
import { isGlobalScopedMessageStreamEvent, useSSE } from './useSSE'

class MockEventSource {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    static instances: MockEventSource[] = []

    readonly url: string
    readyState = MockEventSource.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    readonly close = vi.fn(() => {
        this.readyState = MockEventSource.CLOSED
    })

    constructor(url: string) {
        this.url = url
        MockEventSource.instances.push(this)
    }
}

const eventSourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
const visibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')

function restoreEventSource(): void {
    if (eventSourceDescriptor) {
        Object.defineProperty(globalThis, 'EventSource', eventSourceDescriptor)
        return
    }
    delete (globalThis as { EventSource?: unknown }).EventSource
}

function setVisibilityState(value: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
        value,
        configurable: true
    })
}

function restoreVisibilityState(): void {
    if (visibilityStateDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityStateDescriptor)
        return
    }
    delete (document as { visibilityState?: unknown }).visibilityState
}

function createQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })
}

function createWrapper(queryClient = createQueryClient()) {
    return ({ children }: { children: ReactNode }) => (
        createElement(QueryClientProvider, { client: queryClient }, children)
    )
}

function makeSessionSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: true,
        thinking: false,
        activeAt: 1,
        updatedAt: 1,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

afterEach(() => {
    cleanup()
    resetInteractionPriorityForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
    MockEventSource.instances = []
    restoreEventSource()
    restoreVisibilityState()
})

describe('useSSE scope handling', () => {
    it('treats message stream events as global-scoped skips', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'message-received')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'messages-consumed')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'message-cancelled')).toBe(true)
        expect(isGlobalScopedMessageStreamEvent('global', 'scheduled-matured')).toBe(true)
    })

    it('does not skip session lifecycle events on the global connection', () => {
        expect(isGlobalScopedMessageStreamEvent('global', 'session-updated')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-added')).toBe(false)
        expect(isGlobalScopedMessageStreamEvent('global', 'session-removed')).toBe(false)
    })

    it('processes message stream events on full-scoped connections', () => {
        expect(isGlobalScopedMessageStreamEvent('full', 'message-received')).toBe(false)
    })
})

describe('useSSE skills updates', () => {
    it('invalidates session skills when a skills update message arrives', () => {
        Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true })
        const invalidateQueries = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
        renderHook(() => useSSE({ enabled: true, token: 'test-token', baseUrl: 'http://hub.test', subscription: { sessionId: 'session-1' }, scope: 'full', onEvent: vi.fn() }), { wrapper: createWrapper() })
        act(() => {
            MockEventSource.instances[0]?.onmessage?.({
                data: JSON.stringify({ type: 'message-received', sessionId: 'session-1', message: {
                    id: 'message-1', seq: 1, localId: null, createdAt: 1,
                    content: { type: 'codex', data: { type: 'codex-session-event', eventType: 'skills_update_available' } }
                } }), lastEventId: '1'
            } as MessageEvent<string>)
        })
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['skills', 'session-1'] })
    })
})

describe('useSSE pin updates', () => {
    it.each([['session-pins-updated', 'session-pins'], ['kanban-order-updated', 'kanban-order']] as const)('invalidates %s on the global connection while another session is selected', async (type, key) => {
        Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true })
        const invalidateQueries = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
        renderHook(() => useSSE({ enabled: true, token: 'test-token', baseUrl: 'http://hub.test', subscription: { sessionId: 'other-session' }, scope: 'global', onEvent: vi.fn() }), { wrapper: createWrapper() })
        act(() => {
            MockEventSource.instances[0]?.onmessage?.({
                data: JSON.stringify({ type, namespace: 'default' }), lastEventId: '1'
            } as MessageEvent<string>)
        })
        await waitFor(() => expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [key] }))
    })
})

describe('useSSE reconnect handling', () => {
    it('actively rebuilds an EventSource that errors while still connecting', () => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const onDisconnect = vi.fn()

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn(),
            onDisconnect
        }), { wrapper: createWrapper() })

        const source = MockEventSource.instances[0]
        expect(source).toBeDefined()

        act(() => {
            source?.onerror?.(new Event('error'))
        })

        expect(source?.close).toHaveBeenCalledTimes(1)
        expect(onDisconnect).toHaveBeenCalledWith('error')

        act(() => {
            vi.advanceTimersByTime(1_000)
        })

        expect(MockEventSource.instances).toHaveLength(2)
    })

    it('rebuilds the stream when the app returns to the foreground', () => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        setVisibilityState('visible')

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), { wrapper: createWrapper() })

        const source = MockEventSource.instances[0]
        expect(source).toBeDefined()

        act(() => {
            setVisibilityState('hidden')
            setVisibilityState('visible')
            document.dispatchEvent(new Event('visibilitychange'))
        })

        expect(source?.close).toHaveBeenCalledTimes(1)

        act(() => {
            vi.advanceTimersByTime(1_000)
        })

        expect(MockEventSource.instances).toHaveLength(2)
    })

    it('carries the last SSE event id into a manually rebuilt stream', () => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), { wrapper: createWrapper() })

        const source = MockEventSource.instances[0]
        expect(source).toBeDefined()

        act(() => {
            source?.onmessage?.({
                data: JSON.stringify({ type: 'heartbeat', data: { timestamp: Date.now() } }),
                lastEventId: '7'
            } as MessageEvent<string>)
            source?.onerror?.(new Event('error'))
            vi.advanceTimersByTime(1_000)
        })

        expect(MockEventSource.instances[1]?.url).toContain('lastEventId=7')
    })

    it('accepts low event ids after the Hub stream epoch changes', () => {
        vi.useFakeTimers()
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const onEvent = vi.fn()

        const { rerender } = renderHook(({ reconnectKey }: { reconnectKey: number }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            reconnectKey,
            subscription: { all: true },
            scope: 'global',
            onEvent
        }), {
            initialProps: { reconnectKey: 0 },
            wrapper: createWrapper()
        })

        const firstSource = MockEventSource.instances[0]
        act(() => {
            firstSource?.onmessage?.({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: { status: 'connected', streamEpoch: 'hub-a' }
                }),
                lastEventId: ''
            } as MessageEvent<string>)
            firstSource?.onmessage?.({
                data: JSON.stringify({ type: 'heartbeat', data: { timestamp: 1 } }),
                lastEventId: '100'
            } as MessageEvent<string>)
            rerender({ reconnectKey: 1 })
        })

        const secondSource = MockEventSource.instances[1]
        expect(secondSource?.url).toContain('lastEventId=100')
        expect(secondSource?.url).toContain('lastStreamEpoch=hub-a')
        act(() => {
            secondSource?.onmessage?.({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: { status: 'connected', streamEpoch: 'hub-b' }
                }),
                lastEventId: ''
            } as MessageEvent<string>)
            secondSource?.onmessage?.({
                data: JSON.stringify({
                    type: 'session-updated',
                    sessionId: 'session-1',
                    data: { thinking: true }
                }),
                lastEventId: '1'
            } as MessageEvent<string>)
            vi.advanceTimersByTime(100)
        })

        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'session-updated',
            sessionId: 'session-1'
        }))
        rerender({ reconnectKey: 2 })
        expect(MockEventSource.instances[2]?.url).toContain('lastEventId=1')
        expect(MockEventSource.instances[2]?.url).toContain('lastStreamEpoch=hub-b')
    })

    it('reconnects from cursor zero when a new Hub disconnects before its first event', () => {
        vi.useFakeTimers()
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })

        const { rerender } = renderHook(({ reconnectKey }: { reconnectKey: number }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            reconnectKey,
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), {
            initialProps: { reconnectKey: 0 },
            wrapper: createWrapper()
        })

        const firstSource = MockEventSource.instances[0]
        act(() => {
            firstSource?.onmessage?.({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: { status: 'connected', streamEpoch: 'hub-a' }
                }),
                lastEventId: ''
            } as MessageEvent<string>)
            firstSource?.onmessage?.({
                data: JSON.stringify({ type: 'heartbeat', data: { timestamp: 1 } }),
                lastEventId: '100'
            } as MessageEvent<string>)
            rerender({ reconnectKey: 1 })
        })

        const restartedSource = MockEventSource.instances[1]
        act(() => {
            restartedSource?.onmessage?.({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: { status: 'connected', streamEpoch: 'hub-b' }
                }),
                lastEventId: ''
            } as MessageEvent<string>)
            rerender({ reconnectKey: 2 })
        })

        expect(MockEventSource.instances[2]?.url).toContain('lastEventId=0')
        expect(MockEventSource.instances[2]?.url).toContain('lastStreamEpoch=hub-b')
    })

    it('does not replay pre-subscription history after a fresh epoch marker', () => {
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })

        const { rerender } = renderHook(({ reconnectKey }: { reconnectKey: number }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            reconnectKey,
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), {
            initialProps: { reconnectKey: 0 },
            wrapper: createWrapper()
        })

        act(() => {
            MockEventSource.instances[0]?.onmessage?.({
                data: JSON.stringify({
                    type: 'connection-changed',
                    data: { status: 'connected', streamEpoch: 'hub-a' }
                }),
                lastEventId: ''
            } as MessageEvent<string>)
            rerender({ reconnectKey: 1 })
        })

        expect(MockEventSource.instances[1]?.url).not.toContain('lastEventId=')
        expect(MockEventSource.instances[1]?.url).not.toContain('lastStreamEpoch=')
    })

    it('dispatches a deferred event before a replacement stream acknowledges it', () => {
        vi.useFakeTimers()
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const listener = vi.fn()
        const unsubscribe = subscribeNativeCodexSessionUpdated(listener)

        const { rerender } = renderHook(({ reconnectKey }: { reconnectKey: number }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            reconnectKey,
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), {
            initialProps: { reconnectKey: 0 },
            wrapper: createWrapper()
        })

        const firstSource = MockEventSource.instances[0]
        act(() => {
            markUserInteraction()
            firstSource?.onmessage?.({
                data: JSON.stringify({
                    type: 'codex-session-updated',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1'
                }),
                lastEventId: '9'
            } as MessageEvent<string>)
            rerender({ reconnectKey: 1 })
        })

        expect(listener).toHaveBeenCalledTimes(1)
        expect(MockEventSource.instances[1]?.url).toContain('lastEventId=9')

        act(() => {
            vi.advanceTimersByTime(250)
        })

        expect(listener).toHaveBeenCalledTimes(1)
        unsubscribe()
    })

    it('does not let a later immediate event skip an earlier deferred event', () => {
        vi.useFakeTimers()
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const nativeListener = vi.fn()
        const onEvent = vi.fn()
        const unsubscribe = subscribeNativeCodexSessionUpdated(nativeListener)

        const { rerender } = renderHook(({ reconnectKey }: { reconnectKey: number }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            reconnectKey,
            subscription: { all: true },
            scope: 'global',
            onEvent
        }), {
            initialProps: { reconnectKey: 0 },
            wrapper: createWrapper()
        })

        const source = MockEventSource.instances[0]
        act(() => {
            markUserInteraction()
            source?.onmessage?.({
                data: JSON.stringify({
                    type: 'codex-session-updated',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1'
                }),
                lastEventId: '10'
            } as MessageEvent<string>)
            source?.onmessage?.({
                data: JSON.stringify({ type: 'heartbeat', data: { timestamp: 1 } }),
                lastEventId: '11'
            } as MessageEvent<string>)
        })

        expect(nativeListener).not.toHaveBeenCalled()
        act(() => {
            vi.advanceTimersByTime(250)
        })

        expect(nativeListener).toHaveBeenCalledTimes(1)
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex-session-updated' }))
        rerender({ reconnectKey: 1 })
        expect(MockEventSource.instances[1]?.url).toContain('lastEventId=11')
        unsubscribe()
    })

    it('applies a session update queued behind deferred work before reconnecting', () => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const queryClient = createQueryClient()
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [makeSessionSummary({ id: 'session-1' })]
        })

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), { wrapper: createWrapper(queryClient) })

        const source = MockEventSource.instances[0]
        act(() => {
            markUserInteraction()
            source?.onmessage?.({
                data: JSON.stringify({
                    type: 'codex-session-updated',
                    machineId: 'machine-1',
                    codexSessionId: 'thread-1'
                }),
                lastEventId: '12'
            } as MessageEvent<string>)
            source?.onmessage?.({
                data: JSON.stringify({
                    type: 'session-updated',
                    sessionId: 'session-1',
                    data: { thinking: true, updatedAt: 2 }
                }),
                lastEventId: '13'
            } as MessageEvent<string>)
            source?.onerror?.(new Event('error'))
        })

        expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0]).toMatchObject({
            thinking: true,
            updatedAt: 2
        })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        expect(MockEventSource.instances[1]?.url).toContain('lastEventId=13')
    })

    it('rebuilds immediately when the operator requests a reconnect', () => {
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })

        const { rerender } = renderHook(({ reconnectKey }: { reconnectKey: number }) => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            reconnectKey,
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), {
            initialProps: { reconnectKey: 0 },
            wrapper: createWrapper()
        })

        const source = MockEventSource.instances[0]
        expect(source).toBeDefined()

        rerender({ reconnectKey: 1 })

        expect(source?.close).toHaveBeenCalledTimes(1)
        expect(MockEventSource.instances).toHaveLength(2)
    })
})

describe('useSSE native Codex session events', () => {
    it('publishes a native session invalidation received from SSE', () => {
        vi.useFakeTimers()
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const listener = vi.fn()
        const unsubscribe = subscribeNativeCodexSessionUpdated(listener)

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), { wrapper: createWrapper() })

        const event = {
            type: 'codex-session-updated' as const,
            machineId: 'machine-1',
            codexSessionId: 'c2dbc948-4075-4ac0-a9b9-896bd0901fec',
            modifiedAt: 1_234
        }

        act(() => {
            MockEventSource.instances[0]?.onmessage?.({
                data: JSON.stringify(event),
                lastEventId: '1'
            } as MessageEvent<string>)
            vi.advanceTimersByTime(0)
        })

        expect(listener).toHaveBeenCalledWith(event)
        unsubscribe()
    })
})

describe('useSSE session update batching', () => {
    it('applies bursty session patches together after the short interaction window', () => {
        vi.useFakeTimers()
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const queryClient = createQueryClient()
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [makeSessionSummary({ id: 'session-1' })]
        })

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), { wrapper: createWrapper(queryClient) })

        act(() => {
            for (const [lastEventId, data] of [
                ['1', { thinking: true, updatedAt: 2 }],
                ['2', { active: false, updatedAt: 3 }]
            ] as const) {
                MockEventSource.instances[0]?.onmessage?.({
                    data: JSON.stringify({ type: 'session-updated', sessionId: 'session-1', data }),
                    lastEventId
                } as MessageEvent<string>)
            }
            vi.advanceTimersByTime(0)
        })

        expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0]).toMatchObject({
            active: true,
            thinking: false,
            updatedAt: 1
        })

        act(() => {
            vi.advanceTimersByTime(80)
            vi.advanceTimersByTime(1)
        })

        expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0]).toMatchObject({
            active: false,
            thinking: true,
            updatedAt: 3
        })
    })

    it('flushes a cursor-acknowledged session update before reconnecting', () => {
        vi.useFakeTimers()
        vi.spyOn(Math, 'random').mockReturnValue(0)
        Object.defineProperty(globalThis, 'EventSource', {
            value: MockEventSource,
            configurable: true,
            writable: true
        })
        const queryClient = createQueryClient()
        queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
            sessions: [makeSessionSummary({ id: 'session-1' })]
        })

        renderHook(() => useSSE({
            enabled: true,
            token: 'test-token',
            baseUrl: 'http://hub.test',
            subscription: { all: true },
            scope: 'global',
            onEvent: vi.fn()
        }), { wrapper: createWrapper(queryClient) })

        const source = MockEventSource.instances[0]
        act(() => {
            source?.onmessage?.({
                data: JSON.stringify({
                    type: 'session-updated',
                    sessionId: 'session-1',
                    data: { thinking: true, updatedAt: 2 }
                }),
                lastEventId: '8'
            } as MessageEvent<string>)
            source?.onerror?.(new Event('error'))
        })

        expect(source?.close).toHaveBeenCalledOnce()
        expect(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions[0]).toMatchObject({
            thinking: true,
            updatedAt: 2
        })
    })
})
