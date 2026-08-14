import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary } from '@/types/api'
import { RecentCodexSessions, groupRecentCodexSessionsByDirectory } from './RecentCodexSessions'

afterEach(() => cleanup())

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
        }))
    } as unknown as ApiClient
}

describe('RecentCodexSessions', () => {
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
        expect(api.getCodexSessions).toHaveBeenCalledWith({ machineId: 'machine-1', limit: 5 })
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
        expect(screen.getAllByRole('button')).toHaveLength(2)
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
