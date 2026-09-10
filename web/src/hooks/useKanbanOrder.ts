import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { sessionGroupsClientKey } from './useSessionGroups'
import { mergeVisibleKanbanOrder, type KanbanOrder } from '@hapi/protocol/kanbanOrder'

export function kanbanOrderQueryKey(api: ApiClient) {
    return ['kanban-order', sessionGroupsClientKey(api)[1]] as const
}

export function useKanbanOrder(api: ApiClient, enabled: boolean) {
    const client = useQueryClient()
    const key = kanbanOrderQueryKey(api)
    const query = useQuery({ queryKey: key, queryFn: () => api.getKanbanOrder(), enabled: enabled && Boolean(api.getKanbanOrder), staleTime: 30_000 })
    const [pending, setPending] = useState<{ api: ApiClient; state: KanbanOrder } | null>(null)
    const inFlight = useRef(false)
    const saving = pending?.api === api
    const save = async (order: string[], revision: number, reset = false) => {
        if (inFlight.current) return
        inFlight.current = true
        const current = client.getQueryData<KanbanOrder>(key)
        setPending({ api, state: { order: reset ? order : mergeVisibleKanbanOrder(current?.order ?? order, order), revision } })
        try {
            await client.cancelQueries({ queryKey: key })
            const result = await api.setKanbanOrder({ order, revision, reset })
            client.setQueryData(key, result)
            void client.invalidateQueries({ queryKey: key })
        } catch (error) {
            // Refetch even after a timeout: the Hub may already have saved it.
            await client.invalidateQueries({ queryKey: key })
            throw error
        } finally {
            inFlight.current = false
            setPending(null)
        }
    }
    return { ...query, data: saving ? pending.state : query.data, saving, save }
}
