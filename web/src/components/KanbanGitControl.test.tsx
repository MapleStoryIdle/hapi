import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { useMachineGitBranch } from '@/hooks/queries/useGitBranch'
import { I18nProvider } from '@/lib/i18n-context'
import { KanbanGitControl } from './KanbanGitControl'

vi.mock('./ui/BottomDrawer', () => ({ BottomDrawer: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }))
vi.mock('./GitBranchesDrawer', () => ({ GitBranchesDrawer: ({ open, cwd }: { open: boolean; cwd: string }) => open ? <div data-testid="selected-repository">{cwd}</div> : null }))
afterEach(cleanup)

const base: ReturnType<typeof useMachineGitBranch> = {
    branch: null, isWorktree: false, isDirty: false, isGitRepository: false,
    repositoryState: 'non-git', childRepositories: [], childRepositoriesError: false, childRepositoriesTruncated: false
}
function mount(git: Partial<typeof base> = {}, api = { getMachineGitBranch: vi.fn().mockResolvedValue({ success: true, repositoryState: 'git', stdout: '# branch.head main\n', isDirty: false }) } as unknown as ApiClient) {
    localStorage.setItem('hapi-lang', 'en')
    const onOpenSession = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><I18nProvider><div onClick={onOpenSession}><KanbanGitControl api={api} machineId="runner" cwd="/workspace" git={{ ...base, ...git }}>main</KanbanGitControl></div></I18nProvider></QueryClientProvider>)
    return onOpenSession
}
describe('Kanban Git control', () => {
    it('shows repository names with a Git folder icon and opens the exact selected repository', async () => {
        const onOpen = mount({ childRepositories: [{ name: 'api', cwd: '/workspace/api' }, { name: 'web', cwd: '/workspace/web' }] })
        const control = screen.getByRole('button', { name: '2 repositories' })
        expect(control).toHaveTextContent('api · web')
        expect(control.querySelector('[data-git-repository-icon]')).not.toBeNull()
        expect(control.querySelector('svg[data-git-repository-icon] circle')).not.toBeNull()
        fireEvent.click(control)
        expect(onOpen).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: /^web/ }))
        expect(await screen.findByTestId('selected-repository')).toHaveTextContent('/workspace/web')
    })
    it('shows confirmed non-Git as disabled', () => {
        mount()
        expect(screen.getByRole('button', { name: 'Not a Git project' })).toBeDisabled()
        expect(screen.getByRole('button').querySelector('[data-non-git-text-icon]')).not.toBeNull()
    })
    it('fetches child branches only on open and marks only dirty repositories with a star', async () => {
        const getMachineGitBranch = vi.fn().mockImplementation((_machine: string, cwd: string) => Promise.resolve({
            success: true, repositoryState: 'git', stdout: `# branch.head ${cwd.endsWith('api') ? 'feature/api' : 'main'}\n`, isDirty: cwd.endsWith('api')
        }))
        mount({ childRepositories: [{ name: 'api', cwd: '/workspace/api' }, { name: 'web', cwd: '/workspace/web' }] }, { getMachineGitBranch } as unknown as ApiClient)
        expect(getMachineGitBranch).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: '2 repositories' }))
        expect(await screen.findByText('feature/api')).toBeInTheDocument()
        expect(getMachineGitBranch).toHaveBeenCalledWith('runner', '/workspace/api')
        expect(getMachineGitBranch).toHaveBeenCalledWith('runner', '/workspace/web')
        expect(within(screen.getByRole('button', { name: /^api/ })).getByText('*')).toHaveAttribute('aria-label', 'Uncommitted changes')
        expect(within(screen.getByRole('button', { name: /^web/ })).queryByText('*')).toBeNull()
    })
    it('shows unavailable instead of a false clean branch when probing fails', async () => {
        mount({ childRepositories: [{ name: 'api', cwd: '/workspace/api' }] }, { getMachineGitBranch: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ApiClient)
        fireEvent.click(screen.getByRole('button', { name: '1 repositories' }))
        expect(await screen.findByText('Unable to check')).toBeInTheDocument()
        expect(screen.queryByText('*')).toBeNull()
    })
    it('renders nothing while loading', () => {
        mount({ repositoryState: 'loading' })
        expect(screen.queryByRole('button')).toBeNull()
        expect(screen.queryByText('Checking…')).toBeNull()
        expect(screen.queryByText('Not a Git project')).toBeNull()
    })
    it('shows the single repository name without a count', () => {
        mount({ childRepositories: [{ name: 'frontend', cwd: '/workspace/frontend' }] })
        expect(screen.getByRole('button', { name: '1 repositories' })).toHaveTextContent(/^frontend$/)
    })
    it('shows two names and the remaining count', () => {
        mount({ childRepositories: ['frontend', 'backend', 'docs', 'api'].map(name => ({ name, cwd: `/workspace/${name}` })) })
        const control = screen.getByRole('button', { name: '4 repositories' })
        expect(control).toHaveTextContent('frontend · backend+2')
        expect(control.querySelector('[title]')).toHaveClass('truncate')
    })
    it('does not report non-Git on failure', () => {
        mount({ repositoryState: 'error' })
        expect(screen.queryByText('Not a Git project')).toBeNull()
        expect(screen.getByRole('button')).toBeDisabled()
        expect(screen.getByText('Unable to check')).toBeInTheDocument()
    })
    it('marks incomplete counts and never claims a complete negative scan', () => {
        mount({ childRepositoriesTruncated: true })
        expect(screen.getByText('Unable to check')).toBeInTheDocument()
        expect(screen.queryByText('Not a Git project')).toBeNull()
    })
    it('opens the current repository without opening the session', async () => {
        const onOpen = mount({ repositoryState: 'git', isGitRepository: true, branch: 'main' })
        fireEvent.click(screen.getByRole('button', { name: 'main' }))
        expect(onOpen).not.toHaveBeenCalled()
        expect(await screen.findByTestId('selected-repository')).toHaveTextContent('/workspace')
    })
})
