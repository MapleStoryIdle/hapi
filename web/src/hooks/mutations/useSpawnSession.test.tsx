import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { Session } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import type { ApiClient } from '@/api/client'
import { useSpawnSession } from './useSpawnSession'

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

describe('useSpawnSession', () => {
    it('seeds the spawned session detail cache with selected model and reasoning', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        const session: Session = {
            id: 'session-1',
            namespace: 'default',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: { path: '/work/project', host: 'localhost', flavor: 'codex' },
            metadataVersion: 1,
            agentState: { controlledByUser: false },
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            model: 'gpt-5.5',
            modelReasoningEffort: 'xhigh',
            effort: null,
            serviceTier: null,
            permissionMode: 'yolo',
            collaborationMode: 'default',
        }
        const spawnSession = vi.fn(async () => ({
            type: 'success' as const,
            sessionId: session.id,
            session,
        }))
        const api = { spawnSession } as unknown as ApiClient

        const { result } = renderHook(
            () => useSpawnSession(api),
            { wrapper: createWrapper(queryClient) },
        )

        await act(async () => {
            await result.current.spawnSession({
                machineId: 'machine-1',
                directory: '/work/project',
                agent: 'codex',
                model: 'gpt-5.5',
                modelReasoningEffort: 'xhigh',
            })
        })

        expect(spawnSession).toHaveBeenCalledWith(
            'machine-1',
            '/work/project',
            'codex',
            'gpt-5.5',
            'xhigh',
            undefined,
            undefined,
            undefined,
            undefined,
        )
        await waitFor(() => {
            expect(queryClient.getQueryData(queryKeys.session(session.id))).toEqual({ session })
        })
    })

    it('shares concurrent creates with the same session configuration', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
        })
        let resolveSpawn: (value: { type: 'success'; sessionId: string }) => void = () => {
            throw new Error('Spawn did not start')
        }
        const spawnSession = vi.fn(() => new Promise<{ type: 'success'; sessionId: string }>((resolve) => {
            resolveSpawn = resolve
        }))
        const api = { spawnSession } as unknown as ApiClient
        const input = {
            machineId: 'machine-1',
            directory: '/work/project',
            agent: 'codex' as const,
            model: 'gpt-5.6-sol',
        }

        const { result } = renderHook(
            () => useSpawnSession(api),
            { wrapper: createWrapper(queryClient) },
        )

        const first = result.current.spawnSession(input)
        const second = result.current.spawnSession(input)

        await waitFor(() => {
            expect(spawnSession).toHaveBeenCalledTimes(1)
        })
        resolveSpawn({ type: 'success', sessionId: 'session-1' })
        await act(async () => {
            await Promise.all([first, second])
        })
    })
})
