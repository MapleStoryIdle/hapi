import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Download, Folder, GitBranch, GitCommitHorizontal, GitPullRequestArrow, LoaderCircle, Plus, Search, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitBranchOption, GitBranchesResponse } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

type BranchTarget = {
    kind: 'local' | 'remote'
    ref: string
    name: string
}

function displayRemoteBranchName(branch: GitBranchOption): string {
    // Old runners can still send a display value containing `origin/`; keep
    // the presentation rule at the edge as well as in the new runner helper.
    return branch.name.replace(/^origin\//, '')
}

function matchesBranch(branch: GitBranchOption, query: string): boolean {
    if (!query) return true
    const needle = query.toLocaleLowerCase()
    const matches = (value: string) => {
        const haystack = value.toLocaleLowerCase()
        if (haystack.includes(needle)) return true

        let cursor = 0
        for (const character of needle) {
            cursor = haystack.indexOf(character, cursor)
            if (cursor < 0) return false
            cursor += 1
        }
        return true
    }
    return matches(branch.name) || matches(branch.ref)
}

function ChangeSummary(props: {
    response: GitBranchesResponse
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { response, t } = props
    const fileCount = response.changedFileCount ?? 0
    const additions = response.additions ?? 0
    const deletions = response.deletions ?? 0
    const fileColor = fileCount > 0 ? 'text-[var(--app-badge-warning-text)]' : 'text-[var(--app-hint)]'
    const additionColor = additions > 0 ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-hint)]'
    const deletionColor = deletions > 0 ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'

    return (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs font-semibold tabular-nums" data-git-branch-change-summary>
            <span className={fileColor} data-git-branch-change-files>{t('gitBranches.files', { count: fileCount })}</span>
            <span className={additionColor} data-git-branch-change-additions>+{additions}</span>
            <span className={deletionColor} data-git-branch-change-deletions>−{deletions}</span>
        </div>
    )
}

function BranchListSection(props: {
    label: string
    branches: GitBranchOption[]
    currentBranch: string | null
    remote?: boolean
    disabled?: boolean
    onCreate?: () => void
    createLabel?: string
    onSelect: (target: BranchTarget) => void
}) {
    if (props.branches.length === 0) return null

    return (
        <section className="mt-5" data-git-branch-section={props.remote ? 'remote' : 'local'}>
            <div className="overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)]">
                <div className="flex min-h-11 items-center justify-between gap-3 px-3" data-git-branch-section-heading>
                    <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--app-hint)]">
                        <span>{props.label}</span>
                        <span className="rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 tabular-nums text-[11px] text-[var(--app-fg)]">
                            {props.branches.length}
                        </span>
                    </span>
                    {props.onCreate ? (
                        <button
                            type="button"
                            onClick={props.onCreate}
                            disabled={props.disabled}
                            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-wait disabled:opacity-50"
                            aria-label={props.createLabel}
                            title={props.createLabel}
                        >
                            <Plus className="h-5 w-5" strokeWidth={2.25} />
                        </button>
                    ) : null}
                </div>
                {props.branches.map((branch, index) => {
                    const displayName = props.remote ? displayRemoteBranchName(branch) : branch.name
                    const isCurrent = !props.remote && branch.name === props.currentBranch
                    return (
                        <button
                            key={`${props.remote ? 'remote' : 'local'}:${branch.ref}`}
                            type="button"
                            className={[
                                'flex min-h-11 w-full items-center gap-3 px-3 text-left transition-colors',
                                'hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]',
                                'border-t border-[var(--app-divider)]',
                                props.disabled ? 'cursor-wait opacity-60' : ''
                            ].filter(Boolean).join(' ')}
                            onClick={() => props.onSelect({
                                kind: props.remote ? 'remote' : 'local',
                                ref: branch.ref,
                                name: displayName
                            })}
                            disabled={props.disabled || isCurrent}
                            aria-current={isCurrent ? 'page' : undefined}
                            title={displayName}
                        >
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                                {isCurrent ? <Check className="h-4 w-4 text-[var(--app-badge-success-text)]" strokeWidth={2.4} /> : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--app-fg)]">{displayName}</span>
                        </button>
                    )
                })}
            </div>
        </section>
    )
}

