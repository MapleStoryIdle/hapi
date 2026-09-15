import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionList } from './SessionList'

afterEach(() => cleanup())

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                {children}
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionList directory action', () => {
    it('keeps rename out of the session-list popup', () => {
        const session = makeSession({
            id: 'session-menu',
            active: true,
            metadata: { path: '/work/hapi', name: 'Menu task', flavor: 'codex' }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        fireEvent.contextMenu(screen.getByText('Menu task').closest('button')!)

        expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull()
        expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument()
    })

    it('adds a breathing status dot to an active session', () => {
        const session = makeSession({
            id: 'session-active',
            active: true,
            metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        const row = screen.getByText('Running task').closest('button')
        const statusDot = row?.querySelector('span.absolute')

        expect(statusDot?.className).toContain('motion-safe:animate-pulse')
    })

    it('starts a new session with the project machine and directory', () => {
        const onNewSessionInDirectory = vi.fn()
        const session = makeSession({
            id: 'session-1',
            updatedAt: Date.now(),
            metadata: {
                path: '/home/ubuntu',
                machineId: 'machine-1',
                name: 'Greeting',
                flavor: 'codex',
            }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={onNewSessionInDirectory}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
                machineLabelsById={{ 'machine-1': 'Mint' }}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'New session in this directory' }))

        expect(onNewSessionInDirectory).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/home/ubuntu',
        })
    })

    it('hides the directory action for sessions without path metadata', () => {
        renderWithProviders(
            <SessionList
                sessions={[makeSession({ id: 'session-without-path' })]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onNewSessionInDirectory={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={null}
            />
        )

        expect(screen.queryByRole('button', { name: 'New session in this directory' })).toBeNull()
    })

    it('shows a fetched Git branch below the larger project name', async () => {
        const getMachineGitBranch = vi.fn(async () => ({
            success: true,
            stdout: '# branch.oid abc123\n# branch.head feature/list-branch\n',
            stderr: '',
            exitCode: 0
        }))
        const session = makeSession({
            id: 'session-git',
            active: true,
            metadata: { path: '/work/hapi', machineId: 'machine-1', name: 'List task', flavor: 'codex' }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={{ getMachineGitBranch } as unknown as ApiClient}
            />
        )

        const projectName = screen.getByTestId('session-project-name')
        expect(projectName).toHaveTextContent('hapi')
        expect(projectName).toHaveClass('text-[17px]')
        expect(screen.getByTitle('/work/hapi').querySelector('svg')).toHaveClass('h-[25px]', 'w-[25px]')
        expect(await screen.findByTestId('session-project-branch')).toHaveTextContent('feature/list-branch')
        expect(screen.getByTestId('session-project-branch')).toHaveAttribute('data-git-kind', 'branch')
        expect(screen.getByTestId('session-project-branch').querySelector('[data-motion-icon="branch"]')).not.toBeNull()
        expect(getMachineGitBranch).toHaveBeenCalledWith('machine-1', '/work/hapi')
    })

    it('does not add a branch subtitle when the directory is not a Git project', async () => {
        const getMachineGitBranch = vi.fn(async () => ({
            success: false,
            error: 'not a git repository',
            stderr: 'not a git repository',
            exitCode: 128
        }))
        const session = makeSession({
            id: 'session-not-git',
            active: true,
            metadata: { path: '/work/plain-directory', machineId: 'machine-1', name: 'Plain task', flavor: 'codex' }
        })

        renderWithProviders(
            <SessionList
                sessions={[session]}
                selectedSessionId={null}
                onSelect={vi.fn()}
                onNewSession={vi.fn()}
                onRefresh={vi.fn()}
                isLoading={false}
                renderHeader={false}
                api={{ getMachineGitBranch } as unknown as ApiClient}
            />
        )

        await waitFor(() => expect(getMachineGitBranch).toHaveBeenCalledWith('machine-1', '/work/plain-directory'))
        expect(screen.queryByTestId('session-project-branch')).toBeNull()
    })
})

describe('SessionList collapse behavior', () => {
    function renderSessionList(sessions: SessionSummary[], selectedSessionId: string | null = 'session-running') {
        return (
            <QueryClientProvider client={new QueryClient({
                defaultOptions: {
                    queries: { retry: false },
                    mutations: { retry: false },
                }
            })}>
                <I18nProvider>
                    <SessionList
                        sessions={sessions}
                        selectedSessionId={selectedSessionId}
                        onSelect={vi.fn()}
                        onNewSession={vi.fn()}
                        onRefresh={vi.fn()}
                        isLoading={false}
                        renderHeader={false}
                        api={null}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )
    }

    function getProjectPanel(): Element {
        const header = screen.getByTitle('/work/hapi')
        const panel = header.nextElementSibling
        if (!panel) {
            throw new Error('Expected project collapse panel')
        }
        return panel
    }

    it('keeps a selected running path collapsed across live session-list refreshes', async () => {
        const baseSessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                pendingRequestsCount: 1,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-old',
                updatedAt: 50,
                metadata: { path: '/work/hapi', name: 'Older task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(baseSessions))

        expect(getProjectPanel().getAttribute('data-open')).toBe('true')

        fireEvent.click(screen.getByTitle('/work/hapi'))
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList([
            {
                ...baseSessions[0]!,
                pendingRequestsCount: 2,
                updatedAt: 200,
            },
            baseSessions[1]!
        ]))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBeNull()
        })
    })

    it('auto-expands the path again when the selected session changes', async () => {
        const sessions = [
            makeSession({
                id: 'session-running',
                active: true,
                thinking: true,
                updatedAt: 100,
                metadata: { path: '/work/hapi', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'session-next',
                updatedAt: 90,
                metadata: { path: '/work/hapi', name: 'Next task', flavor: 'codex' },
            })
        ]
        const { rerender } = render(renderSessionList(sessions))

        fireEvent.click(screen.getByTitle('/work/hapi'))
        expect(getProjectPanel().getAttribute('data-open')).toBeNull()

        rerender(renderSessionList(sessions, 'session-next'))

        await waitFor(() => {
            expect(getProjectPanel().getAttribute('data-open')).toBe('true')
        })
    })

    it('does not mount rows for a collapsed project until the project is opened', () => {
        const sessions = [
            makeSession({
                id: 'running-session',
                active: true,
                updatedAt: 200,
                metadata: { path: '/work/current', name: 'Running task', flavor: 'codex' },
            }),
            makeSession({
                id: 'archived-session',
                updatedAt: 100,
                metadata: { path: '/work/archive', name: 'Archived task', flavor: 'codex' },
            })
        ]

        render(renderSessionList(sessions, null))

        expect(screen.queryByText('Archived task')).toBeNull()

        fireEvent.click(screen.getByTitle('/work/archive'))

        expect(screen.getByText('Archived task')).toBeInTheDocument()
    })
})
