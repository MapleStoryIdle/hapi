import { useCallback, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentFlavor } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SpawnResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

type SpawnInput = {
    machineId: string
    directory: string
    agent?: AgentFlavor
    model?: string
    effort?: string
    modelReasoningEffort?: string
    yolo?: boolean
    sessionType?: 'simple' | 'worktree'
    worktreeName?: string
}

function getSpawnRequestKey(input: SpawnInput): string {
    return JSON.stringify([
        input.machineId,
        input.directory,
        input.agent,
        input.model,
        input.effort,
        input.modelReasoningEffort,
        input.yolo,
        input.sessionType,
        input.worktreeName
    ])
}

export function useSpawnSession(api: ApiClient | null): {
    spawnSession: (input: SpawnInput) => Promise<SpawnResponse>
    isPending: boolean
    error: string | null
} {
    const queryClient = useQueryClient()
    const pendingRequestsRef = useRef(new Map<string, Promise<SpawnResponse>>())

    const mutation = useMutation({
        mutationFn: async (input: SpawnInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.spawnSession(
                input.machineId,
                input.directory,
                input.agent,
                input.model,
                input.modelReasoningEffort,
                input.yolo,
                input.sessionType,
                input.worktreeName,
                input.effort
            )
        },
        onSuccess: (result) => {
            if (result.type === 'success' && result.session) {
                queryClient.setQueryData(queryKeys.session(result.sessionId), { session: result.session })
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    const spawnSession = useCallback((input: SpawnInput): Promise<SpawnResponse> => {
        const key = getSpawnRequestKey(input)
        const existing = pendingRequestsRef.current.get(key)
        if (existing) {
            return existing
        }

        const request = mutation.mutateAsync(input)
        pendingRequestsRef.current.set(key, request)
        void request.then(
            () => {
                if (pendingRequestsRef.current.get(key) === request) {
                    pendingRequestsRef.current.delete(key)
                }
            },
            () => {
                if (pendingRequestsRef.current.get(key) === request) {
                    pendingRequestsRef.current.delete(key)
                }
            }
        )
        return request
    }, [mutation.mutateAsync])

    return {
        spawnSession,
        isPending: mutation.isPending,
        error: mutation.error instanceof Error ? mutation.error.message : mutation.error ? 'Failed to spawn session' : null,
    }
}
