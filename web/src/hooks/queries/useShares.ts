import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useShares(api: ApiClient | null, baseUrl: string, namespace: string) {
    const query = useQuery({
        queryKey: queryKeys.shares(baseUrl, namespace),
        enabled: Boolean(api),
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
