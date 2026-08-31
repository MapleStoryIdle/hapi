import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useShares(api: ApiClient | null, baseUrl: string, namespace: string) {
    const query = useQuery({
        queryKey: queryKeys.shares(baseUrl, namespace),
        enabled: Boolean(api),
        // External Agents post feedback directly to the public ingress, so
        // there is no authenticated browser mutation to invalidate this list.
        // Keep the Kanban board fresh while it is open without introducing a
        // global SSE event for a small, non-chat feature.
        refetchInterval: 10_000,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getShares()
        }
    })

    return {
        shares: query.data?.shares ?? [],
        isLoading: query.isLoading,
        error: query.error,
        refetch: query.refetch
    }
}
