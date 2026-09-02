import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeCodexRealtimeProvider } from '@/lib/native-codex-realtime-context'
import { publishNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'
import { resetInteractionPriorityForTests } from '@/lib/interaction-priority'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary, SessionSummary } from '@/types/api'
import {
    COMPLETED_SESSION_DIRECTORY_COLORS,
    RECENT_CODEX_WINDOW_MS,
    RecentCodexSessions,
    assignCompletedSessionDirectoryColors,
    formatKanbanSessionTime,
    getCompletedSessionDirectoryColor,
    getMergedCodexKanbanStatus,
    groupMergedCodexCompletedTimeline,
    groupMergedCodexSessionsForKanban,
    groupRecentCodexSessionsByDirectory,
    mergeRecentCodexSessions,
    type MergedCodexSession
} from './RecentCodexSessions'

afterEach(() => {
    cleanup()
    resetInteractionPriorityForTests()
    vi.useRealTimers()
    localStorage.removeItem('hapi-lang')
})

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
        })),
        archiveSession: vi.fn(async () => {}),
        archiveCodexSession: vi.fn(async () => ({ success: true as const }))
    } as unknown as ApiClient
}

describe('RecentCodexSessions', () => {
    it('assigns completed cards a stable color from their directory', () => {
        const projectColor = getCompletedSessionDirectoryColor('/workspace/project/')
        expect(projectColor).toBe(getCompletedSessionDirectoryColor('/workspace/project'))
        expect(COMPLETED_SESSION_DIRECTORY_COLORS).toContain(projectColor)
        expect(getCompletedSessionDirectoryColor(null)).toBeNull()
        expect(getCompletedSessionDirectoryColor('   ')).toBeNull()

        const assignments = assignCompletedSessionDirectoryColors([
            '/workspace/project',
            '/workspace/other',
            '/workspace/project/'
        ])
        expect(assignments.size).toBe(2)
        expect(assignments.get('/workspace/project')).not.toBe(assignments.get('/workspace/other'))
    })

    it('uses localized relative labels for today and clock time for earlier dates', () => {
        const now = new Date(2026, 8, 1, 12, 0, 0).getTime()
        const english = (key: string, params?: Record<string, string | number>) => ({
            'session.time.justNow': 'just now',
            'session.time.minutesAgo': `${params?.n}m ago`,
            'session.time.hoursAgo': `${params?.n}h ago`
        })[key] ?? key
        const chinese = (key: string, params?: Record<string, string | number>) => ({
            'session.time.justNow': '刚刚',
            'session.time.minutesAgo': `${params?.n} 分钟前`,
            'session.time.hoursAgo': `${params?.n} 小时前`
        })[key] ?? key

        expect(formatKanbanSessionTime(now - 20_000, now, 'en-US', english)).toBe('just now')
        expect(formatKanbanSessionTime(now - 5 * 60_000, now, 'zh-CN', chinese)).toBe('5 分钟前')
        expect(formatKanbanSessionTime(now - 3 * 60 * 60_000, now, 'en-US', english)).toBe('3h ago')
        expect(formatKanbanSessionTime(new Date(2026, 7, 31, 9, 15, 0).getTime(), now, 'en-US', english)).toBe('09:15:00')
    })

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
                {
                    ...hapiSession,
                    id: 'archived-hapi',
                    metadata: {
                        path: '/workspace/hapi',
                        flavor: 'codex',
                        name: 'Archived task',
                        agentSessionId: 'archived-thread',
                        lifecycleState: 'archived'
                    }
                },
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
                    id: 'archived-thread', title: 'Archived duplicate transcript', cwd: '/workspace/hapi', file: '/tmp/archived.jsonl', modifiedAt: recent - 2
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

    it('keeps pinned action and thinking cards in their higher-priority groups', () => {
        const now = 1_800_000_000_000
        const pending = {
            id: 'hapi-pending',
            active: true,
            thinking: false,
            activeAt: now,
            updatedAt: now - 10,
            metadata: { path: '/workspace/project', flavor: 'codex', name: 'Needs confirmation' },
            todoProgress: null,
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: null,
            model: null,
            effort: null
        } as SessionSummary
        const processing = {
            ...pending,
            id: 'hapi-processing',
            updatedAt: now - 20,
            metadata: { path: '/workspace/project', flavor: 'codex', name: 'Processing' },
            pendingRequestsCount: 0,
            pendingRequestKinds: [],
            thinking: true
        } as SessionSummary
        const rows = mergeRecentCodexSessions(
            [pending, processing],
            [
                {
                    id: 'native-newer-completed',
                    title: 'Newer completed',
                    cwd: '/workspace/project',
                    file: '/tmp/newer-completed.jsonl',
                    modifiedAt: now - 5,
                    runState: 'idle'
                },
                {
                    id: 'native-completed',
                    title: 'Pinned completed',
                    cwd: '/workspace/project',
                    file: '/tmp/completed.jsonl',
                    modifiedAt: now - 30,
                    runState: 'idle'
                }
            ],
            { now }
        )

        const groups = groupMergedCodexSessionsForKanban(rows, new Set([
            'hapi:hapi-pending',
            'hapi:hapi-processing',
            'native:native-completed'
        ]))

        expect(groups.map((group) => [group.id, group.sessions.map((session) => session.id)])).toEqual([
            ['pending', ['hapi-pending']],
            ['processing', ['hapi-processing']],
            ['pinned', ['native-completed']],
            ['completed', ['native-newer-completed']]
        ])
    })

    it('sorts thinking cards by directory and stable identity instead of activity time', () => {
        const session = (id: string, cwd: string, modifiedAt: number): MergedCodexSession => ({
            key: `native:${id}`,
            id,
            title: id,
            cwd,
            modifiedAt,
            source: 'native',
            active: true,
            nativeSession: {
                id,
                title: id,
                cwd,
                file: `/tmp/${id}.jsonl`,
                modifiedAt,
                runState: 'processing'
            }
        })
        const groups = groupMergedCodexSessionsForKanban([
            session('zeta', '/workspace/zeta', 400),
            session('alpha-b', '/workspace/alpha', 300),
            session('beta', '/workspace/beta', 200),
            session('alpha-a', '/workspace/alpha', 100)
        ])

        expect(groups.find((group) => group.id === 'processing')?.sessions.map((item) => item.id)).toEqual([
            'alpha-a',
            'alpha-b',
            'beta',
            'zeta'
        ])
    })

    it('uses true work state for HAPI and native Kanban groups', () => {
        const now = 1_800_000_000_000
        const base = {
            id: 'base',
            active: true,
            thinking: false,
            activeAt: now,
            updatedAt: now,
            metadata: { path: '/workspace/project', flavor: 'codex', name: 'Task' },
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
        const rows = mergeRecentCodexSessions([
            { ...base, id: 'online-idle' },
            { ...base, id: 'thinking', thinking: true },
            { ...base, id: 'background', backgroundTaskCount: 1 },
            { ...base, id: 'pending', thinking: true, pendingRequestsCount: 1 }
        ], [
            { id: 'native-processing', title: 'Native processing', cwd: '/workspace', file: '/tmp/1', modifiedAt: now, runState: 'processing' as const },
            { id: 'native-idle', title: 'Native idle', cwd: '/workspace', file: '/tmp/2', modifiedAt: now - 1, runState: 'idle' as const },
            { id: 'native-unknown', title: 'Native unknown', cwd: '/workspace', file: '/tmp/3', modifiedAt: now - 2, runState: 'unknown' as const }
        ], { now })

        expect(Object.fromEntries(rows.map((row) => [row.id, getMergedCodexKanbanStatus(row)]))).toEqual({
            'online-idle': 'completed',
            thinking: 'processing',
            background: 'processing',
            pending: 'pending',
            'native-processing': 'processing',
            'native-idle': 'completed',
            'native-unknown': 'completed'
        })
    })

    it('groups completed cards by local date and normalizes seconds timestamps', () => {
        const now = new Date(2026, 7, 13, 12, 0, 0)
        const localAt = (daysAgo: number) => new Date(2026, 7, 13 - daysAgo, 10, 0, 0).getTime()
        const session = (id: string, modifiedAt: number): MergedCodexSession => ({
            key: `native:${id}`,
            id,
            title: id,
            cwd: '/workspace',
            modifiedAt,
            source: 'native',
            active: false,
            nativeSession: { id, title: id, cwd: '/workspace', file: `/tmp/${id}`, modifiedAt, runState: 'idle' }
        })
        const groups = groupMergedCodexCompletedTimeline([
            session('today-newer', localAt(0) + 1_000),
            session('today-seconds', Math.floor(localAt(0) / 1000)),
            session('yesterday-ms', localAt(1)),
            session('three-days', localAt(3)),
            session('old', localAt(8))
        ], now, 'en-US', {
            today: 'Today',
            yesterday: 'Yesterday',
            daysAgo: (days) => `${days} days ago`
        })

        expect(groups.map((group) => [group.label, group.shares.map((item) => item.id)])).toEqual([
            ['Today', ['today-newer', 'today-seconds']],
            ['Yesterday', ['yesterday-ms']],
            ['3 days ago', ['three-days']],
            [new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(localAt(8))), ['old']]
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
            thinking: true,
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

    it('renders priority-ordered Kanban groups, one completed count, and a quiet thinking animation', async () => {
        const api = createApi()
        api.getCodexSessions = vi.fn(async () => ({
            success: true as const,
            sessions: [
                {
                    id: 'codex-thread-1',
                    title: 'Pinned Codex task',
                    cwd: '/workspace/project',
                    file: '/tmp/pinned-rollout.jsonl',
                    modifiedAt: Date.now(),
                    runState: 'idle' as const
                },
                {
                    id: 'codex-thread-2',
                    title: 'Completed Codex task',
                    cwd: '/workspace/other',
                    file: '/tmp/completed-rollout.jsonl',
                    modifiedAt: Date.now() - 1,
                    runState: 'idle' as const
                }
            ]
        }))
        api.getMachineGitBranch = vi.fn(async () => ({
            success: true as const,
            stdout: '# branch.oid abc123\n# branch.head feature/kanban\n',
            stderr: '',
            exitCode: 0,
            isWorktree: true,
            isDirty: true
        }))
        const onTogglePin = vi.fn()
        const hapiSession = {
            id: 'hapi-pending',
            active: true,
            thinking: false,
            activeAt: Date.now(),
            updatedAt: Date.now(),
            metadata: {
                path: '/workspace/project',
                flavor: 'codex',
                name: 'Needs confirmation'
            },
            todoProgress: null,
            pendingRequestsCount: 1,
            pendingRequestKinds: ['permission'],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: null,
            model: null,
            effort: null
        } as SessionSummary
        const thinkingSession = {
            ...hapiSession,
            id: 'hapi-thinking',
            metadata: {
                ...hapiSession.metadata,
                name: 'Thinking task'
            },
            pendingRequestsCount: 0,
            pendingRequestKinds: [],
            thinking: true
        } as SessionSummary

        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    hapiSessions={[hapiSession, thinkingSession]}
                    onOpen={vi.fn()}
                    onOpenHapi={vi.fn()}
                    embedded
                    hideHeader
                    recentOnly
                    viewMode="kanban"
                    pinnedSessionKeys={new Set(['native:codex-thread-1'])}
                    onTogglePin={onTogglePin}
                />
            </I18nProvider>
        )

        const board = await screen.findByTestId('session-kanban-board')
        expect([...board.querySelectorAll('[data-kanban-group]')].map((group) => group.getAttribute('data-kanban-group'))).toEqual([
            'pending',
            'processing',
            'pinned',
            'completed'
        ])
        const pinnedGroup = board.querySelector('[data-kanban-group="pinned"]')
        expect(pinnedGroup).toHaveTextContent('Pinned')
        expect(pinnedGroup).toHaveTextContent('Pinned Codex task')
        const pendingGroup = board.querySelector('[data-kanban-group="pending"]')
        expect(pendingGroup).toHaveTextContent('Needs confirmation')
        expect(pendingGroup?.querySelector('[data-kanban-group-count]')).toBeNull()
        const processingGroup = board.querySelector('[data-kanban-group="processing"]')
        expect(processingGroup).toHaveTextContent('thinking')
        expect(processingGroup?.querySelector('[data-kanban-thinking-label]')).toHaveTextContent('thinking...')
        expect(processingGroup?.querySelector('.session-kanban-thinking-dot-second')).not.toBeNull()
        expect(processingGroup?.querySelector('.session-kanban-thinking-dot-third')).not.toBeNull()
        expect(processingGroup?.querySelector('[data-kanban-group-count]')).toBeNull()
        expect(pinnedGroup?.querySelector('[data-kanban-group-count]')).toBeNull()
        expect(board.querySelectorAll('[data-kanban-group-count]')).toHaveLength(0)
        expect(processingGroup).toHaveTextContent('Thinking task')
        expect(processingGroup?.querySelector('.session-kanban-card-thinking')).not.toBeNull()
        expect(processingGroup?.querySelector('.motion-safe\\:animate-pulse')).not.toBeNull()
        expect(processingGroup?.querySelector('[data-kanban-card-time]')).toBeNull()
        const completedGroup = board.querySelector('[data-kanban-group="completed"]')
        expect(completedGroup).toHaveTextContent('Completed Codex task')
        const completedDivider = completedGroup?.querySelector('[data-kanban-completed-divider]')
        expect(completedDivider).toHaveAttribute('role', 'separator')
        expect(completedDivider).toHaveTextContent('Completed·1')
        expect(completedDivider?.querySelectorAll('[data-kanban-divider-line]')).toHaveLength(2)
        expect(completedDivider?.querySelector('[data-motion-icon="completed"]')).not.toBeNull()
        expect(board.querySelectorAll('[data-kanban-card-column]')).toHaveLength(4)
        for (const column of board.querySelectorAll('[data-kanban-card-column]')) {
            expect(column).toHaveClass('pl-5')
        }
        const pendingCard = board.querySelector('[data-kanban-card-status="pending"]')
        expect(pendingCard?.querySelector('time')).toBeNull()
        expect(pendingCard?.closest('li')?.querySelector('[data-kanban-card-time]')).not.toBeNull()
        expect(pendingCard).not.toHaveAttribute('data-kanban-directory-color')
        const completedCard = board.querySelector('[data-kanban-card-status="completed"]')
        const projectColor = getCompletedSessionDirectoryColor('/workspace/project')
        expect(completedCard).toHaveAttribute('data-kanban-directory-color', projectColor)
        expect(completedCard).toHaveStyle({ borderLeftColor: projectColor })
        expect(board.querySelector('[data-git-kind="worktree"]')).toHaveAttribute('title', 'worktree · feature/kanban')
        expect(board.querySelector('[data-git-kind="worktree"] [data-motion-icon="worktree"]')).not.toBeNull()
        expect(board.querySelector('[data-git-kind="worktree"] [data-git-dirty]')).toHaveAttribute(
            'aria-label',
            'Uncommitted changes'
        )

        const unpinButton = screen.getByRole('button', { name: 'Unpin session' })
        expect(unpinButton).toHaveClass('text-[var(--app-link)]')
        expect(unpinButton).not.toHaveClass('bg-[var(--app-link)]')
        fireEvent.click(unpinButton)
        expect(onTogglePin).toHaveBeenCalledWith('native:codex-thread-1')
    })

    it('keeps card controls outside navigation, lays out the compact card, and archives a native thread after confirmation', async () => {
        const api = createApi()
        const onOpen = vi.fn()
        render(
            <I18nProvider>
                <RecentCodexSessions
                    api={api}
                    machineId="machine-1"
                    hapiSessions={[]}
                    onOpen={onOpen}
                    onOpenHapi={vi.fn()}
                    embedded
                    hideHeader
                    recentOnly
                    viewMode="kanban"
                    onTogglePin={vi.fn()}
                />
            </I18nProvider>
        )

        const board = await screen.findByTestId('session-kanban-board')
        const card = board.querySelector('.session-kanban-card')
        expect(card).toHaveClass('min-h-24')
        expect(card).not.toHaveClass('min-h-[9.75rem]')
        const topRow = card?.querySelector('[data-kanban-card-top-row]')
        expect(topRow?.querySelector('[data-session-source="native"]')).not.toBeNull()
        expect(topRow).toHaveTextContent('Recent Codex task')
        const directoryRow = card?.querySelector('[data-kanban-directory-row]')
        expect(directoryRow?.querySelector('[data-motion-icon="folder"]')).not.toBeNull()
        expect(directoryRow).toHaveTextContent('project')
        expect(directoryRow?.querySelector('[data-kanban-directory]')).toHaveClass('font-normal')
        const cardTime = board.querySelector('[data-kanban-card-time]')
        expect(cardTime).toHaveTextContent('just now')
        expect(cardTime?.nextElementSibling?.querySelector('.session-kanban-card')).toBe(card)
        expect(card?.querySelector('.text-\\[17px\\]')).toHaveTextContent('Recent Codex task')
        expect(screen.getByRole('button', { name: 'Pin session' })).toBeInTheDocument()
        const archiveButton = board.querySelector('[data-kanban-archive]') as HTMLButtonElement
        expect(archiveButton).toHaveClass('bottom-1', 'right-1', 'h-11', 'w-11')

        fireEvent.click(archiveButton)
        expect(onOpen).not.toHaveBeenCalled()
        expect(await screen.findByText('Archive session')).toBeInTheDocument()
        const archiveButtons = screen.getAllByRole('button', { name: 'Archive' })
        fireEvent.click(archiveButtons.at(-1)!)

        await waitFor(() => {
            expect(api.archiveCodexSession).toHaveBeenCalledWith('codex-thread-1', { machineId: 'machine-1' })
            expect(screen.queryByText('Recent Codex task')).toBeNull()
        })
        expect(onOpen).not.toHaveBeenCalled()
    })

    it('uses the HAPI archive endpoint for a managed card', async () => {
        const api = createApi()
        const hapiSession = {
            id: 'hapi-idle',
            active: true,
            thinking: false,
            activeAt: Date.now(),
            updatedAt: Date.now(),
            metadata: { path: '/workspace/project', flavor: 'codex', name: 'HAPI idle task' },
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
                    viewMode="kanban"
                />
            </I18nProvider>
        )

        await screen.findByText('HAPI idle task')
        expect(screen.getByTestId('session-kanban-board').querySelector('[data-kanban-date-group]')).not.toBeNull()
        expect(screen.getByText('Today')).toBeInTheDocument()
        const card = screen.getByText('HAPI idle task').closest('li')!
        fireEvent.click(card.querySelector('[data-kanban-archive]')!)
        const archiveButtons = screen.getAllByRole('button', { name: 'Archive' })
        fireEvent.click(archiveButtons.at(-1)!)
        await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith('hapi-idle'))
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
            isWorktree: true,
            isDirty: true
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
        expect(screen.getByTestId('recent-codex-directory-branch').querySelector('[data-git-dirty]')).toHaveAttribute(
            'aria-label',
            'Uncommitted changes'
        )
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

    it('batches realtime summary updates by session id and applies the newest row after the window', async () => {
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
        vi.useFakeTimers()
        const modifiedAt = Date.now()

        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            summary: {
                id: 'codex-thread-1',
                title: 'First batched update',
                cwd: '/workspace/project',
                modifiedAt: modifiedAt + 1
            }
        })

        expect(screen.queryByText('First batched update')).toBeNull()
        expect(screen.getByText('Recent Codex task')).toBeInTheDocument()

        act(() => {
            vi.advanceTimersByTime(50)
        })
        publishNativeCodexSessionUpdated({
            type: 'codex-session-updated',
            machineId: 'machine-1',
            codexSessionId: 'codex-thread-1',
            summary: {
                id: 'codex-thread-1',
                title: 'Newest batched update',
                cwd: '/workspace/project',
                modifiedAt: modifiedAt + 2
            }
        })

        expect(screen.queryByText('First batched update')).toBeNull()
        expect(screen.queryByText('Newest batched update')).toBeNull()

        act(() => {
            vi.advanceTimersByTime(50)
            vi.advanceTimersByTime(1)
        })

        expect(screen.queryByText('First batched update')).toBeNull()
        expect(screen.getByText('Newest batched update')).toBeInTheDocument()
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
