import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as renderUi, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeCodexRealtimeProvider } from '@/lib/native-codex-realtime-context'
import { publishNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary, SessionSummary } from '@/types/api'
import {
    RECENT_CODEX_WINDOW_MS,
    RecentCodexSessions,
    groupRecentCodexSessionsByDirectory,
    mergeRecentCodexSessions
} from './RecentCodexSessions'

afterEach(() => cleanup())

function render(ui: ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })

    return renderUi(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function createApi() {
    return {
        getCodexSessions: vi.fn(async () => ({
            success: true as const,
            sessions: [{
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                lastUserMessage: 'Original prompt',
                cwd: '/workspace/project',
                file: '/tmp/rollout.jsonl',
                modifiedAt: Date.now()
            }]
        })),
        getCodexSessionContext: vi.fn(async () => ({
            success: true as const,
            session: {
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                cwd: '/workspace/project',
                modifiedAt: Date.now()
            },
            messages: [
                { role: 'user' as const, text: 'Original prompt' },
                { role: 'assistant' as const, text: 'Original response' }
            ]
        })),
        forkCodexSession: vi.fn(async () => ({
            type: 'success' as const,
            sessionId: 'new-hapi-session'
        })),
        getMachineGitBranch: vi.fn(async () => ({
            success: true as const,
            stdout: '# branch.oid abc123\n# branch.head main\n',
            stderr: '',
            exitCode: 0
        }))
    } as unknown as ApiClient
}

describe('RecentCodexSessions', () => {
    it('merges recent HAPI and native Codex rows, filters older/non-Codex rows, and de-duplicates managed transcripts', () => {
        const now = 1_800_000_000_000
        const recent = now - 60_000
        const old = now - RECENT_CODEX_WINDOW_MS - 1
        const hapiSession = {
            id: 'hapi-session-1',
            active: true,
            thinking: false,
            activeAt: recent,
            updatedAt: recent,
            metadata: {
                path: '/workspace/hapi',
                flavor: 'codex',
                name: 'Managed Codex task',
                agentSessionId: 'thread-managed'
            },
            todoProgress: null,
            pendingRequestsCount: 0,
            pendingRequestKinds: [],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: null,
            model: null,
            effort: null
        } as SessionSummary
        const rows = mergeRecentCodexSessions(
            [
                hapiSession,
                { ...hapiSession, id: 'old-hapi', updatedAt: old, metadata: { path: '/workspace/hapi', flavor: 'codex', name: 'Old task', agentSessionId: 'old-thread' } },
                { ...hapiSession, id: 'claude-session', metadata: { path: '/workspace/hapi', flavor: 'claude', name: 'Claude task' } }
            ],
            [
                {
                    id: 'thread-managed', title: 'Duplicate transcript', cwd: '/workspace/hapi', file: '/tmp/managed.jsonl', modifiedAt: recent
                },
                {
                    id: 'thread-native', title: 'Native Codex task', cwd: '/workspace/web', file: '/tmp/native.jsonl', modifiedAt: recent - 1
                },
                {
                    id: 'thread-old', title: 'Old native task', cwd: '/workspace/old', file: '/tmp/old.jsonl', modifiedAt: old
                }
            ],
            { now }
        )

        expect(rows.map((row) => `${row.source}:${row.id}`)).toEqual([
            'hapi:hapi-session-1',
            'native:thread-native'
        ])
    })

    it('renders managed and native rows from the selected runner in one list', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({
            success: true as const,
            sessions: [{
                id: 'native-thread',
                title: 'Native task',
                cwd: '/workspace/project',
                file: '/tmp/native.jsonl',
                modifiedAt: Date.now(),
                runState: 'processing' as const
            }]
        }))
        const hapiSession = {
            id: 'hapi-session',
            active: true,
            thinking: false,
            activeAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
                path: '/workspace/project',
                flavor: 'codex',
                name: 'Managed task'
            },
            todoProgress: null,
            pendingRequestsCount: 0,
            pendingRequestKinds: [],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: null,
            model: null,
            effort: null
        } as SessionSummary

        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    hapiSessions={[hapiSession]}
                    onOpen={vi.fn()}
                    onOpenHapi={vi.fn()}
                    embedded
                    hideHeader
                    recentOnly
                />
            </I18nProvider>
        )

        expect(await screen.findByText('Managed task')).toBeInTheDocument()
        expect(screen.getByText('Native task')).toBeInTheDocument()
        const sessionList = screen.getByTestId('recent-codex-sessions')
        expect(sessionList).toHaveClass('px-4', 'sm:px-6')
        expect(sessionList.querySelector('[data-session-source="native"][data-session-active="true"]')).not.toBeNull()
        expect(screen.queryByText('Running')).toBeNull()
        expect(api.getCodexSessions).toHaveBeenCalledWith({ machineId: 'machine-1', limit: 100 })
        const hapiIcon = sessionList.querySelector('[data-session-source="hapi"]')
        const nativeIcon = sessionList.querySelector('[data-session-source="native"]')
        expect(hapiIcon).not.toBeNull()
        expect(nativeIcon).not.toBeNull()
        expect(hapiIcon).toHaveAttribute('data-session-agent', 'codex')
        expect(hapiIcon?.querySelector('[title="Codex"]')).toHaveClass('text-[#4EA1FF]')
        expect(nativeIcon?.querySelector('[title="Codex"]')).toHaveClass('text-[var(--app-fg)]')
        expect(hapiIcon?.querySelector('[data-session-running-indicator]')).toHaveClass('bg-[#34C759]', 'motion-safe:animate-pulse')
        expect(nativeIcon?.querySelector('[data-session-running-indicator]')).toHaveClass('bg-[#34C759]', 'motion-safe:animate-pulse')
    })

    it('groups sessions by directory and shows only title and activity time', async () => {
        const api = createApi()
        const onOpen = vi.fn()
        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={onOpen} />
            </I18nProvider>
        )

        await waitFor(() => {
            expect(screen.getByText('Recent Codex task')).toBeInTheDocument()
        })
        expect(api.getCodexSessions).toHaveBeenCalledWith({
            machineId: 'machine-1',
            limit: 5,
            excludeHapiInitiated: true
        })
        expect(screen.getByText('project')).toBeInTheDocument()
        expect(screen.queryByText('Original prompt')).toBeNull()
        expect(screen.queryByText('/workspace/project')).toBeNull()
        expect(screen.getByText('just now')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
        expect(screen.queryByLabelText('View context')).toBeNull()
        expect(screen.queryByLabelText('Fork to new session')).toBeNull()

        // 整行只负责进入只读详情，不在列表里触发上下文或 Fork 操作。
        fireEvent.click(screen.getByRole('button', { name: 'Open Recent Codex task' }))
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({
            id: 'codex-thread-1',
            title: 'Recent Codex task'
        }))
        expect(api.getCodexSessionContext).not.toHaveBeenCalled()
        expect(api.forkCodexSession).not.toHaveBeenCalled()
    })

    it('shows the runner Git branch below each directory name without a session count', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({
            success: true as const,
            sessions: [
                {
                    id: 'codex-thread-newer',
                    title: 'Newer Codex task',
                    cwd: '/workspace/project',
                    file: '/tmp/newer-rollout.jsonl',
                    modifiedAt: Date.now()
                },
                {
                    id: 'codex-thread-older',
                    title: 'Older Codex task',
                    cwd: '/workspace/project',
                    file: '/tmp/older-rollout.jsonl',
                    modifiedAt: Date.now() - 1
                }
            ]
        }))
        api.getMachineGitBranch = vi.fn(async () => ({
            success: true as const,
            stdout: '# branch.oid abc123\n# branch.head feature/session-list\n',
            stderr: '',
            exitCode: 0,
            isWorktree: true
        }))

        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={vi.fn()} />
            </I18nProvider>
        )

        expect(await screen.findByTestId('recent-codex-directory-branch')).toHaveTextContent('feature/session-list')
        expect(api.getMachineGitBranch).toHaveBeenCalledWith('machine-1', '/workspace/project')
        expect(screen.getByTestId('recent-codex-directory-branch')).toHaveAttribute('data-git-kind', 'worktree')
        expect(screen.getByTestId('recent-codex-directory-branch')).toHaveAttribute(
            'title',
            'worktree · feature/session-list'
        )
        expect(screen.getByTestId('recent-codex-directory-branch').querySelector('[data-motion-icon="worktree"]')).not.toBeNull()
        expect(screen.getByRole('button', { name: 'Collapse project' })).not.toHaveTextContent('2')
    })

    it('creates a new session in the directory without toggling the group', async () => {
        const api = createApi()
        const onNewSessionInDirectory = vi.fn(async () => false)
        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    onOpen={vi.fn()}
                    onNewSessionInDirectory={onNewSessionInDirectory}
                />
            </I18nProvider>
        )

        await screen.findByText('Recent Codex task')
        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))

        expect(onNewSessionInDirectory).toHaveBeenCalledWith('/workspace/project')
        expect(screen.getByRole('button', { name: 'Collapse project' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('shows a short success morph after a directory session is created', async () => {
        const api = createApi()
        const onNewSessionInDirectory = vi.fn(async () => true)
        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    onOpen={vi.fn()}
                    onNewSessionInDirectory={onNewSessionInDirectory}
                />
            </I18nProvider>
        )

        await screen.findByText('Recent Codex task')
        const createButton = screen.getByRole('button', { name: 'New session in this directory' })
        expect(createButton.querySelector('[data-motion-icon="plus"]')).not.toBeNull()

        fireEvent.click(createButton)
        await waitFor(() => {
            expect(onNewSessionInDirectory).toHaveBeenCalledWith('/workspace/project')
            expect(createButton.querySelector('[data-motion-icon="check"]')).not.toBeNull()
        })
    })

    it('does not offer quick creation for sessions without a directory', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({
            success: true as const,
            sessions: [{
                id: 'codex-thread-no-directory',
                title: 'No directory task',
                cwd: null,
                file: '/tmp/rollout.jsonl',
                modifiedAt: Date.now()
            }]
        }))
        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    onOpen={vi.fn()}
                    onNewSessionInDirectory={vi.fn()}
                />
            </I18nProvider>
        )

        await screen.findByText('No directory task')
        expect(screen.queryByRole('button', { name: 'New session in this directory' })).toBeNull()
    })

    it('refreshes the matching runner list from a native transcript invalidation', async () => {
        const api = createApi()
        render(
            <NativeCodexRealtimeProvider value={{ connected: true }}>
                <I18nProvider>
                    <RecentCodexSessions
                        api={api}
                        machineId="machine-1"
                        onOpen={vi.fn()}
                        realtimeAvailable
                    />
                </I18nProvider>
            </NativeCodexRealtimeProvider>
        )

        await screen.findByText('Recent Codex task')
        expect(api.getCodexSessions).toHaveBeenCalledTimes(1)

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'another-machine',
            codexSessionId: 'codex-thread-1'
        })
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(api.getCodexSessions).toHaveBeenCalledTimes(1)

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1'
        })
        await waitFor(() => {
            expect(api.getCodexSessions).toHaveBeenCalledTimes(2)
        })
        expect(api.getCodexSessions).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            limit: 5,
            excludeHapiInitiated: true,
            forceRefresh: true
        })
    })

    it('patches a current-runner list row from its realtime summary without another fetch', async () => {
        const api = createApi()
        render(
            <NativeCodexRealtimeProvider value={{ connected: true }}>
                <I18nProvider>
                    <RecentCodexSessions
                        api={api}
                        machineId="machine-1"
                        onOpen={vi.fn()}
                        realtimeAvailable
                    />
                </I18nProvider>
            </NativeCodexRealtimeProvider>
        )

        await screen.findByText('Recent Codex task')
        expect(api.getCodexSessions).toHaveBeenCalledTimes(1)

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            summary: {
                id: 'codex-thread-1',
                title: 'Updated without refetch',
                lastUserMessage: 'new prompt',
                cwd: '/workspace/project',
                modifiedAt: Date.now(),
                runState: 'processing'
            }
        })

        expect(await screen.findByText('Updated without refetch')).toBeInTheDocument()
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(api.getCodexSessions).toHaveBeenCalledTimes(1)
    })

    it('orders projects and sessions by their latest activity', () => {
        const groups = groupRecentCodexSessionsByDirectory([
            {
                id: 'older', title: 'Older task', cwd: '/work/hapi', file: '/tmp/older.jsonl', modifiedAt: 10
            },
            {
                id: 'newest', title: 'Newest task', cwd: '/work/web', file: '/tmp/newest.jsonl', modifiedAt: 30
            },
            {
                id: 'middle', title: 'Middle task', cwd: '/work/hapi', file: '/tmp/middle.jsonl', modifiedAt: 20
            }
        ])

        expect(groups.map((group) => group.directory)).toEqual(['/work/web', '/work/hapi'])
        expect(groups[1]?.sessions.map((session) => session.id)).toEqual(['middle', 'older'])
    })

    it('keeps a single per-session action while exposing module-level refresh', async () => {
        const api = createApi()
        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={vi.fn()} />
            </I18nProvider>
        )

        await waitFor(() => {
            expect(screen.getByText('Recent Codex task')).toBeInTheDocument()
        })
        // 可点击的整行是导航入口；列表不添加上下文/Fork 等分散操作。
        expect(screen.queryByLabelText('View context')).toBeNull()
        expect(screen.queryByLabelText('Fork to new session')).toBeNull()
        expect(screen.getByLabelText('Refresh')).toBeInTheDocument()
        expect(screen.getAllByRole('button')).toHaveLength(3)
    })

    it('expands and collapses each directory while keeping the session rows indented under it', async () => {
        const api = createApi()
        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={vi.fn()} />
            </I18nProvider>
        )

        await screen.findByText('Recent Codex task')
        const collapseButton = screen.getByRole('button', { name: 'Collapse project' })
        expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
        expect(collapseButton.querySelector('[data-motion-icon="folder-open"]')).toHaveClass('h-[27.5px]', 'w-[27.5px]')
        expect(collapseButton.closest('[data-directory]')?.querySelector('ul.border-l')).not.toBeNull()

        fireEvent.click(collapseButton)
        expect(screen.queryByText('Recent Codex task')).toBeNull()
        const expandButton = screen.getByRole('button', { name: 'Expand project' })
        expect(expandButton).toHaveAttribute('aria-expanded', 'false')
        expect(expandButton.querySelector('[data-motion-icon="folder"]')).not.toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Expand project' }))
        expect(screen.getByText('Recent Codex task')).toBeInTheDocument()
    })

    it('marks a running native turn with a subtle activity indicator instead of text', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({
            success: true as const,
            sessions: [{
                id: 'codex-thread-running',
                title: 'Running Codex task',
                cwd: '/workspace/project',
                file: '/tmp/running-rollout.jsonl',
                modifiedAt: Date.now(),
                runState: 'processing' as const
            }]
        }))

        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={vi.fn()} />
            </I18nProvider>
        )

        expect(await screen.findByText('Running Codex task')).toBeInTheDocument()
        expect(screen.getByTestId('recent-codex-sessions').querySelector('[data-session-source="native"][data-session-active="true"]')).not.toBeNull()
        expect(screen.queryByText('Running')).toBeNull()
    })

    it('can restrict the view to native sessions that are currently processing', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({
            success: true as const,
            sessions: [
                {
                    id: 'codex-thread-idle',
                    title: 'Idle Codex task',
                    cwd: '/workspace/project',
                    file: '/tmp/idle-rollout.jsonl',
                    modifiedAt: 20,
                    runState: 'idle' as const
                },
                {
                    id: 'codex-thread-processing',
                    title: 'Processing Codex task',
                    cwd: '/workspace/project',
                    file: '/tmp/processing-rollout.jsonl',
                    modifiedAt: 10,
                    runState: 'processing' as const
                }
            ]
        }))

        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    onOpen={vi.fn()}
                    onlyProcessing
                />
            </I18nProvider>
        )

        expect(await screen.findByText('Processing Codex task')).toBeInTheDocument()
        expect(screen.queryByText('Idle Codex task')).toBeNull()
    })

    it('turns the default-namespace response into a concise workspace hint', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => {
            throw new Error('HTTP 403 Forbidden: {"error":"Codex transcript import is not available outside the default namespace"}')
        })

        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={vi.fn()} />
            </I18nProvider>
        )

        expect(await screen.findByText('Native Codex sessions are available from the default workspace only.')).toBeInTheDocument()
        expect(screen.queryByText(/HTTP 403 Forbidden/)).toBeNull()
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    })

    it('refreshes from the selected runner without clearing visible sessions', async () => {
        const api = createApi()
        let resolveRefresh!: (value: { success: true; sessions: CodexLocalSessionSummary[] }) => void
        const refreshResponse = new Promise<{ success: true; sessions: CodexLocalSessionSummary[] }>((resolve) => {
            resolveRefresh = resolve
        })
        api.getCodexSessions = vi.fn()
            .mockResolvedValueOnce({
                success: true as const,
                sessions: [{
                    id: 'codex-thread-1',
                    title: 'Recent Codex task',
                    lastUserMessage: 'Original prompt',
                    cwd: '/workspace/project',
                    file: '/tmp/rollout.jsonl',
                    modifiedAt: Date.now()
                }]
            })
            .mockImplementationOnce(() => refreshResponse)

        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId="machine-1" onOpen={vi.fn()} />
            </I18nProvider>
        )

        await screen.findByText('Recent Codex task')
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

        expect(screen.getByText('Recent Codex task')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Refresh' }).querySelector('[data-motion-icon="loader"]')).not.toBeNull()

        resolveRefresh({
            success: true,
            sessions: [{
                id: 'codex-thread-2',
                title: 'Fresh Codex task',
                lastUserMessage: 'Newest prompt',
                cwd: '/workspace/project',
                file: '/tmp/fresh-rollout.jsonl',
                modifiedAt: Date.now()
            }]
        })

        await waitFor(() => {
            expect(api.getCodexSessions).toHaveBeenCalledTimes(2)
            expect(screen.getByText('Fresh Codex task')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Refresh' }).querySelector('[data-motion-icon="check"]')).not.toBeNull()
        })
        expect(api.getCodexSessions).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            limit: 5,
            excludeHapiInitiated: true,
            forceRefresh: true
        })
    })

    it('keeps the module visible and explains why refresh is unavailable without a runner', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({ success: true as const, sessions: [] }))
        render(
            <I18nProvider>
                <RecentCodexSessions api={api} machineId={null} onOpen={vi.fn()} />
            </I18nProvider>
        )

        expect(await screen.findByText('Select an online runner first.')).toBeInTheDocument()
        expect(screen.getByTestId('recent-codex-sessions')).toBeInTheDocument()
        expect(api.getCodexSessions).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    })
})
