import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useSessions(
    api: ApiClient | null,
    options: { live?: boolean } = {}
): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const live = options.live !== false
    const hasCachedSessions = queryClient.getQueryData(queryKeys.sessions) !== undefined
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.getSessions()
        },
        // A hidden mobile sidebar and SessionChat's side-session picker keep a
        // cache observer only. If the cache is empty they may cold-load once;
        // afterwards SSE cache patches remain visible without invalidation-
        // driven REST reads. The visible index/desktop sidebar stays live.
        enabled: Boolean(api && (live || !hasCachedSessions)),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
