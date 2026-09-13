import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionLabelSource, SessionLabelsResponse } from '@hapi/protocol/sessionLabels'
import { sessionGroupSourceKey } from './useSessionGroups'

export const sessionLabelsQueryKey = ['session-labels'] as const
const clientScopes = new WeakMap<ApiClient, number>()
let nextClientScope = 1

export function sessionLabelsClientKey(api: ApiClient | null | undefined) {
    if (!api) return [...sessionLabelsQueryKey, 0] as const
    let scope = clientScopes.get(api)
    if (scope === undefined) {
        scope = nextClientScope++
        clientScopes.set(api, scope)
    }
    return [...sessionLabelsQueryKey, scope] as const
}

export function resolveSessionLabel(data: SessionLabelsResponse | undefined, source: SessionLabelSource, nativeAlias?: SessionLabelSource | null) {
    if (!data) return undefined
    const key = sessionGroupSourceKey(source)
    return data.labels.find(item => sessionGroupSourceKey(item.source) === key)?.label
        ?? (nativeAlias ? data.labels.find(item => sessionGroupSourceKey(item.source) === sessionGroupSourceKey(nativeAlias))?.label : undefined)
}

export function useSessionLabels(api: ApiClient | null | undefined) {
    return useQuery({
        queryKey: sessionLabelsClientKey(api),
        queryFn: () => api!.getSessionLabels(),
        enabled: Boolean(api?.getSessionLabels),
        staleTime: 30_000
    })
}