/**
 * One machine-scoped branch picker shared by SHAPI and original Codex detail
 * views. It intentionally uses the same bottom-sheet primitive as chat
 * drawers, so it does not move the composer or mobile safe-area layout.
 */
export function GitBranchesDrawer(props: {
    api: ApiClient | null
    machineId: string | null
    cwd: string | null
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const queryClient = useQueryClient()
    const [search, setSearch] = useState('')
    const [pendingTarget, setPendingTarget] = useState<BranchTarget | null>(null)
    const [switchingTarget, setSwitchingTarget] = useState<BranchTarget | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [branchName, setBranchName] = useState('')
    const [creating, setCreating] = useState(false)
    const [commitOpen, setCommitOpen] = useState(false)
    const [commitMessage, setCommitMessage] = useState('')
    const [committing, setCommitting] = useState(false)
    const [pushOpen, setPushOpen] = useState(false)
    const [pushing, setPushing] = useState(false)
    const [fetching, setFetching] = useState(false)
    const [updating, setUpdating] = useState(false)
    const machineId = props.machineId
    const cwd = props.cwd?.trim() || null
    const directoryPath = cwd || t('gitBranches.pathFallback')
    const queryKey = queryKeys.machineGitBranches(machineId ?? 'unknown', cwd ?? 'unknown')
    const branchesQuery = useQuery({
        queryKey,
        queryFn: async () => {
            if (!props.api || !machineId || !cwd) {
                throw new Error(t('gitBranches.loadFailed'))
            }
            const response = await props.api.getMachineGitBranches(machineId, cwd)
            if (!response.success) {
                throw new Error(response.error || t('gitBranches.loadFailed'))
            }
            return response
        },
        enabled: props.open && Boolean(props.api && machineId && cwd),
        staleTime: 10_000,
        retry: false,
        refetchOnWindowFocus: false
    })

    useEffect(() => {
        if (props.open) return
        setSearch('')
        setPendingTarget(null)
        setCreateOpen(false)
        setCommitOpen(false)
        setCommitMessage('')
        setPushOpen(false)
    }, [props.open])

    const updateBranches = useCallback((response: GitBranchesResponse) => {
        queryClient.setQueryData(queryKey, response)
        if (machineId && cwd) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.machineGitBranch(machineId, cwd) })
        }
    }, [cwd, machineId, queryClient, queryKey])

    const switchBranch = useCallback(async (target: BranchTarget, confirmDirty: boolean) => {
        if (!props.api || !machineId || !cwd) return

        setSwitchingTarget(target)
        try {
            const response = await props.api.switchMachineGitBranch(machineId, {
                cwd,
                target: { kind: target.kind, ref: target.ref },
                ...(confirmDirty ? { confirmDirty: true } : {})
            })
            if (response.code === 'dirty_confirmation_required' && !confirmDirty) {
                setPendingTarget(target)
                return
            }
            if (!response.success) {
                addToast({
                    title: t('gitBranches.switchFailed'),
                    body: response.error || t('dialog.error.default'),
                    kind: 'error'
                })
                return
            }
            updateBranches(response)
        } catch (error) {
            addToast({
                title: t('gitBranches.switchFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                kind: 'error'
            })
        } finally {
            setSwitchingTarget(null)
        }
    }, [addToast, cwd, machineId, props.api, t, updateBranches])

    const createBranch = useCallback(async () => {
        const name = branchName.trim()
        if (!props.api || !machineId || !cwd || !name || creating) return

        setCreating(true)
        try {
            const response = await props.api.createMachineGitBranch(machineId, { cwd, name })
            if (!response.success) {
                addToast({
                    title: t('gitBranches.createFailed'),
                    body: response.error || t('dialog.error.default'),
                    kind: 'error'
                })
                return
            }
            updateBranches(response)
            setBranchName('')
            setCreateOpen(false)
        } catch (error) {
            addToast({
                title: t('gitBranches.createFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                kind: 'error'
            })
        } finally {
            setCreating(false)
        }
    }, [addToast, branchName, creating, cwd, machineId, props.api, t, updateBranches])

    const commitChanges = useCallback(async () => {
        const message = commitMessage.trim()
        if (!props.api || !machineId || !cwd || !message || committing) return

        setCommitting(true)
        try {
            const response = await props.api.commitMachineGitChanges(machineId, { cwd, message })
            if (!response.success) {
                addToast({
                    title: t('gitBranches.commitFailed'),
                    body: response.error || t('dialog.error.default'),
                    kind: 'error'
                })
                return
            }
            updateBranches(response)
            setCommitMessage('')
            setCommitOpen(false)
            addToast({ title: t('gitBranches.commitSuccess'), kind: 'success' })
        } catch (error) {
            addToast({
                title: t('gitBranches.commitFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                kind: 'error'
            })
        } finally {
            setCommitting(false)
        }
    }, [addToast, commitMessage, committing, cwd, machineId, props.api, t, updateBranches])

    const pushBranch = useCallback(async () => {
        if (!props.api || !machineId || !cwd || pushing) return

        setPushing(true)
        try {
            const response = await props.api.pushMachineGitBranch(machineId, { cwd })
            if (!response.success) {
                addToast({
                    title: t('gitBranches.pushFailed'),
                    body: response.error || t('dialog.error.default'),
                    kind: 'error'
                })
                return
            }
            updateBranches(response)
            setPushOpen(false)
            addToast({ title: t('gitBranches.pushSuccess'), kind: 'success' })
        } catch (error) {
            addToast({
                title: t('gitBranches.pushFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                kind: 'error'
            })
        } finally {
            setPushing(false)
        }
    }, [addToast, cwd, machineId, props.api, pushing, t, updateBranches])

    const fetchBranches = useCallback(async () => {
        if (!props.api || !machineId || !cwd || fetching) return

        setFetching(true)
        try {
            const response = await props.api.fetchMachineGitBranches(machineId, { cwd })
            if (!response.success) {
                addToast({
                    title: t('gitBranches.fetchFailed'),
                    body: response.error || t('dialog.error.default'),
                    kind: 'error'
                })
                return
            }
            updateBranches(response)
            addToast({ title: t('gitBranches.fetchSuccess'), kind: 'success' })
        } catch (error) {
            addToast({
                title: t('gitBranches.fetchFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                kind: 'error'
            })
        } finally {
            setFetching(false)
        }
    }, [addToast, cwd, fetching, machineId, props.api, t, updateBranches])

    const updateBranch = useCallback(async () => {
        if (!props.api || !machineId || !cwd || updating) return

        setUpdating(true)
        try {
            const response = await props.api.updateMachineGitBranch(machineId, { cwd })
            if (!response.success) {
                addToast({
                    title: response.code === 'dirty_update_blocked'
                        ? t('gitBranches.updateDirty')
                        : t('gitBranches.updateFailed'),
                    body: response.error || t('dialog.error.default'),
                    kind: 'error'
                })
                return
            }
            updateBranches(response)
            addToast({ title: t('gitBranches.updateSuccess'), kind: 'success' })
        } catch (error) {
            addToast({
                title: t('gitBranches.updateFailed'),
                body: error instanceof Error ? error.message : t('dialog.error.default'),
                kind: 'error'
            })
        } finally {
            setUpdating(false)
        }
    }, [addToast, cwd, machineId, props.api, t, updateBranches, updating])

    const data = branchesQuery.data
    const localBranches = useMemo(
        () => (data?.localBranches ?? []).filter((branch) => matchesBranch(branch, search.trim())),
        [data?.localBranches, search]
    )
    const remoteBranches = useMemo(
        () => (data?.remoteBranches ?? []).filter((branch) => matchesBranch(branch, search.trim())),
        [data?.remoteBranches, search]
    )
    const busy = switchingTarget !== null || creating || committing || pushing || fetching || updating
    const canPush = Boolean(data?.currentBranch && data.pushRemote)
    const canFetch = Boolean(data?.upstream || data?.pushRemote)
    const canUpdate = data?.canUpdate === true && data.isDirty !== true
    const updateUnavailableTitle = data?.isDirty
        ? t('gitBranches.updateDirty')
        : t('gitBranches.updateUnavailable')

    return (
        <>
            <BottomDrawer
                open={props.open}
                onOpenChange={props.onOpenChange}
                title={t('gitBranches.title')}
                subtitle={(
                    <span className="flex min-w-0 items-start gap-1.5">
                        <Folder className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.9} aria-hidden="true" data-git-branch-directory-icon />
                        <span className="min-w-0 [overflow-wrap:anywhere]" data-git-branch-directory-path>{directoryPath}</span>
                    </span>
                )}
                density="compact"
                busy={busy}
                testId="git-branches-drawer"
                desktopClassName="max-w-2xl"
            >
                {branchesQuery.isPending ? (
                    <div className="flex min-h-32 items-center justify-center" data-git-branches-loading>
                        <LoaderCircle className="h-5 w-5 animate-spin text-[var(--app-hint)]" aria-label={t('gitBranches.loading')} />
                    </div>
                ) : branchesQuery.isError ? (
                    <div className="flex min-h-32 items-center justify-center">
                        <button
                            type="button"
                            onClick={() => void branchesQuery.refetch()}
                            className="flex h-11 items-center gap-2 rounded-full px-3 text-sm font-medium text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            {t('gitBranches.retry')}
                        </button>
                    </div>
                ) : data ? (
                    <div className="pb-2">
                        <div className="rounded-[18px] border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-3">
                            <div className="flex min-w-0 items-center gap-2.5">
                                <GitBranch className="h-5 w-5 shrink-0 text-[var(--app-link)]" strokeWidth={1.9} />
                                <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--app-fg)]" title={data.currentBranch ?? undefined}>
                                    {data.currentBranch ?? t('gitBranches.detached')}
                                </span>
                            </div>
                            <ChangeSummary response={data} t={t} />
                            <div className="mt-3 grid grid-cols-4 gap-2" data-git-branch-actions>
                                <button
                                    type="button"
                                    onClick={() => void updateBranch()}
                                    disabled={busy || !canUpdate}
                                    className="flex h-11 w-full items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                                    aria-label={updating ? t('gitBranches.updating') : t('gitBranches.update')}
                                    title={canUpdate ? t('gitBranches.update') : updateUnavailableTitle}
                                    data-git-branch-update
                                >
                                    {updating
                                        ? <LoaderCircle className="h-5 w-5 animate-spin" strokeWidth={2} aria-hidden="true" />
                                        : <GitPullRequestArrow className="h-5 w-5" strokeWidth={2} aria-hidden="true" />}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void fetchBranches()}
                                    disabled={busy || !canFetch}
                                    className="flex h-11 w-full items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                                    aria-label={fetching ? t('gitBranches.fetching') : t('gitBranches.fetch')}
                                    title={canFetch ? t('gitBranches.fetch') : t('gitBranches.fetchUnavailable')}
                                    data-git-branch-fetch
                                >
                                    {fetching
                                        ? <LoaderCircle className="h-5 w-5 animate-spin" strokeWidth={2} aria-hidden="true" />
                                        : <Download className="h-5 w-5" strokeWidth={2} aria-hidden="true" />}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setCommitOpen(true)}
                                    disabled={busy || !data.isDirty}
                                    className="flex h-11 w-full items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                                    aria-label={t('gitBranches.commit')}
                                    title={t('gitBranches.commit')}
                                >
                                    <GitCommitHorizontal className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPushOpen(true)}
                                    disabled={busy || !canPush}
                                    className="flex h-11 w-full items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                                    aria-label={t('gitBranches.push')}
                                    title={canPush ? t('gitBranches.push') : t('gitBranches.pushUnavailable')}
                                >
                                    <Upload className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                                </button>
                            </div>
                        </div>

                        <label className="mt-4 flex h-11 items-center gap-2 rounded-[14px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-[var(--app-hint)] focus-within:ring-2 focus-within:ring-[var(--app-link)]">
                            <Search className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
                            <span className="sr-only">{t('gitBranches.search')}</span>
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={t('gitBranches.search')}
                                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)]"
                                type="search"
                            />
                        </label>

                        <BranchListSection
                            label={t('gitBranches.local')}
                            branches={localBranches}
                            currentBranch={data.currentBranch ?? null}
                            disabled={busy}
                            onCreate={() => setCreateOpen(true)}
                            createLabel={t('gitBranches.new')}
                            onSelect={(target) => void switchBranch(target, false)}
                        />
                        <BranchListSection
                            label={t('gitBranches.remote')}
                            branches={remoteBranches}
                            currentBranch={data.currentBranch ?? null}
                            remote
                            disabled={busy}
                            onSelect={(target) => void switchBranch(target, false)}
                        />
                    </div>
                ) : null}
            </BottomDrawer>

            <BottomDrawer
                open={createOpen}
                onOpenChange={setCreateOpen}
                inputDialog
                title={t('gitBranches.new')}
                density="compact"
                busy={creating}
                testId="git-branch-create-drawer"
                footer={(
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setCreateOpen(false)}
                            disabled={creating}
                            className="flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-50"
                        >
                            {t('button.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void createBranch()}
                            disabled={creating || !branchName.trim()}
                            className="flex h-10 items-center justify-center rounded-full bg-[var(--app-link)] px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {creating ? t('gitBranches.creating') : t('gitBranches.create')}
                        </button>
                    </div>
                )}
            >
                <label className="block">
                    <span className="sr-only">{t('gitBranches.new')}</span>
                    <input
                        data-drawer-initial-focus
                        value={branchName}
                        onChange={(event) => setBranchName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault()
                                void createBranch()
                            }
                        }}
                        placeholder={t('gitBranches.newPlaceholder')}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        autoFocus
                        className="h-12 w-full rounded-[14px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-[15px] text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:ring-2 focus:ring-[var(--app-link)]"
                    />
                </label>
            </BottomDrawer>

            <BottomDrawer
                open={commitOpen}
                onOpenChange={setCommitOpen}
                inputDialog
                title={t('gitBranches.commit')}
                density="compact"
                busy={committing}
                testId="git-branch-commit-drawer"
                footer={(
                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setCommitOpen(false)}
                            disabled={committing}
                            className="flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-50"
                        >
                            {t('button.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={() => void commitChanges()}
                            disabled={committing || !commitMessage.trim()}
                            className="flex h-10 items-center justify-center rounded-full bg-[var(--app-link)] px-4 text-sm font-semibold text-[var(--app-button-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {committing ? t('gitBranches.committing') : t('gitBranches.commit')}
                        </button>
                    </div>
                )}
            >
                <label className="block">
                    <span className="sr-only">{t('gitBranches.commitMessage')}</span>
                    <textarea
                        data-drawer-initial-focus
                        value={commitMessage}
                        onChange={(event) => setCommitMessage(event.target.value)}
                        onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                                event.preventDefault()
                                void commitChanges()
                            }
                        }}
                        placeholder={t('gitBranches.commitMessage')}
                        autoCapitalize="sentences"
                        autoCorrect="on"
                        spellCheck
                        autoFocus
                        rows={4}
                        className="min-h-28 w-full resize-y rounded-[14px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 text-[15px] text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:ring-2 focus:ring-[var(--app-link)]"
                    />
                </label>
            </BottomDrawer>

            <ConfirmDialog
                isOpen={pendingTarget !== null}
                onClose={() => setPendingTarget(null)}
                title={t('gitBranches.dirty.title')}
                description={t('gitBranches.dirty.description', { name: pendingTarget?.name ?? '' })}
                confirmLabel={t('gitBranches.dirty.confirm')}
                confirmingLabel={t('gitBranches.switching')}
                isPending={busy}
                onConfirm={async () => {
                    if (pendingTarget) await switchBranch(pendingTarget, true)
                }}
            />

            <ConfirmDialog
                isOpen={pushOpen}
                onClose={() => setPushOpen(false)}
                title={t('gitBranches.pushConfirmTitle')}
                description={t('gitBranches.pushConfirmDescription', {
                    branch: data?.currentBranch ?? '',
                    remote: data?.pushRemote ?? ''
                })}
                confirmLabel={t('gitBranches.push')}
                confirmingLabel={t('gitBranches.pushing')}
                isPending={pushing}
                onConfirm={pushBranch}
            />
        </>
    )
}
