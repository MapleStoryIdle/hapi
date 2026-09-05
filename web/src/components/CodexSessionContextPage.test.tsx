import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeCodexRealtimeProvider } from '@/lib/native-codex-realtime-context'
import { publishNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'
import { ApiError, type ApiClient } from '@/api/client'
import type {
    CodexLocalSessionContextMessage,
    CodexLocalSessionContextResponse,
    CodexLocalSessionPlan,
    CodexLocalSessionSubagent,
    CodexLocalSessionSnapshotResponse
} from '@/types/api'
import { buildSessionDetailTimeline } from '@/chat/sessionDetailTimeline'
import {
    buildNativeCodexBlocks,
    buildReadOnlyCodexBlocks,
    CodexSessionContextPage,
    deriveNativeSessionConnectionHealth,
    hasNativeCodexAgentReply,
    hasNativeCodexOutputSince,
    getNativeCodexDirectSendPhase,
    getNativeCodexPlanStatus,
    getNativeContextRefreshInterval,
    getVisibleNativeDirectMessageEchoes,
    mergeCodexContextMessages
} from './CodexSessionContextPage'

afterEach(() => {
    cleanup()
    sessionStorage.clear()
    localStorage.clear()
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
        getCodexSessionComposerCapabilities: vi.fn(async () => ({
            success: true as const,
            commands: [],
            skills: []
        })),
        getCodexSessionSnapshot: vi.fn(async (sessionId: string, machineId: string, options: { before?: number; limit?: number }) => ({
            ...(await getCodexSessionContext(sessionId, machineId, options)),
            status: await getCodexSessionStatus(sessionId, machineId),
            version: { runnerEpoch: 'runner-a', revision: 1 },
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
        discardCodexSessionMessage: vi.fn(async () => ({
            success: true as const,
            discarded: true,
            queuedMessages: []
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
    it('treats new reasoning and tools as real output but ignores older responses', () => {
        const record = (type: string, createdAt: number): CodexLocalSessionContextMessage => ({
            id: `${type}-${createdAt}`,
            createdAt,
            content: { role: 'agent', content: { type: 'codex', data: { type, message: 'Output', callId: 'call-1' } } }
        })
        expect(hasNativeCodexOutputSince([record('message', 10)], 20)).toBe(false)
        expect(hasNativeCodexOutputSince([record('reasoning', 21)], 20)).toBe(true)
        expect(hasNativeCodexOutputSince([record('tool-call', 22)], 20)).toBe(true)
        expect(hasNativeCodexOutputSince([record('task_started', 22)], 20)).toBe(false)
    })
    it('shows a native plan only for its active processing turn', () => {
        const plan: CodexLocalSessionPlan = {
            turnId: 'turn-plan',
            callId: 'call-plan',
            steps: [
                { text: 'Inspect the transcript', status: 'completed' },
                { text: 'Render the plan', status: 'in_progress' }
            ]
        }

        expect(getNativeCodexPlanStatus(plan, 'processing', 'turn-plan')).toMatchObject({
            sourceBlockId: 'native-plan:turn-plan:call-plan',
            completed: 1,
            total: 2,
            currentStep: { text: 'Render the plan', status: 'in_progress' }
        })
        expect(getNativeCodexPlanStatus(plan, 'idle', 'turn-plan')).toBeNull()
        expect(getNativeCodexPlanStatus(plan, 'processing', 'newer-turn')).toBeNull()
    })

    it('renders the active native plan through the shared summary', async () => {
        const api = createApi()
        const status = {
            success: true as const,
            status: 'processing' as const,
            activeTurnId: 'turn-plan'
        }
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue(status)
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async (sessionId, machineId, options) => ({
            ...(await api.getCodexSessionContext(sessionId, machineId, options)),
            status,
            plan: {
                turnId: 'turn-plan',
                callId: 'call-plan',
                steps: [
                    { text: 'Inspect the transcript', status: 'completed' },
                    { text: 'Render the native plan', status: 'in_progress' }
                ]
            },
            version: { runnerEpoch: 'runner-a', revision: 1 },
            revision: 1,
            timing: { cache: 'hit', durationMs: 1 }
        }))

        renderPage({ api })

        const plan = await screen.findByRole('button', {
            name: 'Plan · Render the native plan · 1/2 complete'
        })
        expect(plan).toHaveAttribute('aria-expanded', 'false')
        expect(plan).toHaveTextContent('1/2·Render the native plan')
        expect(screen.queryByText('Inspect the transcript')).toBeNull()
    })

    it('uses a faster native fallback refresh cadence while a turn is running', () => {
        expect(getNativeContextRefreshInterval({ success: true, status: 'processing' })).toBe(1_000)
        expect(getNativeContextRefreshInterval({ success: true, status: 'idle', controlledByCodexSsh: true })).toBe(5_000)
        expect(getNativeContextRefreshInterval({ success: true, status: 'idle' })).toBe(5_000)
    })

    it('keeps the native composer usable through the shared Codex Desktop SSH app-server', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            controlledByCodexSsh: true
        })
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        const composer = screen.getByRole('textbox')
        expect(screen.queryByTestId('codex-native-ssh-controlled')).toBeNull()
        expect(composer).not.toBeDisabled()
        expect(composer).toHaveAttribute(
            'placeholder',
            'Codex Desktop over SSH is busy. New messages will be queued.'
        )
        expect(screen.getByTestId('codex-native-session-menu-trigger').querySelector('[title="Codex"]')?.parentElement)
            .toHaveClass('text-[#F5A524]')
        expect(screen.queryAllByTestId('composer-send-lock')).toHaveLength(0)

        fireEvent.change(composer, { target: { value: 'Queue through SSH' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                message: 'Queue through SSH',
                clientMessageId: expect.any(String)
            })
        })

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 1 },
                revision: 1,
                status: {
                    success: true,
                    status: 'idle',
                    controlledByCodexSsh: false
                },
                timing: { cache: 'hit', durationMs: 1 }
            }
        })

        await waitFor(() => {
            expect(screen.queryAllByTestId('composer-send-lock')).toHaveLength(0)
            expect(screen.getByRole('textbox')).not.toBeDisabled()
            expect(screen.getByTestId('codex-native-session-menu-trigger').querySelector('[title="Codex"]')?.parentElement)
                .not.toHaveClass('text-[#F5A524]')
        })
    })

    it('shows a local-only input wait while keeping the native turn busy', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            waitingForUserInput: true
        })
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async (sessionId, machineId, options) => ({
            ...(await api.getCodexSessionContext(sessionId, machineId, options)),
            status: await api.getCodexSessionStatus(sessionId, machineId),
            version: { runnerEpoch: 'runner-a', revision: 1 },
            revision: 1,
            timing: { cache: 'hit', durationMs: 1 }
        }))

        renderPage({ api })

        expect(await screen.findByTestId('codex-native-waiting-for-local-input')).toHaveTextContent('Waiting for local input')
        expect(screen.getByTestId('codex-native-waiting-for-local-input')).toHaveTextContent('Return to the local Codex session')
        // The compact alert is deliberately absent while the full notice is
        // open; it appears only after the five-second auto-collapse.
        expect(screen.queryByTestId('codex-native-waiting-for-local-input-toggle')).not.toBeInTheDocument()
        const composer = screen.getByRole('textbox')
        expect(composer).toBeInTheDocument()
        openNativeSessionMenu()
        expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).toBeDisabled()
    })

    it('prioritizes manual native recovery over a local-input wait', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            waitingForUserInput: true,
            queuedMessages: [{
                id: 'waiting-recovery',
                text: 'Recover before returning local input',
                queuedAt: 123,
                recoveryRequired: true,
                recoveryReason: 'session_status_unknown'
            }]
        })
        renderPage({ api })

        const recovery = await screen.findByTestId('codex-native-recovery')
        expect(recovery).toHaveTextContent('Codex did not report this message\'s state')
        expect(screen.queryByTestId('codex-native-waiting-for-local-input')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Discard message' })).toBeInTheDocument()
    })

    it('describes each native direct-send hand-off phase', () => {
        const echo = {
            id: 'native-local-1',
            text: 'Continue',
            createdAt: 1,
            status: 'sending' as const,
            deliveryPhase: 'launching' as const,
            phaseStartedAt: 1,
            queueId: null,
            observedTranscriptMessageIds: [],
            observedThroughPosition: null
        }

        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 1,
            queuedMessages: [],
            directMessageEchoes: [echo],
            runState: 'idle'
        })).toBe('launching')
        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 0,
            queuedMessages: [],
            directMessageEchoes: [{ ...echo, status: 'queued', deliveryPhase: 'matching' }],
            runState: 'processing',
            progress: { phase: 'matching', startedAt: 1, phaseStartedAt: 2, transport: 'app-server' }
        })).toBe('matching')
        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 0,
            queuedMessages: [],
            directMessageEchoes: [{ ...echo, status: 'queued', deliveryPhase: 'connected' }],
            runState: 'processing',
            progress: { phase: 'connected', startedAt: 1, phaseStartedAt: 3, transport: 'app-server' }
        })).toBe('connected')
        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 0,
            queuedMessages: [],
            directMessageEchoes: [{ ...echo, status: 'queued', deliveryPhase: 'retrying' }],
            runState: 'processing',
            progress: {
                phase: 'retrying',
                startedAt: 1,
                phaseStartedAt: 4,
                transport: 'exec-resume',
                attempt: 2
            }
        })).toBe('retrying')
        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 0,
            queuedMessages: [{ id: 'queue-1', text: 'Continue', queuedAt: 1 }],
            directMessageEchoes: [{ ...echo, status: 'queued', deliveryPhase: 'queued', queueId: 'queue-1' }],
            runState: 'processing'
        })).toBe('queued')
        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 0,
            queuedMessages: [],
            directMessageEchoes: [],
            runState: 'processing'
        })).toBe('reasoning')
        expect(getNativeCodexDirectSendPhase({
            pendingDirectSendCount: 0,
            queuedMessages: [],
            directMessageEchoes: [],
            runState: 'processing',
            hasAgentReply: true
        })).toBeNull()
    })

    it('recognizes an agent reply only after the newest native prompt', () => {
        const userMessage = (id: string, position: number): CodexLocalSessionContextMessage => ({
            id,
            position,
            createdAt: position,
            content: { role: 'user', content: { type: 'text', text: 'Prompt' } }
        })
        const agentMessage = (id: string, position: number): CodexLocalSessionContextMessage => ({
            id,
            position,
            createdAt: position,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Reply' } } }
        })

        expect(hasNativeCodexAgentReply([userMessage('user-1', 1), agentMessage('agent-1', 2)])).toBe(true)
        expect(hasNativeCodexAgentReply([agentMessage('agent-1', 1), userMessage('user-2', 2)])).toBe(false)
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
            deliveryPhase: 'launching' as const,
            phaseStartedAt: 2,
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

    it('reconciles a native custom-command receipt against its expanded transcript prompt', () => {
        const userMessage = (id: string, position: number, text: string): CodexLocalSessionContextMessage => ({
            id,
            createdAt: 1,
            position,
            content: { role: 'user', content: { type: 'text', text } }
        })
        const echo = {
            id: 'native-local-custom-command',
            text: '/review src/index.ts',
            deliveryText: 'Review the requested code.\n\nUser arguments: src/index.ts',
            createdAt: 2,
            status: 'sending' as const,
            deliveryPhase: 'launching' as const,
            phaseStartedAt: 2,
            queueId: null,
            observedTranscriptMessageIds: [],
            observedThroughPosition: 3
        }

        expect(getVisibleNativeDirectMessageEchoes([echo], [
            userMessage('expanded-review', 4, echo.deliveryText)
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

    it('renders native context compaction as a timeline divider', async () => {
        const api = createApi()
        ;(api.getCodexSessionContext as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
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
                    createdAt: 1,
                    content: { role: 'agent', content: { type: 'codex', data: { type: 'context_compacted' } } }
                }
            ]
        })
        renderPage({ api })

        const event = await screen.findByTestId('context-compacted-event')
        expect(event).toHaveAttribute('data-event-style', 'divider')
        expect(event).toHaveTextContent('Context compacted')
        expect(event).not.toHaveTextContent('Earlier messages were saved as a summary')
    })

    it('refreshes the open native transcript when its runner publishes an invalidation', async () => {
        const { api } = renderPage({ realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThanOrEqual(2)
        })
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

    it('coalesces one foreground episode into one conditional snapshot read', async () => {
        const { api } = renderPage({ realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThanOrEqual(2)
        })
        const snapshotCallsBefore = (api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length

        act(() => {
            window.dispatchEvent(new Event('focus'))
            window.dispatchEvent(new Event('pageshow'))
            window.dispatchEvent(new Event('online'))
            document.dispatchEvent(new Event('visibilitychange'))
        })

        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBe(snapshotCallsBefore + 1)
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
            .toBe(snapshotCallsBefore + 1)
    })

    it('applies status from a matching compact realtime version without another runner read', async () => {
        const { api } = renderPage({ realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThanOrEqual(2)
        })
        const snapshotCallsBefore = (api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 1 },
                revision: 1,
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

    it('keeps a realtime status that arrives while a newer full snapshot is in flight', async () => {
        const api = createApi()
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThanOrEqual(2)
        })
        const callsBefore = (api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length
        let resolveFull!: (response: CodexLocalSessionSnapshotResponse) => void
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(
            () => new Promise<CodexLocalSessionSnapshotResponse>((resolve) => {
                resolveFull = resolve
            })
        )

        act(() => window.dispatchEvent(new Event('focus')))
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBe(callsBefore + 1)
        })

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 2 },
                revision: 2,
                status: { success: true, status: 'idle' },
                timing: { cache: 'hit', durationMs: 0 }
            }
        })

        await act(async () => {
            resolveFull({
                success: true,
                session: {
                    id: 'codex-thread-1',
                    title: 'Recent Codex task',
                    cwd: '/workspace/project',
                    modifiedAt: 2,
                    model: 'gpt-5.6-terra',
                    modelReasoningEffort: 'high'
                },
                page: { limit: 50, nextBefore: null, hasMore: false },
                messages: [{
                    id: 'codex-local:codex-thread-1:2',
                    createdAt: 2,
                    content: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'Revision two' } }
                    }
                }],
                status: { success: true, status: 'processing' },
                version: { runnerEpoch: 'runner-a', revision: 2 },
                revision: 2,
                timing: { cache: 'miss', durationMs: 10 }
            })
        })

        expect(await screen.findByText('Revision two')).toBeInTheDocument()
        openNativeSessionMenu()
        expect(screen.getByRole('menuitem', { name: 'Fork to new session' })).not.toBeDisabled()
    })

    it('does not let React Query duplicate a permanent snapshot error', async () => {
        const api = createApi()
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
            new ApiError('Native session not found', 404, 'session_not_found')
        )
        renderPage({ api })

        await screen.findByTestId('session-connection-recovery')
        await new Promise((resolve) => setTimeout(resolve, 600))

        expect(api.getCodexSessionSnapshot).toHaveBeenCalledTimes(1)
    })

    it('clears optional realtime progress and errors when the next status omits them', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'idle',
            lastError: 'Another writer owns the thread',
            lastErrorCode: 'external_writer_active'
        })
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        expect(await screen.findByTestId('composer-send-error')).toBeInTheDocument()
        expect(screen.queryByTestId('codex-native-external-writer')).toBeNull()
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThanOrEqual(2)
        })

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 1 },
                revision: 1,
                status: {
                    success: true,
                    status: 'processing',
                    progress: {
                        phase: 'launching',
                        startedAt: Date.now(),
                        phaseStartedAt: Date.now(),
                        transport: 'app-server'
                    }
                },
                timing: { cache: 'hit', durationMs: 0 }
            }
        })

        expect(await screen.findByTestId('codex-direct-send-phase-launching')).toBeInTheDocument()
        expect(screen.queryByTestId('codex-native-external-writer')).toBeNull()
        expect(screen.queryByTestId('composer-send-error')).toBeNull()

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 1 },
                revision: 1,
                status: { success: true, status: 'idle' },
                timing: { cache: 'hit', durationMs: 0 }
            }
        })

        await waitFor(() => {
            expect(screen.queryByTestId('codex-direct-send-phase-launching')).toBeNull()
        }, { timeout: 4_000 }) // Type + a full second hold + erase, even after status clears.
    })

    it('reconciles full queued messages when compact realtime queue refs change', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            queuedMessages: [{ id: 'queued-1', text: 'Keep text out of SSE', queuedAt: 123 }]
        })
        const { api: renderedApi } = renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        expect(await screen.findByRole('button', { name: 'Open 1 queued messages' })).toBeInTheDocument()
        await waitFor(() => {
            expect((renderedApi.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBeGreaterThanOrEqual(2)
        })
        const snapshotCallsBefore = (renderedApi.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length
        ;(renderedApi.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            unchanged: true,
            session: {
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                cwd: '/workspace/project',
                modifiedAt: 1,
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high'
            },
            status: { success: true, status: 'idle', queuedMessages: [] },
            version: { runnerEpoch: 'runner-a', revision: 1 },
            revision: 1,
            timing: { cache: 'hit', durationMs: 0 }
        })

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 1 },
                revision: 1,
                status: { success: true, status: 'idle', queuedMessageRefs: [] },
                timing: { cache: 'hit', durationMs: 0 }
            }
        })

        await waitFor(() => {
            expect((renderedApi.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length)
                .toBe(snapshotCallsBefore + 1)
        })
        await waitFor(() => {
            expect(screen.queryByRole('button', { name: 'Open 1 queued messages' })).toBeNull()
        })
    })

    it('accepts revision one after a runner epoch changes', async () => {
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
            version: { runnerEpoch: 'old-runner', revision: 100 },
            revision: 100,
            timing: { cache: 'hit', durationMs: 1 }
        }
        const restartedSnapshot: CodexLocalSessionSnapshotResponse = {
            ...staleSnapshot,
            session: { ...staleSnapshot.session, modifiedAt: 2 },
            status: {
                success: true,
                status: 'idle',
                queuedMessages: [{ id: 'runner-b-queue', text: 'Queued on runner B', queuedAt: 2 }]
            },
            messages: [
                staleSnapshot.messages[0],
                {
                    id: 'codex-local:codex-thread-1:1',
                    createdAt: 2,
                    content: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'New runner wins' } }
                    }
                }
            ],
            version: { runnerEpoch: 'new-runner', revision: 1 },
            revision: 1
        }
        let resolveSnapshot!: (response: CodexLocalSessionSnapshotResponse) => void
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>)
            .mockImplementationOnce(() => new Promise<CodexLocalSessionSnapshotResponse>((resolve) => {
                resolveSnapshot = resolve
            }))
            .mockResolvedValue(restartedSnapshot)
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        await waitFor(() => expect(api.getCodexSessionSnapshot).toHaveBeenCalled())
        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'new-runner', revision: 1 },
                revision: 1,
                status: {
                    success: true,
                    status: 'idle',
                    queuedMessageRefs: [{ id: 'runner-b-queue' }]
                },
                timing: { cache: 'miss', durationMs: 2 }
            }
        })

        await act(async () => {
            resolveSnapshot(staleSnapshot)
        })
        await waitFor(() => {
            expect(screen.getByText('New runner wins')).toBeInTheDocument()
            expect(screen.queryByText('Original response')).toBeNull()
        })
        expect(await screen.findByRole('button', { name: 'Open 1 queued messages' })).toBeInTheDocument()
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
                message: 'Continue the original thread',
                clientMessageId: expect.any(String)
            })
        })
        expect(api.forkCodexSession).not.toHaveBeenCalled()
    })

    it('does not show a floating lock notice for a legacy external-writer result', async () => {
        const api = createApi()
        let rejectedClientMessageId: string | null = null
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementation(async (
            _sessionId: string,
            request: { clientMessageId?: string }
        ) => {
            rejectedClientMessageId = request.clientMessageId ?? null
            return {
                success: true as const,
                status: 'processing' as const,
                startedAt: Date.now()
            }
        })
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockImplementation(async () => (
            rejectedClientMessageId
                ? {
                    success: true as const,
                    status: 'idle' as const,
                    lastError: 'This native Codex session is currently controlled by another Codex client',
                    lastErrorAt: Date.now(),
                    lastErrorClientMessageId: rejectedClientMessageId,
                    lastErrorCode: 'external_writer_active' as const,
                    queuedMessages: []
                }
                : {
                    success: true as const,
                    status: 'idle' as const
                }
        ))
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ignore this locked prompt' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect(screen.queryByTestId('codex-native-external-writer')).toBeNull()
            expect(screen.getByRole('textbox')).not.toBeDisabled()
        })
        expect(screen.queryByTestId('codex-native-recovery')).not.toBeInTheDocument()

        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            session: {
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                cwd: '/workspace/project',
                modifiedAt: 2,
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high'
            },
            page: { limit: 50, nextBefore: null, hasMore: false },
            messages: [
                {
                    id: 'codex-local:codex-thread-1:0',
                    createdAt: 0,
                    content: { role: 'user', content: { type: 'text', text: 'Original prompt' } }
                },
                {
                    id: 'codex-local:codex-thread-1:1',
                    createdAt: 2,
                    content: {
                        role: 'agent',
                        content: { type: 'codex', data: { type: 'message', message: 'New native update' } }
                    }
                }
            ],
            status: { success: true, status: 'idle' },
            version: { runnerEpoch: 'runner-a', revision: 2 },
            revision: 2,
            timing: { cache: 'miss', durationMs: 2 }
        })

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 2 },
                revision: 2,
                status: { success: true, status: 'idle' },
                timing: { cache: 'miss', durationMs: 2 }
            }
        })

        expect(await screen.findByText('New native update')).toBeInTheDocument()
        expect(screen.getByRole('textbox')).not.toBeDisabled()
    })

    it('expands a native custom command but keeps the typed command as its display receipt', async () => {
        const api = createApi()
        ;(api.getCodexSessionComposerCapabilities as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            commands: [{
                name: 'review',
                source: 'project',
                description: 'Review selected files',
                content: 'Review the requested code.'
            }],
            skills: []
        })
        renderPage({ api })

        await screen.findByText('Original response')
        await waitFor(() => expect(api.getCodexSessionComposerCapabilities).toHaveBeenCalledWith(
            'codex-thread-1',
            'machine-1'
        ))
        const input = screen.getByRole('textbox')
        fireEvent.change(input, { target: { value: '/review src/index.ts' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                message: 'Review the requested code.\n\nUser arguments: src/index.ts',
                displayMessage: '/review src/index.ts',
                clientMessageId: expect.any(String)
            })
        })
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
        expect(screen.getByTestId('codex-direct-send-phase-launching').closest('.happy-thread-messages')).not.toBeNull()

        await act(async () => {
            resolveSend({ success: true, status: 'processing', startedAt: Date.now() })
        })
        expect(await screen.findByTestId('codex-direct-send-phase-matching', {}, { timeout: 4_000 })).toBeInTheDocument()
    })

    it('shows fallback delivery retry progress from the runner', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            progress: {
                phase: 'retrying',
                startedAt: Date.now(),
                phaseStartedAt: Date.now(),
                transport: 'exec-resume',
                attempt: 2
            }
        })
        renderPage({ api })

        const notice = await screen.findByTestId('codex-direct-send-phase-retrying')
        await waitFor(() => expect(notice).toHaveTextContent('Retrying send'))
        expect(notice).not.toHaveTextContent('switching to the fallback')
        expect(notice.querySelector('svg')).toBeNull()
        expect(notice.closest('.happy-thread-messages')).not.toBeNull()
    })

    it('replays coalesced runner stages then waits for new output rather than an earlier turn reply', async () => {
        const api = createApi()
        const startedAt = Date.now()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            progress: {
                phase: 'reasoning', startedAt, phaseStartedAt: startedAt, transport: 'app-server',
                history: [
                    { phase: 'launching', startedAt },
                    { phase: 'matching', startedAt },
                    { phase: 'connected', startedAt },
                    { phase: 'reasoning', startedAt }
                ]
            }
        })
        renderPage({ api, realtimeAvailable: true, realtimeConnected: true })

        await screen.findByText('Original response') // Earlier turns must not stop this send's status.
        for (const phase of ['launching', 'matching', 'connected', 'reasoning']) {
            expect(await screen.findByTestId(`codex-direct-send-phase-${phase}`, {}, { timeout: 4_000 })).toBeInTheDocument()
        }
        const waiting = screen.getByRole('status', { name: 'Reasoning' })
        expect(waiting).toHaveTextContent(/Reasoning\.{1,3}\d+s/)

        // A genuine new assistant message may arrive together with the latest progress.
        const original = await api.getCodexSessionSnapshot('codex-thread-1', 'machine-1', {})
        if (!original.success || !('messages' in original)) throw new Error('Expected a full snapshot')
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
            ...original,
            version: { runnerEpoch: 'runner-a', revision: 2 }, revision: 2,
            messages: [...original.messages, {
                id: 'codex-local:codex-thread-1:2', createdAt: startedAt + 1,
                content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'The new reply' } } }
            }]
        })
        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated', machineId: 'machine-1', codexSessionId: 'codex-thread-1',
            snapshot: {
                version: { runnerEpoch: 'runner-a', revision: 2 }, revision: 2,
                status: original.status,
                timing: { cache: 'hit', durationMs: 0 }
            }
        })
        await screen.findByText('The new reply')
        await waitFor(() => expect(screen.queryByTestId('codex-direct-send-phase-reasoning')).toBeNull())
    }, 15_000)

    it('retains intermediate phases carried only by the send receipt', async () => {
        const api = createApi()
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            const startedAt = Date.now()
            return {
                success: true, status: 'processing', startedAt,
                progress: {
                    phase: 'reasoning', startedAt, phaseStartedAt: startedAt, transport: 'app-server',
                    history: [
                        { phase: 'launching', startedAt },
                        { phase: 'matching', startedAt },
                        { phase: 'connected', startedAt },
                        { phase: 'reasoning', startedAt }
                    ]
                }
            }
        })
        renderPage({ api }) // Follow-up snapshots intentionally omit progress.
        await screen.findByText('Original response')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep the received stages' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        for (const phase of ['launching', 'matching', 'connected']) {
            expect(await screen.findByTestId(`codex-direct-send-phase-${phase}`, {}, { timeout: 4_000 })).toBeInTheDocument()
        }
        expect(api.sendCodexSessionMessage).toHaveBeenCalledTimes(1)
    }, 12_000)

    it('keeps a transport-timed-out prompt pending while it verifies delivery', async () => {
        const api = createApi()
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
            new ApiError('Request timed out', 408, 'request_timeout')
        )
        renderPage({ api })

        await screen.findByText('Original response')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Verify this before retrying' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        expect(await screen.findByText('The connection timed out. Checking whether this message was delivered.')).toBeInTheDocument()
        expect(screen.getAllByText('Verify this before retrying')).not.toHaveLength(0)
        expect(screen.getByRole('status', { name: 'Sending' })).toBeInTheDocument()
        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
        })
    })

    it('keeps an explicitly rejected unknown-status browser receipt for manual recovery', async () => {
        const api = createApi()
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
            new ApiError('Cannot confirm whether this native Codex session is idle', 409, 'session_status_unknown')
        )
        renderPage({ api })

        await screen.findByText('Original response')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Wait for a confirmed status' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
        })
        const recovery = await screen.findByTestId('codex-native-recovery')
        expect(recovery).toHaveTextContent('Codex did not report this message\'s state')
        expect(screen.getByRole('button', { name: 'Confirm and retry' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Discard message' })).toBeInTheDocument()
        expect(api.sendCodexSessionMessage).toHaveBeenCalledTimes(1)
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
        await waitFor(() => expect(api.sendCodexSessionMessage).toHaveBeenCalledTimes(2))
        const firstPayload = (api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]
        const retryPayload = (api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]
        expect(retryPayload).toMatchObject({
            machineId: 'machine-1',
            message: 'Keep this after leaving',
            clientMessageId: firstPayload?.clientMessageId
        })
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

    it('hides reasoning after the agent reply while keeping direct-send available', async () => {
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
        expect(screen.queryByTestId('codex-direct-send-phase-reasoning')).not.toBeInTheDocument()
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
                message: 'Queue this prompt',
                clientMessageId: expect.any(String)
            })
        })
        expect(await screen.findByRole('button', { name: 'Open 1 queued messages' })).toBeInTheDocument()
        expect(screen.queryByTestId('codex-direct-send-phase-queued')).toBeNull()
        expect(screen.queryByTestId('codex-native-recovery')).not.toBeInTheDocument()
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

    it('clears a local queued receipt when the native transcript confirms delivery', async () => {
        const api = createApi()
        let transcriptHasPrompt = false
        ;(api.getCodexSessionContext as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
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
                    content: { role: 'user' as const, content: { type: 'text', text: 'Original prompt' } }
                },
                {
                    id: 'codex-local:codex-thread-1:1',
                    createdAt: 1,
                    content: {
                        role: 'agent' as const,
                        content: { type: 'codex', data: { type: 'message', message: 'Original response' } }
                    }
                },
                ...(transcriptHasPrompt ? [{
                    id: 'codex-local:codex-thread-1:2',
                    createdAt: 2,
                    content: { role: 'user' as const, content: { type: 'text', text: 'Delivered prompt' } }
                }] : [])
            ]
        }))
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            stalledSince: Date.now() - 10_000,
            queuedMessages: []
        })
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementation(async (
            _sessionId: string,
            payload: { clientMessageId: string }
        ) => {
            transcriptHasPrompt = true
            return {
                success: true as const,
                status: 'queued' as const,
                queueId: payload.clientMessageId,
                queuedAt: Date.now(),
                queuedMessages: [{
                    id: payload.clientMessageId,
                    text: 'Delivered prompt',
                    queuedAt: Date.now()
                }]
            }
        })
        renderPage({ api })

        await screen.findByText('Original response')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Delivered prompt' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))

        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
        })
        await waitFor(() => {
            expect(screen.getAllByText('Delivered prompt')).toHaveLength(1)
            expect(screen.queryByRole('button', { name: 'Open 1 queued messages' })).not.toBeInTheDocument()
            expect(screen.queryByTestId('codex-native-recovery')).not.toBeInTheDocument()
        })
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

    it('asks for confirmation before recovering a stale native queue', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            stalledSince: Date.now() - 10_000,
            queuedMessages: [{ id: 'queued-stalled', text: 'Recover this saved prompt', queuedAt: 123 }]
        })
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            startedAt: Date.now()
        })
        renderPage({ api })

        expect(await screen.findByTestId('codex-native-recovery')).toHaveTextContent('This native session may be stuck')
        fireEvent.click(screen.getByRole('button', { name: 'Confirm and retry' }))

        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                message: 'Recover this saved prompt',
                clientMessageId: 'queued-stalled',
                forceRecovery: true
            }, { signal: expect.any(AbortSignal) })
        })
    })

    it('discards a pending native recovery request without silently retrying it', async () => {
        const api = createApi()
        let recoverySignal: AbortSignal | undefined
        let queuedMessages = [{ id: 'queued-stalled', text: 'Cancel this retry', queuedAt: 123 }]
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            stalledSince: Date.now() - 10_000,
            queuedMessages
        })
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementation((
            _sessionId: string,
            _payload: unknown,
            options?: { signal?: AbortSignal }
        ) => new Promise((_resolve, reject) => {
            recoverySignal = options?.signal
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('Aborted')
                error.name = 'AbortError'
                reject(error)
            }, { once: true })
        }))
        ;(api.discardCodexSessionMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            queuedMessages = []
            return { success: true, discarded: true, queuedMessages: [] }
        })
        renderPage({ api })

        await screen.findByTestId('codex-native-recovery')
        fireEvent.click(screen.getByRole('button', { name: 'Confirm and retry' }))
        expect(await screen.findByRole('button', { name: 'Discard message' })).toBeEnabled()
        await waitFor(() => expect(recoverySignal).toBeDefined())

        fireEvent.click(screen.getByRole('button', { name: 'Discard message' }))

        await waitFor(() => {
            expect(recoverySignal?.aborted).toBe(true)
            expect(api.discardCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                clientMessageId: 'queued-stalled'
            })
        })
        expect(api.sendCodexSessionMessage).toHaveBeenCalledTimes(1)
        await waitFor(() => expect(screen.queryByTestId('codex-native-recovery')).not.toBeInTheDocument())
    })

    it('keeps a browser recovery receipt when Codex reports that discard is still active', async () => {
        const createdAt = Date.now() - 20_000
        localStorage.setItem('hapi:native-codex-direct-messages:v1', JSON.stringify({
            [JSON.stringify(['machine-1', 'codex-thread-1'])]: [{
                id: 'active-discard-receipt',
                text: 'Keep this browser receipt',
                createdAt,
                status: 'queued',
                deliveryPhase: 'queued',
                phaseStartedAt: createdAt,
                queueId: 'active-discard-receipt',
                observedTranscriptMessageIds: [],
                observedThroughPosition: null
            }]
        }))
        const api = createApi()
        const queuedMessages = [{
            id: 'active-discard-receipt',
            text: 'Keep this browser receipt',
            queuedAt: createdAt,
            recoveryRequired: true,
            recoveryReason: 'session_status_unknown' as const
        }]
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'idle',
            queuedMessages
        })
        ;(api.discardCodexSessionMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            discarded: false,
            active: true,
            queuedMessages
        })
        renderPage({ api })

        await screen.findByTestId('codex-native-recovery')
        expect(await screen.findAllByText('Keep this browser receipt')).not.toHaveLength(0)
        fireEvent.click(screen.getByRole('button', { name: 'Discard message' }))

        expect(await screen.findByText('Codex may still be handling this message, so it was not discarded. Refresh status before trying again.')).toBeInTheDocument()
        expect(screen.getByTestId('codex-native-recovery')).toBeInTheDocument()
        expect(screen.getAllByText('Keep this browser receipt')).not.toHaveLength(0)
        expect(localStorage.getItem('hapi:native-codex-direct-messages:v1')).toContain('active-discard-receipt')
    })

    it('does not revive a successfully discarded recovery from a stale status response', async () => {
        const api = createApi()
        const staleQueuedMessages = [{
            id: 'stale-discard-receipt',
            text: 'Do not revive this receipt',
            queuedAt: 123,
            recoveryRequired: true,
            recoveryReason: 'session_status_unknown' as const
        }]
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'idle',
            queuedMessages: staleQueuedMessages
        })
        ;(api.discardCodexSessionMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            discarded: true,
            queuedMessages: []
        })
        renderPage({ api })

        await screen.findByTestId('codex-native-recovery')
        fireEvent.click(screen.getByRole('button', { name: 'Discard message' }))

        await waitFor(() => {
            expect((api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1)
            expect(screen.queryByTestId('codex-native-recovery')).not.toBeInTheDocument()
        })
    })

    it('explains a Codex timeout before allowing a saved prompt to be retried', async () => {
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'idle',
            lastError: 'Codex stopped reporting activity',
            lastErrorAt: Date.now(),
            lastErrorClientMessageId: 'timed-out-prompt',
            lastErrorCode: 'codex_timeout',
            queuedMessages: [{
                id: 'timed-out-prompt',
                text: 'Retry after Codex timeout',
                queuedAt: 123,
                recoveryRequired: true,
                recoveryReason: 'codex_timeout'
            }]
        })
        renderPage({ api })

        const recovery = await screen.findByTestId('codex-native-recovery')
        expect(recovery).toHaveTextContent('Codex has not reported new activity for a while')
        expect(screen.getByRole('button', { name: 'Confirm and retry' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Discard message' })).toBeInTheDocument()
    })

    it('recovers a browser receipt left behind by a runner restart only after confirmation', async () => {
        const createdAt = Date.now() - 20_000
        localStorage.setItem('hapi:native-codex-direct-messages:v1', JSON.stringify({
            [JSON.stringify(['machine-1', 'codex-thread-1'])]: [{
                id: 'native:lost-after-restart',
                text: 'Retry the lost receipt',
                deliveryText: 'Expanded retry the lost receipt',
                createdAt,
                status: 'queued',
                deliveryPhase: 'queued',
                phaseStartedAt: createdAt,
                queueId: 'runner-queue-that-restarted',
                observedTranscriptMessageIds: [],
                observedThroughPosition: null
            }]
        }))
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'idle',
            queuedMessages: []
        })
        ;(api.sendCodexSessionMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'processing',
            startedAt: Date.now()
        })
        renderPage({ api })

        expect(await screen.findByText('Retry the lost receipt')).toBeInTheDocument()
        expect(await screen.findByTestId('codex-native-recovery')).toHaveTextContent('Retrying may run the message twice')
        fireEvent.click(screen.getByRole('button', { name: 'Confirm and retry' }))

        await waitFor(() => {
            expect(api.sendCodexSessionMessage).toHaveBeenCalledWith('codex-thread-1', {
                machineId: 'machine-1',
                message: 'Expanded retry the lost receipt',
                displayMessage: 'Retry the lost receipt',
                clientMessageId: 'native:lost-after-restart',
                forceRecovery: true
            }, { signal: expect.any(AbortSignal) })
        })
    })

    it('does not silently retry an old unconfirmed native receipt', async () => {
        const createdAt = Date.now() - 30_000
        localStorage.setItem('hapi:native-codex-direct-messages:v1', JSON.stringify({
            [JSON.stringify(['machine-1', 'codex-thread-1'])]: [{
                id: 'native:unconfirmed-old-receipt',
                text: 'Do not retry by itself',
                createdAt,
                status: 'sending',
                deliveryPhase: 'matching',
                phaseStartedAt: createdAt,
                queueId: null,
                observedTranscriptMessageIds: [],
                observedThroughPosition: null
            }]
        }))
        const api = createApi()
        ;(api.getCodexSessionStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            status: 'idle',
            queuedMessages: []
        })
        renderPage({ api })

        expect(await screen.findByTestId('codex-native-recovery')).toHaveTextContent('Retrying may run the message twice')
        expect(api.sendCodexSessionMessage).not.toHaveBeenCalled()
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

    it('updates display metadata from an unchanged conditional snapshot', async () => {
        const { api } = renderPage()

        await screen.findByText('Original response')
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
            success: true,
            unchanged: true,
            session: {
                id: 'codex-thread-1',
                title: 'Renamed native task',
                cwd: '/workspace/project',
                modifiedAt: 2,
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high'
            },
            status: { success: true, status: 'idle' },
            version: { runnerEpoch: 'runner-a', revision: 1 },
            revision: 1,
            timing: { cache: 'hit', durationMs: 0 }
        })

        openNativeSessionMenu()
        fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))

        expect(await screen.findByRole('button', { name: 'Renamed native task' })).toBeInTheDocument()
    })

    it('uses the shared capability-scoped header menu without SHAPI-only actions', async () => {
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

    it('opens and closes the native header menu after cancelled-touch click fallbacks', async () => {
        renderPage()

        await screen.findByText('Original response')
        const trigger = screen.getByTestId('codex-native-session-menu-trigger')
        fireEvent.pointerDown(trigger, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 })
        fireEvent.pointerCancel(trigger)
        fireEvent.click(trigger, { detail: 1 })

        expect(await screen.findByRole('menu')).toBeInTheDocument()

        fireEvent.pointerDown(trigger, { pointerType: 'touch', pointerId: 2, clientX: 0, clientY: 0 })
        fireEvent.click(trigger, { detail: 1 })

        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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


    it('matches the SHAPI conversation skeleton while native context loads', () => {
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
        expect(loading).toHaveAttribute('aria-busy', 'true')
        expect(screen.getByRole('status', { name: 'Loading context…' })).toBe(loading)
        expect(screen.getAllByTestId('session-entry-message-skeleton')).toHaveLength(8)
        expect(screen.getByTestId('codex-session-context-composer-skeleton')).toBeInTheDocument()
        expect(loading).toHaveAttribute('data-session-loading-animation', 'refresh-loop')
        expect(loading.querySelector('.session-message-skeleton-refresh')).not.toBeNull()
        expect(loading.querySelector('.animate-spin')).toBeNull()
        expect(loading.querySelector('[title="Codex"]')).toBeNull()
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
            getCodexSessionComposerCapabilities: vi.fn(async () => ({
                success: true as const,
                commands: [],
                skills: []
            })),
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

    it('forks the read-only Codex transcript into a normal SHAPI session', async () => {
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
        expect(screen.getByText('Copying the original context into a new SHAPI session…')).toBeInTheDocument()

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

    it('maps native child transcript snapshots to the shared CodexAgent cards', () => {
        const blocks = buildNativeCodexBlocks([
            {
                id: 'codex-local:parent:0',
                createdAt: 1,
                content: { role: 'user', content: { type: 'text', text: 'Inspect the implementation' } }
            },
            {
                id: 'codex-local:parent:1',
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'tool-call', callId: 'parent-read', name: 'Read', input: { file_path: 'README.md' } }
                    }
                }
            }
        ], [], [{
            id: 'native-child-1',
            parentSessionId: 'parent-thread-1',
            name: 'Ada',
            role: 'reviewer',
            agentPath: '/root/reviewer',
            model: 'gpt-5.6-terra',
            modelReasoningEffort: 'high',
            status: 'completed',
            statusText: 'Completed',
            startedAt: 10,
            updatedAt: 12,
            completedAt: 12,
            traceMessages: [{
                createdAt: 11,
                role: 'agent',
                content: {
                    type: 'codex',
                    data: { type: 'message', id: 'native-child-message', message: 'Reviewed the implementation.', final: true }
                }
            }]
        }])

        const parentToolIndex = blocks.findIndex((block) => (
            block.kind === 'tool-call' && block.tool.id === 'parent-read'
        ))
        const agentBlock = blocks.find((block) => (
            block.kind === 'tool-call' && block.tool.name === 'CodexAgent'
        ))
        expect(agentBlock).toMatchObject({
            kind: 'tool-call',
            tool: {
                id: 'native-codex-agent:native-child-1',
                name: 'CodexAgent',
                state: 'completed',
                startedAt: 10,
                completedAt: 12,
                input: {
                    agentId: 'native-child-1',
                    displayName: 'Ada',
                    agent_type: 'reviewer',
                    model: 'gpt-5.6-terra',
                    reasoningEffort: 'high'
                }
            }
        })
        expect(blocks.indexOf(agentBlock!)).toBeGreaterThan(parentToolIndex)
        expect(agentBlock && agentBlock.kind === 'tool-call' ? agentBlock.children : []).toMatchObject([
            { kind: 'agent-text', text: 'Reviewed the implementation.' }
        ])
    })

    it('places native child cards in the parent message timeline', () => {
        const blocks = buildNativeCodexBlocks([
            {
                id: 'codex-local:parent:0',
                createdAt: 1,
                content: { role: 'user', content: { type: 'text', text: 'Start the task' } }
            },
            {
                id: 'codex-local:parent:1',
                createdAt: 30,
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'message', message: 'Parent continued after the child started.' } }
                }
            }
        ], [], [{
            id: 'native-child-timeline',
            parentSessionId: 'parent-thread-1',
            name: 'Ada',
            model: 'gpt-5.6-terra',
            modelReasoningEffort: 'high',
            status: 'completed',
            statusText: 'Completed',
            startedAt: 10,
            updatedAt: 12,
            completedAt: 12,
            traceMessages: []
        }])

        const childCardIndex = blocks.findIndex((block) => (
            block.kind === 'tool-call' && block.tool.id === 'native-codex-agent:native-child-timeline'
        ))
        const laterParentMessageIndex = blocks.findIndex((block) => (
            block.kind === 'agent-text' && block.text === 'Parent continued after the child started.'
        ))
        expect(childCardIndex).toBeGreaterThan(0)
        expect(childCardIndex).toBeLessThan(laterParentMessageIndex)
    })

    it.each([false, true])('keeps native subagents with their loaded conversation round (running=%s)', (runActive) => {
        const messages: CodexLocalSessionContextMessage[] = [
            { id: 'round-1', createdAt: 1, content: { role: 'user', content: { type: 'text', text: 'First task' } } },
            { id: 'reply-1', createdAt: 40, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'First result' } } } },
            { id: 'round-2', createdAt: 50, content: { role: 'user', content: { type: 'text', text: 'Second task' } } },
            { id: 'reply-2', createdAt: 90, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Second result' } } } },
            { id: 'round-3', createdAt: 100, content: { role: 'user', content: { type: 'text', text: 'Third task' } } },
            { id: 'reply-3', createdAt: 140, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Third result' } } } }
        ]
        const subagents: CodexLocalSessionSubagent[] = [10, 20, 60, 110].map((startedAt, index) => ({
            id: `child-${index}`,
            parentSessionId: 'parent-thread',
            model: null,
            modelReasoningEffort: null,
            status: 'completed',
            startedAt,
            // Late updates/trace must not move an old child into the latest round.
            updatedAt: 150,
            completedAt: 150,
            traceMessages: [{
                createdAt: 145,
                role: 'agent',
                content: { type: 'codex', data: { type: 'message', message: `Child ${index} result` } }
            }]
        }))
        const groupsForPage = (page: CodexLocalSessionContextMessage[], hasMoreMessages: boolean) => {
            const blocks = buildNativeCodexBlocks(page, [], subagents, { hasMoreMessages })
            const { visible } = buildSessionDetailTimeline(blocks, { hasMoreMessages, runActive, aggregateActiveProcess: true })
            let round: string | null = null
            return visible.flatMap((block) => {
                if (block.kind === 'user-text') round = block.id
                if (block.kind !== 'tool-group') return []
                const children = block.tools.filter((tool) => tool.tool.name === 'CodexAgent')
                return children.length ? [{ round, ids: children.map((tool) => tool.tool.id) }] : []
            })
        }

        expect(groupsForPage(messages.slice(4), true)).toEqual([
            { round: 'round-3', ids: ['native-codex-agent:child-3'] }
        ])
        expect(groupsForPage(messages.slice(2), true)).toEqual([
            { round: 'round-2', ids: ['native-codex-agent:child-2'] },
            { round: 'round-3', ids: ['native-codex-agent:child-3'] }
        ])
        expect(groupsForPage(messages, false)).toEqual([
            { round: 'round-1', ids: ['native-codex-agent:child-0', 'native-codex-agent:child-1'] },
            { round: 'round-2', ids: ['native-codex-agent:child-2'] },
            { round: 'round-3', ids: ['native-codex-agent:child-3'] }
        ])
    })

    it('does not expose historical subagents before any paginated parent messages arrive', () => {
        const blocks = buildNativeCodexBlocks([], [], [{
            id: 'historical-child', parentSessionId: 'parent', model: null, modelReasoningEffort: null,
            status: 'completed', startedAt: 10, updatedAt: 20, traceMessages: []
        }], { hasMoreMessages: true })
        expect(blocks).toEqual([])
    })

    it('renders a native child as the existing CodexAgent card', async () => {
        const api = createApi()
        ;(api.getCodexSessionSnapshot as ReturnType<typeof vi.fn>).mockImplementation(async (sessionId, machineId, options) => ({
            ...(await api.getCodexSessionContext(sessionId, machineId, options)),
            subagents: [{
                id: 'native-child-card',
                parentSessionId: sessionId,
                name: 'Ada',
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high',
                status: 'completed' as const,
                statusText: 'Completed',
                startedAt: 10,
                updatedAt: 11,
                completedAt: 11,
                traceMessages: []
            }],
            status: { success: true as const, status: 'idle' as const },
            version: { runnerEpoch: 'runner-a', revision: 1 },
            revision: 1,
            timing: { cache: 'hit' as const, durationMs: 1 }
        }))

        renderPage({ api })

        const card = await waitFor(() => {
            const element = document.querySelector<HTMLButtonElement>('[data-codex-subagent-card]')
            expect(element).not.toBeNull()
            return element!
        })
        expect(card).toHaveTextContent('Ada')
        expect(card).toHaveTextContent('gpt-5.6-terra · high')
        expect(card).toHaveAttribute('data-codex-subagent-status', 'completed')
    })

    it('reveals older subagent cards only when their parent conversation is loaded', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
        const api = createApi()
        const currentPage = await api.getCodexSessionContext('codex-thread-1', 'machine-1')
        const subagents: CodexLocalSessionSubagent[] = [-10, 10].map((startedAt, index) => ({
            id: `page-child-${index}`, parentSessionId: 'codex-thread-1', name: index ? 'Current helper' : 'Earlier helper',
            status: 'completed', startedAt, updatedAt: 20, completedAt: 20, traceMessages: []
        }))
        vi.mocked(api.getCodexSessionSnapshot).mockResolvedValue({
            ...currentPage,
            page: { limit: 50, nextBefore: 2, hasMore: true },
            subagents,
            status: { success: true, status: 'idle' },
            version: { runnerEpoch: 'runner-a', revision: 1 }, revision: 1,
            timing: { cache: 'hit', durationMs: 1 }
        })
        vi.mocked(api.getCodexSessionContext).mockImplementation(async (_sessionId, _machineId, options) => {
            expect(options?.before).toBe(2)
            return {
                ...currentPage,
                messages: [
                    { id: 'earlier-user', createdAt: -20, content: { role: 'user', content: { type: 'text', text: 'Earlier task' } } },
                    { id: 'earlier-answer', createdAt: -5, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Earlier result' } } } }
                ]
            }
        })
        renderPage({ api })

        await screen.findByText('Current helper')
        expect(screen.queryByText('Earlier helper')).not.toBeInTheDocument()
        expect(document.querySelectorAll('[data-codex-subagent-cards]')).toHaveLength(1)

        clock.mockReturnValue(500)
        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')!
        Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 0, writable: true })
        fireEvent.wheel(viewport, { deltaY: -20 })

        await screen.findByText('Earlier helper')
        const groups = document.querySelectorAll('[data-codex-subagent-cards]')
        expect(groups).toHaveLength(2)
        expect(groups[0]).toHaveTextContent('Earlier helper')
        expect(groups[0]).not.toHaveTextContent('Current helper')
        expect(groups[1]).toHaveTextContent('Current helper')
    })

    it('keeps native context compaction as an independent event block', () => {
        const blocks = buildReadOnlyCodexBlocks([
            {
                id: 'codex-local:1:0',
                createdAt: 1,
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'context_compacted' } }
                }
            }
        ])

        expect(blocks).toMatchObject([{
            kind: 'agent-event',
            event: { type: 'compact', trigger: 'auto', preTokens: 0 }
        }])
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
