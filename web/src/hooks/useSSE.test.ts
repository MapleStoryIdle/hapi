import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetInteractionPriorityForTests } from '@/lib/interaction-priority'
import { subscribeNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'
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

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })
    return ({ children }: { children: ReactNode }) => (
        createElement(QueryClientProvider, { client: queryClient }, children)
    )
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
