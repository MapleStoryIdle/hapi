import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { I18nProvider } from '@/lib/i18n-context'
import { GitBranchesDrawer } from './GitBranchesDrawer'

afterEach(() => cleanup())

const TEST_CWD = '/Users/dev/IdeaProjects/github/hapi'

function ToastProbe() {
    const { toasts } = useToast()
    return <div data-testid="toast-probe">{toasts.at(-1)?.title}</div>
}

function response(overrides: Record<string, unknown> = {}) {
    return {
        success: true as const,
        currentBranch: 'feature/mobile',
        isDirty: true,
        changedFileCount: 3,
        additions: 26,
        deletions: 8,
        pushRemote: 'origin',
        upstream: 'origin/feature/mobile',
        canUpdate: true,
        localBranches: [
            { ref: 'feature/mobile', name: 'feature/mobile' },
            { ref: 'main', name: 'main' }
        ],
        remoteBranches: [
            { ref: 'origin/main', name: 'main' },
            { ref: 'origin/feature/remote', name: 'feature/remote' }
        ],
        ...overrides
    }
}

function renderDrawer(api: ApiClient) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <GitBranchesDrawer
                        api={api}
                        machineId="machine-1"
                        cwd={TEST_CWD}
                        open
                        onOpenChange={vi.fn()}
                    />
                    <ToastProbe />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('GitBranchesDrawer', () => {
    it('uses a fixed Git Branchs title, the full directory path, and compact labeled actions', async () => {
        const api = {
            getMachineGitBranches: vi.fn(async () => response())
        } as unknown as ApiClient
        renderDrawer(api)

        expect(await screen.findByText('feature/remote')).toBeInTheDocument()
        const drawer = screen.getByTestId('git-branches-drawer')
        expect(drawer).not.toHaveAttribute('data-keyboard-safe-dialog')
        expect(drawer.querySelector('[data-question-drawer-handle]')).not.toBeNull()
        expect(drawer).toHaveTextContent('Git Branchs')
        expect(drawer).toHaveTextContent(TEST_CWD)
        expect(drawer).toHaveTextContent('3 files')
        expect(drawer).not.toHaveTextContent('origin/feature/remote')
        expect(screen.getByText('Local')).toBeInTheDocument()
        expect(screen.getByText('Remote')).toBeInTheDocument()

        const localSection = document.querySelector<HTMLElement>('[data-git-branch-section="local"]')
        const remoteSection = document.querySelector<HTMLElement>('[data-git-branch-section="remote"]')
        expect(localSection).not.toBeNull()
        expect(remoteSection).not.toBeNull()
        expect(within(localSection!).getByRole('button', { name: 'New branch' })).toBeInTheDocument()
        expect(within(remoteSection!).queryByRole('button', { name: 'New branch' })).not.toBeInTheDocument()
        expect(screen.getByTestId('git-branches-drawer').querySelector('[data-git-branch-change-files]'))
            .toHaveClass('text-[var(--app-badge-warning-text)]')
        expect(screen.getByTestId('git-branches-drawer').querySelector('[data-git-branch-change-additions]'))
            .toHaveClass('text-[var(--app-badge-success-text)]')
        expect(screen.getByTestId('git-branches-drawer').querySelector('[data-git-branch-change-deletions]'))
            .toHaveClass('text-[var(--app-badge-error-text)]')
        expect(screen.getByTestId('git-branches-drawer').querySelector('[data-git-branch-directory-icon]')).not.toBeNull()
        const actions = screen.getByTestId('git-branches-drawer').querySelector<HTMLElement>('[data-git-branch-actions]')
        expect(actions).not.toBeNull()
        expect(actions).toHaveClass('grid-cols-4')
        expect(within(actions!).getAllByRole('button')).toHaveLength(4)
        expect(screen.getByRole('button', { name: 'Fetch' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Pull' })).toHaveAttribute('aria-disabled', 'true')
        expect(screen.getByRole('button', { name: 'Pull' })).toHaveTextContent('Pull')
        expect(screen.getByRole('button', { name: 'Fetch' })).toHaveTextContent('Fetch')
        expect(screen.getByRole('button', { name: 'Commit' })).toHaveTextContent('Commit')
        expect(screen.getByRole('button', { name: 'Push' })).toHaveTextContent('Push')

        fireEvent.click(screen.getByRole('button', { name: 'Pull' }))
        expect(screen.getByTestId('toast-probe')).toHaveTextContent('Commit or stash local changes first')
    })

    it('commits local changes and pushes the current branch from the drawer', async () => {
        const api = {
            getMachineGitBranches: vi.fn(async () => response()),
            commitMachineGitChanges: vi.fn(async () => response({ isDirty: false, changedFileCount: 0, additions: 0, deletions: 0 })),
            pushMachineGitBranch: vi.fn(async () => response())
        } as unknown as ApiClient
        renderDrawer(api)

        await screen.findByText('feature/remote')
        fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
        const commitDrawer = await screen.findByTestId('git-branch-commit-drawer')
        fireEvent.change(within(commitDrawer).getByPlaceholderText('Commit message'), {
            target: { value: 'Save branch work' }
        })
        fireEvent.click(within(commitDrawer).getByRole('button', { name: 'Commit' }))

        await waitFor(() => expect(api.commitMachineGitChanges).toHaveBeenCalledWith('machine-1', {
            cwd: TEST_CWD,
            message: 'Save branch work'
        }))

        fireEvent.click(screen.getByRole('button', { name: 'Push' }))
        expect(await screen.findByText('Push branch?')).toBeInTheDocument()
        const pushButtons = screen.getAllByRole('button', { name: 'Push' })
        fireEvent.click(pushButtons[pushButtons.length - 1]!)

        await waitFor(() => expect(api.pushMachineGitBranch).toHaveBeenCalledWith('machine-1', {
            cwd: TEST_CWD
        }))
    })

    it('fetches remote refs and updates a clean tracked branch', async () => {
        const cleanResponse = response({ isDirty: false, changedFileCount: 0, additions: 0, deletions: 0 })
        const api = {
            getMachineGitBranches: vi.fn(async () => cleanResponse),
            fetchMachineGitBranches: vi.fn(async () => cleanResponse),
            updateMachineGitBranch: vi.fn(async () => cleanResponse)
        } as unknown as ApiClient
        renderDrawer(api)

        await screen.findByText('feature/remote')
        fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
        await waitFor(() => expect(api.fetchMachineGitBranches).toHaveBeenCalledWith('machine-1', {
            cwd: TEST_CWD
        }))

        fireEvent.click(screen.getByRole('button', { name: 'Pull' }))
        await waitFor(() => expect(api.updateMachineGitBranch).toHaveBeenCalledWith('machine-1', {
            cwd: TEST_CWD
        }))
    })

    it('requires confirmation before switching a dirty worktree', async () => {
        const api = {
            getMachineGitBranches: vi.fn(async () => response()),
            switchMachineGitBranch: vi.fn()
                .mockResolvedValueOnce({ ...response(), success: false, code: 'dirty_confirmation_required', error: 'dirty' })
                .mockResolvedValueOnce(response({ currentBranch: 'main', isDirty: false }))
        } as unknown as ApiClient
        renderDrawer(api)

        await screen.findByText('feature/remote')
        fireEvent.click(screen.getAllByText('main')[0]!)
        expect(await screen.findByText('Switch branch?')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Switch anyway' }))

        await waitFor(() => expect(api.switchMachineGitBranch).toHaveBeenLastCalledWith('machine-1', {
            cwd: TEST_CWD,
            target: { kind: 'local', ref: 'main' },
            confirmDirty: true
        }))
    })
})
