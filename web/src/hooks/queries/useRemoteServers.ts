import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useRemoteServers(api: ApiClient | null, enabled = true) {
    const query = useQuery({
        queryKey: queryKeys.remoteServers,
        enabled: Boolean(api) && enabled,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getRemoteServers()
        },
    })

    return {
        servers: query.data?.servers ?? [],
        isLoading: query.isLoading,
        error: query.error,
        refetch: query.refetch,
    }
}

export function useRemoteServerCandidates(api: ApiClient | null, enabled = true) {
    const query = useQuery({
        queryKey: queryKeys.remoteServerCandidates,
        enabled: Boolean(api) && enabled,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getRemoteServerCandidates()
        },
    })

    return {
        candidates: query.data?.candidates ?? [],
        isLoading: query.isLoading,
        error: query.error,
        refetch: query.refetch,
    }
}
