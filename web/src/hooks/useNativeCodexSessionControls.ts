import { useCallback, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { NativeCodexSessionConfiguration, NativeCodexSessionControlAction } from '@hapi/protocol/codexSessionControl'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexLocalSessionSnapshotResponse, CodexLocalSessionStatusResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'

/** Controls share the existing snapshot/SSE; no extra polling loop. */
export function useNativeCodexSessionControls(args: {
    api: ApiClient
    sessionId: string
    machineId?: string
    status?: CodexLocalSessionStatusResponse
}) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const queryClient = useQueryClient()
    const scope = `${args.machineId}:${args.sessionId}`
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const pendingRef = useRef(new Map<string, NativeCodexSessionControlAction['action']>())
    const [pending, setPending] = useState(pendingRef.current)
    const controls = args.status?.success ? args.status.controls : undefined
    const pendingAction = pending.get(scope) ?? null

    const apply = useCallback(async (action: NativeCodexSessionControlAction) => {
        if (!args.machineId || pendingRef.current.has(scope)) return
        const requestScope = scope
        const queryKey = queryKeys.codexSessionSnapshot(args.machineId, args.sessionId)
        pendingRef.current = new Map(pendingRef.current).set(requestScope, action.action)
        setPending(pendingRef.current)
        try {
            const result = await args.api.controlCodexSession(args.sessionId, args.machineId, action)
            if (!result.success) throw new ApiError(result.error, 409, result.code)
            // An old in-flight snapshot must not undo the acknowledged settings.
            await queryClient.cancelQueries({ queryKey, exact: true })
            queryClient.setQueryData<CodexLocalSessionSnapshotResponse>(queryKey, (current) => current ? {
                ...current,
                status: { ...current.status, controls: result.controls }
            } : current)
            if (scopeRef.current === requestScope && action.action === 'configure') {
                addToast({ kind: 'info', title: t('recentCodex.control.nextTurn') })
            }
        } catch (error) {
            if (scopeRef.current === requestScope) {
                const code = error instanceof ApiError ? error.code : undefined
                const messageKey = code === 'turn_changed' ? 'recentCodex.control.turnChanged'
                    : code === 'configuration_unsupported' ? 'recentCodex.control.sharedConfiguration'
                        : code === 'unsupported' ? 'recentCodex.control.unsupported'
                            : code === 'control_busy' ? 'recentCodex.control.busy'
                                : code === 'invalid_request' ? 'recentCodex.control.invalidConfiguration'
                                    : 'recentCodex.control.unconfirmed'
                addToast({ kind: 'warning', title: t(messageKey) })
            }
        } finally {
            pendingRef.current = new Map(pendingRef.current)
            pendingRef.current.delete(requestScope)
            setPending(pendingRef.current)
            void queryClient.invalidateQueries({ queryKey, exact: true })
        }
    }, [addToast, args.api, args.machineId, args.sessionId, queryClient, scope, t])

    const stop = useCallback(async () => {
        if (!controls?.canStop || !args.status?.success || !args.status.activeTurnId) return
        await apply({ action: 'stop', expectedTurnId: args.status.activeTurnId })
    }, [apply, args.status, controls?.canStop])
    const configure = useCallback((configuration: NativeCodexSessionConfiguration) => {
        if (!controls?.canConfigure) return
        void apply({ action: 'configure', configuration })
    }, [apply, controls?.canConfigure])
    const resumeQueue = useCallback(() => { void apply({ action: 'resumeQueue' }) }, [apply])
    const explainSharedConfiguration = useCallback(() => {
        addToast({ kind: 'info', title: t('recentCodex.control.sharedConfiguration') })
    }, [addToast, t])

    return { controls, pendingAction, stop, configure, resumeQueue, explainSharedConfiguration }
}
