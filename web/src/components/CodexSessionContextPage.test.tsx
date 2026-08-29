import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeCodexRealtimeProvider } from '@/lib/native-codex-realtime-context'
import { publishNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'
import { ApiError, type ApiClient } from '@/api/client'
import type { CodexLocalSessionContextMessage, CodexLocalSessionContextResponse, CodexLocalSessionSnapshotResponse } from '@/types/api'
import {
    buildReadOnlyCodexBlocks,
    CodexSessionContextPage,
    deriveNativeSessionConnectionHealth,
    getNativeContextRefreshInterval,
    getVisibleNativeDirectMessageEchoes,
    mergeCodexContextMessages
} from './CodexSessionContextPage'

afterEach(() => {
    cleanup()
    sessionStorage.clear()
    vi.restoreAllMocks()
})

function createApi() {
    const getCodexSessionContext = vi.fn(async (_sessionId: string, _machineId: string, _options: { before?: number; limit?: number } = {}) => ({
        success: true as const,
        session: {
            id: 'codex-thread-1',
            title: 'Recent Codex task',
            cwd: '/workspace/project',
            modifiedAt: Date.now(),
            model: 'gpt-5.6-terra',
            modelReasoningEffort: 'high'
        },
        page: { limit: 50, nextBefore: null, hasMore: false },
        messages: [
            {
                id: 'codex-local:codex-thread-1:0',
                createdAt: 0,
                content: {
                    role: 'user' as const,
                    content: { type: 'text', text: 'Original prompt' }
                }
            },
            {
                id: 'codex-local:codex-thread-1:1',
                createdAt: 1,
                content: {
                    role: 'agent' as const,
                    content: { type: 'codex', data: { type: 'message', message: 'Original response' } }
                }
            }
        ]
    }))
    const getCodexSessionStatus = vi.fn(async (_sessionId: string, _machineId: string) => ({
        success: true as const,
        status: 'idle' as const
    }))
    return {
        getCodexSessionContext,
        getCodexSessionStatus,
        getCodexSessionSnapshot: vi.fn(async (sessionId: string, machineId: string, options: { before?: number; limit?: number }) => ({
            ...(await getCodexSessionContext(sessionId, machineId, options)),
            status: await getCodexSessionStatus(sessionId, machineId),
            revision: 1,
            timing: { cache: 'hit' as const, durationMs: 1 }
        })),
        getMachineCodexSubscriptionLimits: vi.fn(async () => ({
            success: true as const,
            limits: {
                limitId: 'codex',
                limitName: 'Codex',
                planType: 'plus',
                primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null },
                secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: null },
                updatedAt: Date.now()
            }
        })),
        sendCodexSessionMessage: vi.fn(async () => ({
            success: true as const,
            status: 'processing' as const,
            startedAt: Date.now()
        })),
        forkCodexSession: vi.fn(async () => ({
            type: 'success' as const,
            sessionId: 'new-hapi-session'
        }))
    } as unknown as ApiClient
}

function renderPage(props: {
    api?: ApiClient
    onBack?: () => void
    onForked?: (sessionId: string) => void
    realtimeAvailable?: boolean
    realtimeConnected?: boolean
} = {}) {
    const api = props.api ?? createApi()
    const onBack = props.onBack ?? vi.fn()
    const onForked = props.onForked ?? vi.fn()
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })

    const page = (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <CodexSessionContextPage
                    api={api}
                    sessionId="codex-thread-1"
                    machineId="machine-1"
                    realtimeAvailable={props.realtimeAvailable}
                    onBack={onBack}
                    onForked={onForked}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
    const rendered = render(props.realtimeConnected === undefined
        ? page
        : (
            <NativeCodexRealtimeProvider value={{ connected: props.realtimeConnected }}>
                {page}
            </NativeCodexRealtimeProvider>
        ))

    return { api, onBack, onForked, unmount: rendered.unmount }
}

function openNativeSessionMenu() {
    fireEvent.click(screen.getByTestId('codex-native-session-menu-trigger'))
}

