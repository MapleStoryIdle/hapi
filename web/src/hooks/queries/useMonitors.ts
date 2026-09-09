import { useQuery } from '@tanstack/react-query'
import type { Monitor, MonitorDetail } from '@hapi/protocol/monitoring'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

const MONITOR_POLL_INTERVAL_MS = 30_000

function visiblePollInterval(): number | false {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return false
    }
    return MONITOR_POLL_INTERVAL_MS
}

/** Scoped to the mounted monitor route; it never becomes an app-wide poller. */
export function useMonitors(api: ApiClient | null): {
    monitors: Monitor[]
    isLoading: boolean
    error: Error | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.monitors,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMonitors()
        },
        enabled: Boolean(api),
        refetchInterval: visiblePollInterval,
        refetchIntervalInBackground: false,
    })

    return {
        monitors: query.data?.monitors ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
        refetch: query.refetch,
    }
}

export function useMonitor(api: ApiClient | null, monitorId: string): {
    monitor: MonitorDetail | null
    isLoading: boolean
    error: Error | null
    refetch: () => Promise<unknown>
} {
    const query = useQuery({
        queryKey: queryKeys.monitor(monitorId),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMonitor(monitorId)
        },
        enabled: Boolean(api && monitorId),
        refetchInterval: visiblePollInterval,
        refetchIntervalInBackground: false,
    })

    return {
        monitor: query.data?.monitor ?? null,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error : query.error ? new Error(String(query.error)) : null,
        refetch: query.refetch,
    }
}
