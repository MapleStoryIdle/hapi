import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionPinSource } from '@hapi/protocol/sessionPins'
import { sessionGroupsClientKey, sessionGroupSourceKey } from './useSessionGroups'
import { getInitialPinnedSessionKeys, removeMigratedPinnedSessionKeys } from './useSessionListViewMode'

export type SessionPinTarget = { key: string; source: SessionPinSource; legacyKeys: string[] }

export function useSessionPins(api: ApiClient | null | undefined, targets: SessionPinTarget[]) {
    const queryClient = useQueryClient()
    const queryKey = ['session-pins', sessionGroupsClientKey(api)[1]] as const
    const enabled = Boolean(api?.getSessionPins)
    const query = useQuery({ queryKey, queryFn: () => api!.getSessionPins(), enabled, staleTime: 30_000 })
    const targetSignature = targets.map(target => sessionGroupSourceKey(target.source)).sort().join('\n')
    const previousTargets = useRef(targetSignature)
    useEffect(() => {
        if (previousTargets.current === targetSignature) return
        previousTargets.current = targetSignature
        // A managed session can acquire its native thread ID after pinning.
        // Re-read so the Hub can move its saved pin to that stable identity.
        if (enabled) void queryClient.invalidateQueries({ queryKey })
    }, [targetSignature, enabled, queryClient, api])
    const migrationAttempts = useRef(new WeakMap<ApiClient, Set<string>>())
    const migration = useMutation({
        mutationFn: (sources: SessionPinSource[]) => api!.migrateSessionPins(sources),
        onSuccess: () => queryClient.invalidateQueries({ queryKey })
    })
    const mutation = useMutation({
        mutationFn: (input: { source: SessionPinSource; pinned: boolean }) => api!.setSessionPin(input.source, input.pinned),
        onSuccess: () => queryClient.invalidateQueries({ queryKey })
    })
    useEffect(() => {
        if (!api || !enabled || !query.isSuccess || migration.isPending) return
        let attempted = migrationAttempts.current.get(api)
        if (!attempted) {
            attempted = new Set()
            migrationAttempts.current.set(api, attempted)
        }
        const legacy = getInitialPinnedSessionKeys()
        const matches = targets.filter(target => !attempted.has(sessionGroupSourceKey(target.source))
            && target.legacyKeys.some(key => legacy.has(key))).slice(0, 500)
        if (!matches.length) return
        for (const target of matches) attempted.add(sessionGroupSourceKey(target.source))
        migration.mutate(matches.map(target => target.source), {
            onSuccess: data => {
                const acknowledged = new Set(data.pins.map(pin => sessionGroupSourceKey(pin.source)))
                removeMigratedPinnedSessionKeys(matches.filter(target => acknowledged.has(sessionGroupSourceKey(target.source)))
                    .flatMap(target => target.legacyKeys))
            }
        })
    }, [api, enabled, query.isSuccess, targets, migration.isPending, migration.mutate])
    const pinnedSessionKeys = useMemo(() => {
        const pins = new Set(query.data?.pins.filter(pin => pin.pinned).map(pin => sessionGroupSourceKey(pin.source)))
        return new Set(targets.filter(target => pins.has(sessionGroupSourceKey(target.source))).map(target => target.key))
    }, [query.data, targets])
    return {
        enabled,
        pinnedSessionKeys,
        error: mutation.error ?? migration.error ?? query.error,
        togglePinnedSessionKey: query.isSuccess && !mutation.isPending ? (key: string) => {
            const target = targets.find(item => item.key === key)
            if (target) mutation.mutate({ source: target.source, pinned: !pinnedSessionKeys.has(key) })
        } : undefined
    }
}
