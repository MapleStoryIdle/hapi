import { useEffect, useRef } from 'react'
import type { CodexUsageAccount } from '@hapi/protocol/codexUsage'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { CodexSubscriptionLimits } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { sessionGroupsClientKey } from '../useSessionGroups'

const CODEX_SUBSCRIPTION_LIMITS_MIN_REFETCH_INTERVAL_MS = 5 * 60 * 1000

export function useCodexSubscriptionLimits(args: {
    api: ApiClient | null
    sessionId?: string | null
    machineId?: string | null
    model?: string | null
    enabled?: boolean
    thinking?: boolean
    cwd?: string | null
    provider?: string | null
}): {
    limits: CodexSubscriptionLimits | null
    isLoading: boolean
    isFetching: boolean
    error: string | null
    account: CodexUsageAccount | null
    refresh: () => void
} {
    const { api, sessionId, machineId } = args
    const model = args.model ?? null
    const thinking = args.thinking === true
    const enabled = Boolean(args.enabled && api && (sessionId || machineId))
    const clientKey = api ? sessionGroupsClientKey(api)[1] : 'none'
    const query = useQuery({
        queryKey: sessionId
            ? [...queryKeys.sessionCodexSubscriptionLimits(sessionId, model), args.provider ?? '', clientKey]
            : [...queryKeys.machineCodexSubscriptionLimits(machineId ?? 'unknown', model), args.cwd ?? '', args.provider ?? '', clientKey],
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            if (sessionId) {
                return await api.getSessionCodexSubscriptionLimits(sessionId)
            }
            if (machineId) {
                return await api.getMachineCodexSubscriptionLimits(machineId, model, args.cwd, args.provider)
            }
            throw new Error('Codex target unavailable')
        },
        enabled,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
        retry: false
    })

    const prevThinkingRef = useRef(thinking)
    useEffect(() => {
        prevThinkingRef.current = thinking
    }, [machineId, sessionId, model])

    useEffect(() => {
        if (enabled && prevThinkingRef.current && !thinking) {
            const lastUpdatedAt = query.dataUpdatedAt || 0
            const shouldRefetch = Date.now() - lastUpdatedAt >= CODEX_SUBSCRIPTION_LIMITS_MIN_REFETCH_INTERVAL_MS
            if (shouldRefetch) {
                void query.refetch()
            }
        }
        prevThinkingRef.current = thinking
    }, [enabled, thinking, query, machineId, sessionId, model])

    return {
        account: query.data?.account ?? null,
        refresh: () => { void query.refetch() },
        limits: query.data?.limits ?? null,
        isLoading: query.isLoading,
        isFetching: query.isFetching,
        error: query.data?.success === false
            ? (query.data.error ?? 'Failed to read Codex subscription limits')
            : query.error instanceof Error
                ? query.error.message
                : query.error
                    ? 'Failed to read Codex subscription limits'
                    : null
    }
}
