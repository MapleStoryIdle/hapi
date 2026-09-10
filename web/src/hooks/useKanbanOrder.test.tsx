import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { kanbanOrderQueryKey, useKanbanOrder } from './useKanbanOrder'

afterEach(cleanup)
describe('Hub Kanban order cache', () => {
    it('partitions accounts and keeps hidden slots while saving', async () => {
        const old = { order: ['pending', 'custom:empty', 'recent'], revision: 0 }
        let server = old
        let finish!: (value: typeof old) => void
        const api = { getKanbanOrder: vi.fn(async () => server), setKanbanOrder: vi.fn(() => new Promise<typeof old>(resolve => { finish = resolve })) } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
        const { result } = renderHook(() => useKanbanOrder(api, true), { wrapper })
        await waitFor(() => expect(result.current.data).toEqual(old))
        let saved!: Promise<void>
        act(() => { saved = result.current.save(['recent', 'pending'], 0) })
        await waitFor(() => expect(api.setKanbanOrder).toHaveBeenCalled())
        expect(result.current.data?.order).toEqual(['recent', 'custom:empty', 'pending'])
        act(() => client.setQueryData(kanbanOrderQueryKey(api), old))
        expect(result.current.data?.order).toEqual(['recent', 'custom:empty', 'pending'])
        server = { order: ['recent', 'custom:empty', 'pending'], revision: 1 }
        await act(async () => { finish(server); await saved })
        expect(result.current.saving).toBe(false)
        expect(result.current.data).toEqual(server)
        expect(kanbanOrderQueryKey({} as ApiClient)).not.toEqual(kanbanOrderQueryKey(api))
    })
    it('restores authoritative state on failed writes', async () => {
        const state = { order: ['pending', 'recent'], revision: 0 }
        const api = { getKanbanOrder: vi.fn(async () => state), setKanbanOrder: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const { result } = renderHook(() => useKanbanOrder(api, true), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
        await waitFor(() => expect(result.current.data).toEqual(state))
        await act(async () => { await expect(result.current.save(['recent', 'pending'], 0)).rejects.toThrow('offline') })
        expect(result.current.data).toEqual(state)
        expect(result.current.saving).toBe(false)
    })
})
