import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { useSessionPins, type SessionPinTarget } from './useSessionPins'
import { getInitialPinnedSessionKeys } from './useSessionListViewMode'

const managed: SessionPinTarget = { key: 'hapi:s1', source: { type: 'managed', sessionId: 's1' }, legacyKeys: ['hapi:s1'] }
const native: SessionPinTarget = { key: 'native:n1', source: { type: 'native-codex', machineId: 'm1', codexSessionId: 'n1' }, legacyKeys: [] }
const targets = [managed, native]

function wrapper() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => window.localStorage.clear())

describe('Hub-backed session pins', () => {
    it('acknowledges migrated tombstones without repinning or guessing legacy native machine IDs', async () => {
        localStorage.setItem('hapi-session-list-pinned-session-keys', JSON.stringify(['hapi:s1', 'native:n1']))
        const response = { pins: [{ source: managed.source, pinned: false }] }
        const api = { getSessionPins: vi.fn().mockResolvedValue(response), migrateSessionPins: vi.fn().mockResolvedValue(response) } as unknown as ApiClient
        const { result } = renderHook(() => useSessionPins(api, targets), { wrapper: wrapper() })
        await waitFor(() => expect(api.migrateSessionPins).toHaveBeenCalledWith([managed.source]))
        await waitFor(() => expect([...getInitialPinnedSessionKeys()]).toEqual(['native:n1']))
        expect([...result.current.pinnedSessionKeys]).toEqual([])
    })

    it('keeps legacy pins when migration is rejected or skipped by ownership checks', async () => {
        localStorage.setItem('hapi-session-list-pinned-session-keys', JSON.stringify(['hapi:s1']))
        const api = { getSessionPins: vi.fn().mockResolvedValue({ pins: [] }), migrateSessionPins: vi.fn().mockResolvedValue({ pins: [] }) } as unknown as ApiClient
        renderHook(() => useSessionPins(api, targets), { wrapper: wrapper() })
        await waitFor(() => expect(api.migrateSessionPins).toHaveBeenCalledOnce())
        expect([...getInitialPinnedSessionKeys()]).toEqual(['hapi:s1'])
    })

    it('waits for confirmed writes and preserves saved pins on network failure', async () => {
        const api = {
            getSessionPins: vi.fn().mockResolvedValue({ pins: [{ source: native.source, pinned: true }] }),
            setSessionPin: vi.fn().mockRejectedValue(new Error('Offline'))
        } as unknown as ApiClient
        const { result } = renderHook(() => useSessionPins(api, targets), { wrapper: wrapper() })
        await waitFor(() => expect(result.current.pinnedSessionKeys.has('native:n1')).toBe(true))
        act(() => result.current.togglePinnedSessionKey?.('native:n1'))
        await waitFor(() => expect(result.current.error?.message).toBe('Offline'))
        expect(api.setSessionPin).toHaveBeenCalledWith(native.source, false)
        expect(result.current.pinnedSessionKeys.has('native:n1')).toBe(true)
    })

    it('refetches other-device changes and partitions cache when switching authenticated clients', async () => {
        const first = { getSessionPins: vi.fn().mockResolvedValue({ pins: [{ source: managed.source, pinned: true }] }) } as unknown as ApiClient
        const second = { getSessionPins: vi.fn().mockResolvedValue({ pins: [] }) } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { result, rerender } = renderHook(({ api }) => useSessionPins(api, targets), {
            initialProps: { api: first },
            wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        })
        await waitFor(() => expect(result.current.pinnedSessionKeys.has('hapi:s1')).toBe(true))
        vi.mocked(first.getSessionPins).mockResolvedValue({ pins: [] })
        await act(() => queryClient.invalidateQueries({ queryKey: ['session-pins'] }))
        await waitFor(() => expect(result.current.pinnedSessionKeys.size).toBe(0))
        rerender({ api: second })
        expect(result.current.pinnedSessionKeys.size).toBe(0)
        await waitFor(() => expect(second.getSessionPins).toHaveBeenCalledOnce())
    })
})
