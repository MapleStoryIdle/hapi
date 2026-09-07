import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeCodexSessionControlResponse, NativeCodexSessionControls } from '@hapi/protocol/codexSessionControl'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { queryKeys } from '@/lib/query-keys'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { useNativeCodexSessionControls } from './useNativeCodexSessionControls'

afterEach(cleanup)

const controls: NativeCodexSessionControls = {
    canStop: true, canConfigure: true, configuration: {}, queuePaused: false
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

function setup(controlCodexSession = vi.fn()) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const api = { controlCodexSession } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
            <I18nProvider><ToastProvider>{children}</ToastProvider></I18nProvider>
        </QueryClientProvider>
    )
    const hook = renderHook(({ sessionId }) => ({
        ...useNativeCodexSessionControls({ api, machineId: 'machine', sessionId,
            status: { success: true, status: 'processing', activeTurnId: 'turn-1', controls } }),
        toasts: useToast().toasts
    }), { wrapper, initialProps: { sessionId: 'session-a' } })
    return { ...hook, client, controlCodexSession }
}

describe('native session controls', () => {
    it('explains shared configuration limits without sending a control request', () => {
        const hook = setup()
        act(() => hook.result.current.explainSharedConfiguration())
        expect(hook.result.current.toasts[0]).toMatchObject({
            kind: 'info', title: 'This session is controlled by Desktop or SSH. Change its model settings there.'
        })
        expect(hook.controlCodexSession).not.toHaveBeenCalled()
    })

    it('serializes settings mutations and patches only the matching snapshot without adding a poll', async () => {
        const request = deferred<NativeCodexSessionControlResponse>()
        const hook = setup(vi.fn(() => request.promise))
        const queryKey = queryKeys.codexSessionSnapshot('machine', 'session-a')
        hook.client.setQueryData(queryKey, { status: { success: true, status: 'processing', controls }, messages: ['kept'] })
        act(() => {
            hook.result.current.configure({ modelReasoningEffort: 'high' })
            hook.result.current.configure({ serviceTier: 'fast' })
        })
        expect(hook.controlCodexSession).toHaveBeenCalledTimes(1)
        expect(hook.result.current.pendingAction).toBe('configure')
        await act(async () => request.resolve({ success: true, controls: { ...controls, configuration: { modelReasoningEffort: 'high' } } }))
        await waitFor(() => expect(hook.result.current.pendingAction).toBeNull())
        expect(hook.client.getQueryData(queryKey)).toMatchObject({
            status: { controls: { configuration: { modelReasoningEffort: 'high' } } }, messages: ['kept']
        })
        expect(hook.result.current.toasts[0]?.kind).toBe('info')
        expect(hook.client.getQueryCache().getAll()).toHaveLength(1)
    })

    it('does not claim an uncertain interrupt failed or automatically retry it', async () => {
        const hook = setup(vi.fn().mockRejectedValue(new ApiError('raw backend detail', 502, 'control_unconfirmed')))
        await act(async () => { await hook.result.current.stop() })
        expect(hook.result.current.pendingAction).toBeNull()
        expect(hook.controlCodexSession).toHaveBeenCalledTimes(1)
        expect(hook.result.current.toasts[0]).toMatchObject({
            kind: 'warning', title: 'The operation is not confirmed yet. Refresh the session status before trying again.'
        })
        expect(hook.result.current.toasts[0]?.title).not.toContain('raw backend detail')
    })

    it('keeps pending requests scoped when navigating away and back', async () => {
        const first = deferred<NativeCodexSessionControlResponse>()
        const second = deferred<NativeCodexSessionControlResponse>()
        const hook = setup(vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise))
        act(() => { hook.result.current.configure({ model: 'model-a' }) })
        hook.rerender({ sessionId: 'session-b' })
        expect(hook.result.current.pendingAction).toBeNull()
        act(() => { hook.result.current.configure({ model: 'model-b' }) })
        hook.rerender({ sessionId: 'session-a' })
        expect(hook.result.current.pendingAction).toBe('configure')
        act(() => { hook.result.current.configure({ model: 'duplicate' }) })
        expect(hook.controlCodexSession).toHaveBeenCalledTimes(2)
        await act(async () => second.resolve({ success: true, controls }))
        expect(hook.result.current.pendingAction).toBe('configure')
        expect(hook.result.current.toasts).toEqual([])
        await act(async () => first.resolve({ success: true, controls }))
        await waitFor(() => expect(hook.result.current.pendingAction).toBeNull())
    })
})
