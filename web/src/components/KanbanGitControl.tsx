import { lazy, Suspense, useState, type ReactNode } from 'react'
import { FolderGit2, ChevronRight, GitBranch, FileText } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import { useMachineGitBranch } from '@/hooks/queries/useGitBranch'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { useTranslation } from '@/lib/use-translation'

const GitBranchesDrawer = lazy(() => import('./GitBranchesDrawer').then(module => ({ default: module.GitBranchesDrawer })))

function ChildRepositoryRow(props: {
    api: ApiClient
    machineId: string | null
    repository: { name: string; cwd: string }
    onOpen: (cwd: string) => void
}) {
    const { t } = useTranslation()
    const { repository } = props
    const git = useMachineGitBranch(props.api, props.machineId, repository.cwd, true, { refetchInterval: false })
    const branch = git.branch === 'detached' ? t('gitBranches.detached') : git.branch ?? 'Git'
    return <button type="button" onClick={() => props.onOpen(repository.cwd)} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
        <FolderGit2 className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
        <span className="min-w-0 flex-1">
            <span className="block truncate text-sm" title={repository.cwd}>{repository.name}</span>
            <span className="mt-1 flex min-h-4 min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                {git.repositoryState === 'git' ? <>
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate" title={branch}>{branch}</span>
                    {git.isDirty ? <span className="shrink-0 text-amber-500" aria-label={t('recentCodex.gitDirty')} title={t('recentCodex.gitDirty')}>*</span> : null}
                </> : git.repositoryState !== 'loading' ? <span>{t(git.repositoryState === 'non-git' ? 'recentCodex.nonGit' : 'recentCodex.gitUnavailable')}</span> : null}
            </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
    </button>
}

export function KanbanGitControl(props: {
    api: ApiClient
    machineId: string | null
    cwd: string | null
    git: ReturnType<typeof useMachineGitBranch>
    children: ReactNode
}) {
    const { t } = useTranslation()
    const [repositoriesOpen, setRepositoriesOpen] = useState(false)
    const [selectedCwd, setSelectedCwd] = useState<string | null>(null)
    const [gitOpen, setGitOpen] = useState(false)
    const { git } = props
    const repositories = git.childRepositories ?? []
    const hasRepositories = git.repositoryState === 'non-git' && repositories.length > 0
    const incomplete = git.childRepositoriesTruncated || git.childRepositoriesError
    const failed = git.repositoryState === 'error' || (git.repositoryState === 'non-git' && incomplete && !hasRepositories)
    const available = Boolean(props.machineId && props.cwd && (git.isGitRepository || hasRepositories))
    const repositoryNames = repositories.slice(0, 2).map(repository => repository.name).join(' · ')
    const remainingRepositories = Math.max(0, repositories.length - 2)
    const openGit = (cwd: string) => { setSelectedCwd(cwd); setGitOpen(true) }
    if (git.repositoryState === 'loading') return null
    const content = git.isGitRepository ? props.children : hasRepositories ? <>
        <FolderGit2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" data-git-repository-icon />
        <span className="min-w-0 truncate" title={repositories.map(repository => repository.name).join(' · ')}>{repositoryNames}</span>
        {remainingRepositories > 0 || incomplete ? <span className="shrink-0 tabular-nums">{remainingRepositories > 0 ? `+${remainingRepositories}` : ''}{incomplete ? '…' : ''}</span> : null}
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </> : <>
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" data-non-git-text-icon />
        <span>{t(failed ? 'recentCodex.gitUnavailable' : 'recentCodex.nonGit')}</span>
    </>
    return <>
        <button type="button" disabled={!available}
            className="pointer-events-auto relative -my-1.5 flex min-h-8 min-w-0 max-w-full items-center gap-2 rounded-md py-1.5 text-left text-xs leading-4 text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] enabled:hover:text-[var(--app-link)]"
            aria-label={hasRepositories ? t('recentCodex.gitRepositoriesCount', { count: repositories.length }) : undefined}
            data-kanban-git-control
            onClick={event => {
                event.stopPropagation()
                if (hasRepositories) setRepositoriesOpen(true)
                else if (available && props.cwd) openGit(props.cwd)
            }}>
            {content}
        </button>
        <BottomDrawer open={repositoriesOpen} onOpenChange={setRepositoriesOpen} title={t('recentCodex.gitRepositories')} density="compact" desktopDialog bodyClassName="space-y-1 p-3">
            {incomplete ? <p className="px-3 text-xs text-[var(--app-hint)]">{t('recentCodex.gitPartial')}</p> : null}
            {repositoriesOpen ? repositories.map(repository => <ChildRepositoryRow key={repository.cwd} api={props.api} machineId={props.machineId} repository={repository} onOpen={openGit} />) : null}
        </BottomDrawer>
        {selectedCwd ? <Suspense fallback={null}><GitBranchesDrawer api={props.api} machineId={props.machineId} cwd={selectedCwd} open={gitOpen} onOpenChange={setGitOpen} /></Suspense> : null}
    </>
}