describe('CodexSessionContextPage', () => {
    it('uses a faster native fallback refresh cadence while a turn is running', () => {
        expect(getNativeContextRefreshInterval({ success: true, status: 'processing' })).toBe(1_000)
        expect(getNativeContextRefreshInterval({ success: true, status: 'idle' })).toBe(5_000)
    })

    it('merges overlapping native context pages in transcript order', () => {
        const page = (messages: CodexLocalSessionContextMessage[]): CodexLocalSessionContextResponse => ({
            success: true,
            session: {
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                cwd: '/workspace/project',
                modifiedAt: 3
            },
            messages,
            page: { limit: 50, nextBefore: null, hasMore: false }
        })
        const message = (id: string, position: number, text: string): CodexLocalSessionContextMessage => ({
            id,
            position,
            createdAt: position,
            content: { role: 'user', content: { type: 'text', text } }
        })

        expect(mergeCodexContextMessages([
            page([message('m-0', 0, 'old'), message('m-1', 1, 'stale')]),
            page([message('m-1', 1, 'fresh'), message('m-2', 2, 'new')])
        ])).toEqual([
            message('m-0', 0, 'old'),
            message('m-1', 1, 'fresh'),
            message('m-2', 2, 'new')
        ])
    })

    it('keeps a direct-send echo until a new matching transcript entry arrives', () => {
        const userMessage = (id: string, position: number, text: string): CodexLocalSessionContextMessage => ({
            id,
            createdAt: 1,
            position,
            content: { role: 'user', content: { type: 'text', text } }
        })
        const echo = {
            id: 'native-local-1',
            text: 'Continue',
            createdAt: 2,
            status: 'sending' as const,
            queueId: null,
            observedTranscriptMessageIds: ['old-continue'],
            observedThroughPosition: 3
        }

        expect(getVisibleNativeDirectMessageEchoes([echo], [userMessage('old-continue', 2, 'Continue')]))
            .toEqual([echo])
        expect(getVisibleNativeDirectMessageEchoes([echo], [
            userMessage('old-continue', 2, 'Continue'),
            userMessage('new-continue', 4, 'Continue')
        ])).toEqual([])
    })

    it('derives a compact connection state from native context freshness', () => {
        expect(deriveNativeSessionConnectionHealth({
            machineAvailable: true,
            recovering: false,
            contextAvailable: true,
            contextError: false,
            contextUpdatedAt: 10_000,
            statusAvailable: true,
            statusError: false,
            statusUpdatedAt: 10_000,
            now: 10_500
        })).toBe('connected')

        expect(deriveNativeSessionConnectionHealth({
            machineAvailable: true,
            recovering: false,
            contextAvailable: true,
            contextError: false,
            contextUpdatedAt: 1_000,
            statusAvailable: true,
            statusError: false,
            statusUpdatedAt: 10_000,
            now: 14_000
        })).toBe('degraded')

        expect(deriveNativeSessionConnectionHealth({
            machineAvailable: true,
            recovering: false,
            contextAvailable: false,
            contextError: true,
            contextUpdatedAt: 0,
            statusAvailable: true,
            statusError: false,
            statusUpdatedAt: 10_000,
            now: 10_000
        })).toBe('degraded')

        expect(deriveNativeSessionConnectionHealth({
            machineAvailable: true,
            recovering: false,
            contextAvailable: false,
            contextError: true,
            contextUpdatedAt: 0,
            statusAvailable: false,
            statusError: true,
            statusUpdatedAt: 0,
            now: 10_000
        })).toBe('offline')

        expect(deriveNativeSessionConnectionHealth({
            machineAvailable: true,
            recovering: false,
            contextAvailable: true,
            contextError: false,
            contextUpdatedAt: 1_000,
            statusAvailable: true,
            statusError: false,
            statusUpdatedAt: 1_000,
            realtimeConnected: true,
            now: 100_000
        })).toBe('connected')
    })

    it('keeps the native connection control in recovery while the first reads are pending', () => {
        expect(deriveNativeSessionConnectionHealth({
            machineAvailable: true,
            recovering: true,
            contextAvailable: true,
            contextError: false,
            contextUpdatedAt: 10_000,
            statusAvailable: true,
            statusError: false,
            statusUpdatedAt: 10_000,
            now: 10_500
        })).toBe('recovering')
    })

    it('renders the native transcript through the normal conversation thread with a direct-send composer', async () => {
        const { api, onBack } = renderPage()

        await waitFor(() => {
            expect(screen.getByText('Original response')).toBeInTheDocument()
        })

        // 详情页读取 runner 上的原始上下文，并仅在原生会话确认空闲时开放直发。
        expect(api.getCodexSessionSnapshot).toHaveBeenCalledWith('codex-thread-1', 'machine-1', { limit: 50 })
        expect(screen.getByText('Original prompt')).toBeInTheDocument()
        expect(screen.getByRole('textbox')).toBeInTheDocument()
        // Fork is deliberately kept in the single right-hand action menu,
        // leaving header room for the live Codex quota badge.
        expect(screen.queryByRole('button', { name: 'Fork to new session' })).toBeNull()
        openNativeSessionMenu()
        expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).toBeInTheDocument()
        // 正常会话也以 user-text / agent-text 线程节点渲染两端消息。
        expect(screen.getByText('Original prompt').closest('[id^="hapi-message-user-text:"]')).not.toBeNull()
        expect(screen.getByText('Original response').closest('[id^="hapi-message-agent-text:"]')).not.toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('refreshes the open native transcript when its runner publishes an invalidation', async () => {
        const { api } = renderPage({ realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        const snapshotCallsBefore = (api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1'
        })

        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThan(snapshotCallsBefore)
        })
    })

    it('applies a bounded native realtime snapshot without another runner read', async () => {
        const { api } = renderPage({ realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        const snapshotCallsBefore = (api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                revision: 2,
                status: { success: true, status: 'idle' },
                timing: { cache: 'miss', durationMs: 2 },
                session: {
                    id: 'codex-thread-1',
                    title: 'Recent Codex task',
                    cwd: '/workspace/project',
                    modifiedAt: 2,
                    model: 'gpt-5.6-terra',
                    modelReasoningEffort: 'high'
                },
                importedMessages: [
                    {
                        createdAt: 0,
                        role: 'user',
                        content: { type: 'text', text: 'Original prompt' },
                        meta: { sentFrom: 'cli' }
                    },
                    {
                        createdAt: 2,
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'Pushed without polling' } },
                        meta: { sentFrom: 'cli' }
                    }
                ],
                startIndex: 0,
                page: { limit: 50, nextBefore: null, hasMore: false }
            }
        })

        expect(await screen.findByText('Pushed without polling')).toBeInTheDocument()
        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                revision: 2,
                status: { success: true, status: 'processing' },
                timing: { cache: 'hit', durationMs: 0 }
            }
        })
        openNativeSessionMenu()
        await waitFor(() => {
            expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).toBeDisabled()
        })
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
            .toBe(snapshotCallsBefore)
    })

    it('does not let an in-flight snapshot overwrite a newer realtime page', async () => {
        const api = createApi()
        const staleSnapshot: CodexLocalSessionSnapshotResponse = {
            success: true,
            session: {
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                cwd: '/workspace/project',
                modifiedAt: 1,
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high'
            },
            messages: [
                {
                    id: 'codex-local:codex-thread-1:0',
                    createdAt: 0,
                    content: {
                        role: 'user',
                        content: { type: 'text', text: 'Original prompt' }
                    }
                },
                {
                    id: 'codex-local:codex-thread-1:1',
                    createdAt: 1,
                    content: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'Original response' } }
                    }
                }
            ],
            page: { limit: 50, nextBefore: null, hasMore: false },
            status: { success: true, status: 'idle' },
            revision: 1,
            timing: { cache: 'hit', durationMs: 1 }
        }
        let resolveSnapshot!: (response: CodexLocalSessionSnapshotResponse) => void
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<CodexLocalSessionSnapshotResponse>((resolve) => {
            resolveSnapshot = resolve
        }))
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        await waitFor(() => expect(api.getCodexSessionSnapshot).toHaveBeenCalled())
        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                revision: 2,
                status: { success: true, status: 'idle' },
                timing: { cache: 'miss', durationMs: 2 },
                session: {
                    id: 'codex-thread-1',
                    title: 'Recent Codex task',
                    cwd: '/workspace/project',
                    modifiedAt: 2,
                    model: 'gpt-5.6-terra',
                    modelReasoningEffort: 'high'
                },
                importedMessages: [
                    {
                        createdAt: 0,
                        role: 'user',
                        content: { type: 'text', text: 'Original prompt' },
                        meta: { sentFrom: 'cli' }
                    },
                    {
                        createdAt: 2,
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'Realtime wins' } },
                        meta: { sentFrom: 'cli' }
                    }
                ],
                startIndex: 0,
                page: { limit: 50, nextBefore: null, hasMore: false }
            }
        })

        expect(await screen.findByText('Realtime wins')).toBeInTheDocument()
        await act(async () => {
            resolveSnapshot(staleSnapshot)
        })
        await waitFor(() => {
            expect(screen.getByText('Realtime wins')).toBeInTheDocument()
            expect(screen.queryByText('Original response')).toBeNull()
        })
    })

    it('sends directly to the native Codex thread instead of forking it', async () => {
        const { api } = renderPage()

        await screen.findByText('Original response')
        const input = screen.getByRole('textbox')
        fireEvent.change(input, { target: { value: 'Continue the original thread' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                message: 'Continue the original thread'
            })
        })
        expect(api.forkCodexSession).not.toHaveBeenCalled()
    })

    it('shows the native prompt immediately while the direct request is still in flight', async () => {
        const api = createApi()
        let resolveSend!: (value: { success: true; status: 'processing'; startedAt: number }) => void
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
            resolveSend = resolve
        }))
        renderPage({ api })

        await screen.findByText('Original response')
        const input = screen.getByRole('textbox')
        fireEvent.change(input, { target: { value: 'Show this right away' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalled()
        })
        expect(await screen.findByText('Show this right away')).toBeInTheDocument()
        expect(screen.getByRole('status', { name: 'Sending' })).toBeInTheDocument()

        await act(async () => {
            resolveSend({ success: true, status: 'processing', startedAt: Date.now() })
        })
        expect(await screen.findByRole('status', { name: 'Queued' })).toBeInTheDocument()
    })

    it('keeps a native prompt visible after leaving and reopening the session', async () => {
        const api = createApi()
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}))
        const firstPage = renderPage({ api })

        await screen.findByText('Original response')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this after leaving' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        expect(await screen.findByText('Keep this after leaving')).toBeInTheDocument()
        firstPage.unmount()

        renderPage({ api })
        expect(await screen.findByText('Keep this after leaving')).toBeInTheDocument()
    })

    it('accepts another native prompt while the first hand-off is pending', async () => {
        const api = createApi()
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}))
        renderPage({ api })

        await screen.findByText('Original response')
        const input = screen.getByRole('textbox')
        fireEvent.change(input, { target: { value: 'First hand-off' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(api.sendCodexSessionMessage).toHaveBeenCalledTimes(1))

        fireEvent.change(input, { target: { value: 'Second hand-off' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(api.sendCodexSessionMessage).toHaveBeenCalledTimes(2))
    })

    it('keeps direct-send available and locks only Fork while the native thread is processing', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing'
        })
        renderPage({ api })

        await screen.findByText('Original response')
        openNativeSessionMenu()
        await waitFor(() => {
            expect(screen.getByRole('textbox')).not.toBeDisabled()
            expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).toBeDisabled()
        })
        expect(screen.queryByText('Native Codex is running')).toBeNull()
        expect(screen.queryByTestId('codex-status-processing')).toBeNull()
    })

    it('sends a prompt while processing so the runner can queue it', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing'
        })
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'queued',
            queueId: 'queued-1',
            queuedAt: 123,
            queuedMessages: [{ id: 'queued-1', text: 'Queue this prompt', queuedAt: 123 }]
        })
        renderPage({ api })

        await screen.findByText('Original response')
        const input = screen.getByRole('textbox')
        await waitFor(() => expect(input).not.toBeDisabled())
        fireEvent.change(input, { target: { value: 'Queue this prompt' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                message: 'Queue this prompt'
            })
        })
        expect(await screen.findByRole('button', { name: 'Open 1 queued messages' })).toBeInTheDocument()
    })

    it('keeps a confirmed queue visible while a status refresh has not published it yet', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
            // Return a fresh response without the optional queue field on
            // every poll, matching an older runner or its short propagation
            // window after accepting a queued prompt.
            success: true as const,
            status: 'processing' as const
        }))
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true as const,
            status: 'queued' as const,
            queueId: 'queued-1',
            queuedAt: 123,
            queuedMessages: [{ id: 'queued-1', text: 'Keep this visible', queuedAt: 123 }]
        })
        renderPage({ api })

        await screen.findByText('Original response')
        const input = screen.getByRole('textbox')
        await waitFor(() => expect(input).not.toBeDisabled())
        fireEvent.change(input, { target: { value: 'Keep this visible' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        expect(await screen.findByRole('button', { name: 'Open 1 queued messages' })).toBeInTheDocument()
    })

    it('shows native queued messages in a compact accessory and drawer', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            queuedMessages: [{ id: 'queued-1', text: 'Wait for the current turn', queuedAt: 123 }]
        })
        renderPage({ api })

        await screen.findByText('Original response')
        const trigger = await screen.findByRole('button', { name: 'Open 1 queued messages' })
        expect(trigger).toBeInTheDocument()
        expect(trigger).toHaveTextContent('Wait for the current turn')
        openNativeSessionMenu()
        expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).toBeDisabled()

        fireEvent.click(trigger)
        const drawer = await screen.findByTestId('native-queued-messages-drawer')
        expect(drawer).toBeInTheDocument()
        expect(drawer).toHaveTextContent('Wait for the current turn')
    })

    it('uses the normal session title details popover', async () => {
        renderPage()

        await screen.findByText('Original response')
        fireEvent.click(screen.getByRole('button', { name: 'Recent Codex task' }))

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
        expect(screen.getByText('Full name')).toBeInTheDocument()
        expect(screen.getByText('codex-thread-1')).toBeInTheDocument()
        expect(screen.getByText('/workspace/project')).toBeInTheDocument()
        expect(screen.getByText('codex')).toBeInTheDocument()
        expect(screen.getByText('Model:')).toBeInTheDocument()
        expect(screen.getByText('gpt-5.6-terra')).toBeInTheDocument()
        expect(screen.getByText('Reasoning:')).toBeInTheDocument()
        expect(screen.getByText('high')).toBeInTheDocument()
    })

    it('uses the shared capability-scoped header menu without HAPI-only actions', async () => {
        const { api } = renderPage()

        await screen.findByText('Original response')
        openNativeSessionMenu()

        expect(screen.getByRole('menuitem', { name: 'Refresh' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Conversation outline' })).toBeInTheDocument()
        expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: /Archive/ })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull()

        const snapshotCallsBeforeRefresh = (api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length
        fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThan(snapshotCallsBeforeRefresh)
        })
    })

    it('shows the native runner Codex quota in the header', async () => {
        const { api } = renderPage()

        await screen.findByText('Original response')
        const quota = await screen.findByRole('button', { name: /Codex subscription limits:/ })

        expect(quota).toHaveTextContent('5h')
        expect(quota).toHaveTextContent('80%')
        expect(quota).toHaveTextContent('7d')
        expect(quota).toHaveTextContent('50%')
        expect(api.getMachineCodexSubscriptionLimits).toHaveBeenCalledWith('machine-1', 'gpt-5.6-terra')
    })


    it('shows native context loading as an inline refreshing chat bubble', () => {
        const api = createApi()
        let resolveContext: (() => void) | undefined
        const getContext = api.getCodexSessionContext as ReturnType<typeof vi.fn>
        getContext.mockImplementationOnce(() => new Promise((resolve) => {
            resolveContext = () => resolve({
                success: true,
                session: { id: 'codex-thread-1', title: 'Recent Codex task', cwd: '/workspace/project', modifiedAt: Date.now() },
                messages: [],
                page: { limit: 50, nextBefore: null, hasMore: false }
            })
        }))

        renderPage({ api })

        const loading = screen.getByTestId('codex-session-context-loading')
        expect(loading).toHaveClass('items-end')
        expect(loading).toHaveAttribute('aria-busy', 'true')
        expect(screen.getByRole('status', { name: 'Loading context…' })).toBe(loading)
        const bubble = screen.getByTestId('codex-session-context-typing')
        expect(bubble).toHaveClass('animate-bounce-in')
        expect(bubble.querySelectorAll('[data-loading-line]')).toHaveLength(2)
        expect(bubble.querySelectorAll('[class*="animate-pulse"]')).toHaveLength(2)
        expect(screen.queryByTestId('codex-session-context-loading-status')).toBeNull()
        expect(loading.querySelector('.animate-spin')).toBeNull()
        resolveContext?.()
    })

    it('shows the shared recovery control when native context reads fail', async () => {
        const api = createApi()
        const getSnapshot = api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>
        getSnapshot.mockRejectedValue(new Error('runner unavailable'))
        renderPage({ api })

        const control = await screen.findByTestId('session-connection-recovery')
        await waitFor(() => expect(control).not.toBeDisabled())
        expect(control.getAttribute('title')).toContain('Native session unavailable · Refresh native session')

        const callsBeforeRecovery = getSnapshot.mock.calls.length
        fireEvent.click(control)
        await waitFor(() => expect(getSnapshot.mock.calls.length).toBeGreaterThan(callsBeforeRecovery))
    })

    it('loads the previous context page when scrolling above the transcript', async () => {
        const clock = vi.spyOn(Date, 'now')
        clock.mockReturnValue(0)
        const api = {
            getCodexSessionContext: vi.fn(async (_sessionId: string, _machineId: string, options: { before?: number; limit?: number }) => (
                options.before === 1
                    ? {
                        success: true as const,
                        session: { id: 'codex-thread-1', title: 'Recent Codex task', cwd: '/workspace/project', modifiedAt: 1 },
                        messages: [{
                            id: 'codex-local:codex-thread-1:0',
                            createdAt: 0,
                            content: { role: 'user' as const, content: { type: 'text', text: 'Older prompt' } }
                        }],
                        page: { limit: 50, nextBefore: null, hasMore: false }
                    }
                    : {
                        success: true as const,
                        session: { id: 'codex-thread-1', title: 'Recent Codex task', cwd: '/workspace/project', modifiedAt: 1 },
                        messages: [{
                            id: 'codex-local:codex-thread-1:1',
                            createdAt: 1,
                            content: { role: 'agent' as const, content: { type: 'codex', data: { type: 'message', message: 'Newest response' } } }
                        }],
                        page: { limit: 50, nextBefore: 1, hasMore: true }
                    }
            )),
            getCodexSessionStatus: vi.fn(async () => ({ success: true as const, status: 'idle' as const })),
            getCodexSessionSnapshot: vi.fn(async (sessionId: string, machineId: string, options: { before?: number; limit?: number }) => ({
                ...await api.getCodexSessionContext(sessionId, machineId, options),
                status: await api.getCodexSessionStatus(sessionId, machineId),
                revision: 1,
                timing: { cache: 'hit' as const, durationMs: 1 }
            })),
            getMachineCodexSubscriptionLimits: vi.fn(async () => ({ success: false as const })),
            sendCodexSessionMessage: vi.fn(),
            forkCodexSession: vi.fn()
        } as unknown as ApiClient

        renderPage({ api })
        await screen.findByText('Newest response')
        clock.mockReturnValue(2_000)

        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')
        expect(viewport).not.toBeNull()
        Object.defineProperty(viewport!, 'scrollTop', { configurable: true, value: 0, writable: true })
        fireEvent.wheel(viewport!, { deltaY: -20 })

        await waitFor(() => {
            expect(api.getCodexSessionContext).toHaveBeenCalledWith('codex-thread-1', 'machine-1', { limit: 50, before: 1 })
            expect(screen.getByText('Older prompt')).toBeInTheDocument()
        })
    })

    it('forks the read-only Codex transcript into a normal HAPI session', async () => {
        const { api, onForked } = renderPage()

        await screen.findByText('Original response')
        openNativeSessionMenu()
        const forkItem = screen.getByRole('menuitem', { name: 'Fork to new session' })
        await waitFor(() => expect(forkItem).not.toBeDisabled())
        fireEvent.click(forkItem)

        await waitFor(() => {
            expect(api.forkCodexSession).toHaveBeenCalledWith('codex-thread-1', { machineId: 'machine-1' })
            expect(onForked).toHaveBeenCalledWith('new-hapi-session')
        })
    })

    it('shows immediate Fork progress while the runner creates the new session', async () => {
        const api = createApi()
        let resolveFork!: (value: { type: 'success'; sessionId: string }) => void
        ;(api.forkCodexSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => {
            resolveFork = resolve
        }))
        const { onForked } = renderPage({ api })

        await screen.findByText('Original response')
        openNativeSessionMenu()
        const forkItem = screen.getByRole('menuitem', { name: 'Fork to new session' })
        await waitFor(() => expect(forkItem).not.toBeDisabled())
        fireEvent.click(forkItem)

        expect(screen.queryByRole('menu', { name: 'More actions' })).toBeNull()
        expect(screen.getByText('Creating new session')).toBeInTheDocument()
        expect(screen.getByText('Copying the original context into a new HAPI session…')).toBeInTheDocument()

        resolveFork({ type: 'success', sessionId: 'new-hapi-session' })
        await waitFor(() => expect(onForked).toHaveBeenCalledWith('new-hapi-session'))
    })

    it('turns a runner failure into a clear Fork notice with retry', async () => {
        const api = createApi()
        ;(api.forkCodexSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new ApiError('HTTP 409 Conflict', 409, 'runner_offline')
        )
        renderPage({ api })

        await screen.findByText('Original response')
        openNativeSessionMenu()
        const forkItem = screen.getByRole('menuitem', { name: 'Fork to new session' })
        await waitFor(() => expect(forkItem).not.toBeDisabled())
        fireEvent.click(forkItem)

        expect(await screen.findByText('Could not create new session')).toBeInTheDocument()
        expect(screen.getByText('The selected runner is offline. Reconnect it, then try again.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    })

    it('normalizes local Codex messages through the normal chat reducer', () => {
        const blocks = buildReadOnlyCodexBlocks([
            {
                id: 'codex-local:1:0',
                createdAt: 0,
                content: { role: 'user', content: { type: 'text', text: 'Visible user message' } }
            },
            {
                id: 'codex-local:1:1',
                createdAt: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'tool-call', callId: 'call-1', name: 'Read', input: { file_path: 'README.md' } }
                    }
                }
            },
            {
                id: 'codex-local:1:2',
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'tool-call-result', callId: 'call-1', output: 'contents' }
                    }
                }
            },
            {
                id: 'codex-local:1:3',
                createdAt: 3,
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'reasoning', message: 'Inspecting the file' } }
                }
            }
        ])

        expect(blocks).toMatchObject([
            { kind: 'user-text', text: 'Visible user message' },
            { kind: 'tool-call', tool: { id: 'call-1', name: 'Read', result: 'contents' } },
            { kind: 'agent-reasoning', text: 'Inspecting the file' }
        ])
        expect(blocks).toHaveLength(3)
    })

    it('renders local automation heartbeats as status events', () => {
        const blocks = buildReadOnlyCodexBlocks([
            {
                id: 'codex-local:1:0',
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: '<heartbeat> <automation_id>bug</automation_id> <decision>DONT_NOTIFY</decision> <message>No new or updated bugs require action.</message> </heartbeat>'
                        }
                    }
                }
            },
            {
                id: 'codex-local:1:1',
                createdAt: 1,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '<heartbeat> <automation_id>bug</automation_id> <current_time_iso>2026-08-15T00:54:47.781Z</current_time_iso> <instructions>自动改bug</instructions> </heartbeat>'
                    }
                }
            }
        ])

        expect(blocks).toMatchObject([
            {
                kind: 'agent-event',
                event: {
                    type: 'automation-heartbeat',
                    automationId: 'bug',
                    decision: 'DONT_NOTIFY',
                    message: 'No new or updated bugs require action.'
                }
            },
            {
                kind: 'agent-event',
                event: {
                    type: 'automation-heartbeat',
                    automationId: 'bug',
                    message: '自动改bug',
                    currentTimeIso: '2026-08-15T00:54:47.781Z'
                }
            }
        ])
    })

    it('opens the read-only thread at its latest message', async () => {
        const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
        const setScrollTop = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get: () => 0,
            set(value: number) {
                setScrollTop(value)
            }
        })

        try {
            renderPage()

            await screen.findByText('Original response')
            await waitFor(() => {
                expect(setScrollTop).toHaveBeenCalled()
            })
        } finally {
            if (originalScrollTop) {
                Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop)
            } else {
                delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop
            }
        }
    })
})
