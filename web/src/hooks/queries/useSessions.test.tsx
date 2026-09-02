import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from './useSessions'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper(props: { children: ReactNode }) {
        return (
            <QueryClientProvider client={queryClient}>
                {props.children}
            </QueryClientProvider>
        )
    }
}

describe('useSessions live query lifecycle', () => {
    it('cold-loads a passive observer once and ignores later invalidations', async () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false, staleTime: 0 }
            }
        })
        const getSessions = vi.fn(async () => ({ sessions: [] }))
        const api = { getSessions } as unknown as ApiClient

        const { result } = renderHook(
            () => useSessions(api, { live: false }),
            { wrapper: createWrapper(queryClient) }
        )

        await waitFor(() => {
            expect(result.current.isLoading).toBe(false)
            expect(getSessions).toHaveBeenCalledTimes(1)
        })

        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        })

        expect(getSessions).toHaveBeenCalledTimes(1)
    })
})
