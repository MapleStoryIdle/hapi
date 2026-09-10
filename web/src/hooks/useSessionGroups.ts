import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionGroupSource, SessionGroupsResponse } from '@hapi/protocol/sessionGroups'

export const sessionGroupsQueryKey = ['session-groups'] as const
const clientScopes = new WeakMap<ApiClient, number>()
let nextClientScope = 1

// Auth source changes replace the client; token refreshes retain it. Partition
// cached names without storing a credential in React Query's visible keys.
export function sessionGroupsClientKey(api: ApiClient | null | undefined) {
    if (!api) return [...sessionGroupsQueryKey, 0] as const
    let scope = clientScopes.get(api)
    if (scope === undefined) {
        scope = nextClientScope++
        clientScopes.set(api, scope)
    }
    return [...sessionGroupsQueryKey, scope] as const
}

export function sessionGroupSourceKey(source: SessionGroupSource): string {
    return source.type === 'managed'
        ? JSON.stringify(['managed', source.sessionId])
        : JSON.stringify(['native-codex', source.machineId, source.codexSessionId])
}

export function resolveSessionGroup(data: SessionGroupsResponse | undefined, source: SessionGroupSource, nativeAlias?: SessionGroupSource | null) {
    if (!data) return undefined
    const key = sessionGroupSourceKey(source)
    const assignment = data.assignments.find(item => sessionGroupSourceKey(item.source) === key)
        ?? (nativeAlias ? data.assignments.find(item => sessionGroupSourceKey(item.source) === sessionGroupSourceKey(nativeAlias)) : undefined)
    return data.groups.find(group => group.id === assignment?.groupId)
}

export function useSessionGroups(api: ApiClient | null | undefined) {
    return useQuery({
        queryKey: sessionGroupsClientKey(api),
        queryFn: () => api!.getSessionGroups(),
        enabled: Boolean(api?.getSessionGroups),
        staleTime: 30_000
    })
}
