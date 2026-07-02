import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { RemoteServer, RemoteServerCandidate, Session } from '@/types/api'
import { useRemoteServerCandidates, useRemoteServers } from '@/hooks/queries/useRemoteServers'
import { queryKeys } from '@/lib/query-keys'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'

export function ServerIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <rect x="4" y="4" width="16" height="6" rx="2" />
            <rect x="4" y="14" width="16" height="6" rx="2" />
            <path d="M8 7h.01" />
            <path d="M8 17h.01" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

function BackIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="m15 18-6-6 6-6" />
        </svg>
    )
}

function SelectedIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
            <path d="m5 12 4 4 10-10" />
        </svg>
    )
}

function formatTarget(server: Pick<RemoteServer, 'user' | 'host' | 'port'>): string {
    return `${server.user}@${server.host}${server.port === 22 ? '' : `:${server.port}`}`
}

function labelValue(value: string): string {
    return value.trim() || '未命名'
}

function LabelPill(props: { children: ReactNode; tone: 'workspace' | 'tag' | 'alias' | 'user' }) {
    const toneClass = {
        workspace: 'bg-[#EAF2FF] text-[#1D4ED8]',
        tag: 'bg-[#F3F4F6] text-[#4B5563]',
        alias: 'bg-[#F5F0FF] text-[#6D28D9]',
        user: 'bg-[#ECFDF5] text-[#047857]',
    }[props.tone]
    return (
        <span className={`inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold leading-4 ${toneClass}`}>
            <span className="truncate">{props.children}</span>
        </span>
    )
}

function WorkspaceLabel(props: { workspace: string }) {
    return <LabelPill tone="workspace">{props.workspace}</LabelPill>
}

function AliasLabel(props: { alias: string }) {
    return <LabelPill tone="alias">{labelValue(props.alias)}</LabelPill>
}

function UserLabel(props: { user: string }) {
    return <LabelPill tone="user">{labelValue(props.user)}</LabelPill>
}

function Tags(props: { tags: readonly string[] }) {
    if (props.tags.length === 0) return null
    return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
            {props.tags.map((tag) => (
                <LabelPill key={tag} tone="tag">{tag}</LabelPill>
            ))}
        </span>
    )
}

function parseTagInput(value: string): string[] {
    const seen = new Set<string>()
    const tags: string[] = []
    for (const raw of value.split(/[,，\n]/)) {
        const tag = raw.trim()
        if (!tag || seen.has(tag)) continue
        seen.add(tag)
        tags.push(tag.slice(0, 50))
        if (tags.length >= 12) break
    }
    return tags
}

function uniqueWorkspaces(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of values) {
        const workspace = value?.trim()
        if (!workspace || seen.has(workspace)) continue
        seen.add(workspace)
        result.push(workspace)
    }
    if (result.length === 0) {
        result.push('默认')
    }
    return result
}

function buildWorkspaceOptions(
    servers: readonly RemoteServer[],
    candidates: readonly RemoteServerCandidate[],
    current?: string
): string[] {
    return uniqueWorkspaces([
        current,
        ...servers.map((server) => server.workspace),
        ...candidates.map((candidate) => candidate.workspace),
        '默认'
    ])
}

function WorkspacePicker(props: {
    value: string
    options: readonly string[]
    onChange: (workspace: string) => void
}) {
    const options = uniqueWorkspaces([props.value, ...props.options])
    return (
        <div className="mt-1 flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5">
            {options.map((workspace) => {
                const selected = workspace === props.value
                return (
                    <button
                        key={workspace}
                        type="button"
                        onClick={() => props.onChange(workspace)}
                        className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                            selected
                                ? 'bg-[var(--app-fg)] text-[var(--app-bg)]'
                                : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        }`}
                    >
                        {workspace}
                    </button>
                )
            })}
        </div>
    )
}

function CandidateAcceptEditor(props: {
    candidate: RemoteServerCandidate
    busy: boolean
    compact?: boolean
    workspaceOptions: readonly string[]
    onConfirm: (payload: { name: string; alias: string; workspace: string; tags: string[] }) => void
    onCancel: () => void
}) {
    const [name, setName] = useState(props.candidate.name)
    const [alias, setAlias] = useState(props.candidate.alias)
    const [workspace, setWorkspace] = useState(props.candidate.workspace)
    const [tags, setTags] = useState(props.candidate.tags.join(', '))
    const parsedTags = useMemo(() => parseTagInput(tags), [tags])
    const canConfirm = name.trim().length > 0 && workspace.trim().length > 0 && !props.busy

    useEffect(() => {
        setName(props.candidate.name)
        setAlias(props.candidate.alias)
        setWorkspace(props.candidate.workspace)
        setTags(props.candidate.tags.join(', '))
    }, [props.candidate])

    return (
        <div className={props.compact ? 'w-full space-y-2' : 'mt-3 space-y-2'}>
            <div className={props.compact ? 'grid grid-cols-1 gap-2 sm:grid-cols-2' : 'grid grid-cols-1 gap-2 sm:grid-cols-2'}>
                <label className="min-w-0 text-xs font-medium text-[var(--app-hint)]">
                    名称
                    <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-normal text-[var(--app-fg)] outline-none focus:border-[var(--app-fg)]"
                        placeholder="服务器名称"
                    />
                </label>
                <label className="min-w-0 text-xs font-medium text-[var(--app-hint)]">
                    别名
                    <input
                        value={alias}
                        onChange={(event) => setAlias(event.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-normal text-[var(--app-fg)] outline-none focus:border-[var(--app-fg)]"
                        placeholder="未命名"
                    />
                </label>
                <label className="min-w-0 text-xs font-medium text-[var(--app-hint)] sm:col-span-2">
                    工作区 <span className="font-normal text-[var(--app-hint)]">(workspace)</span>
                    <WorkspacePicker
                        value={workspace}
                        options={props.workspaceOptions}
                        onChange={setWorkspace}
                    />
                </label>
                <label className="min-w-0 text-xs font-medium text-[var(--app-hint)]">
                    标签
                    <input
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-normal text-[var(--app-fg)] outline-none focus:border-[var(--app-fg)]"
                        placeholder="逗号分隔"
                    />
                </label>
            </div>
            <div className="flex min-h-5 items-center justify-between gap-2">
                <Tags tags={parsedTags} />
                <div className="ml-auto flex shrink-0 justify-end gap-2">
                    <button
                        type="button"
                        disabled={props.busy}
                        onClick={props.onCancel}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-60"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        disabled={!canConfirm}
                        onClick={() => props.onConfirm({
                            name: name.trim(),
                            alias: alias.trim(),
                            workspace: workspace.trim(),
                            tags: parsedTags
                        })}
                        className="rounded-lg bg-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-60"
                    >
                        确认入库
                    </button>
                </div>
            </div>
        </div>
    )
}

function useOutsideClose(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Node && ref.current?.contains(target)) return
            onClose()
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open, ref, onClose])
}

export function RemoteServerCandidatePrompt(props: {
    api: ApiClient
    session: Session
    onChanged: () => void
}) {
    const queryClient = useQueryClient()
    const { candidates } = useRemoteServerCandidates(props.api)
    const { servers } = useRemoteServers(props.api)
    const candidate = useMemo(
        () => candidates.find((item) => item.sessionId === props.session.id && item.status === 'pending') ?? null,
        [candidates, props.session.id]
    )
    const workspaceOptions = useMemo(
        () => buildWorkspaceOptions(servers, candidates, candidate?.workspace),
        [servers, candidates, candidate?.workspace]
    )
    const [pending, setPending] = useState<'accept' | 'dismiss' | null>(null)
    const [editing, setEditing] = useState(false)

    useEffect(() => {
        setEditing(false)
    }, [candidate?.id])

    const refresh = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.remoteServers }),
            queryClient.invalidateQueries({ queryKey: queryKeys.remoteServerCandidates }),
            queryClient.invalidateQueries({ queryKey: queryKeys.session(props.session.id) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
        ])
        props.onChanged()
    }, [props, queryClient])

    const accept = useCallback(async (payload: { name: string; alias: string; workspace: string; tags: string[] }) => {
        if (!candidate) return
        setPending('accept')
        try {
            const result = await props.api.acceptRemoteServerCandidate(candidate.id, payload)
            await props.api.setSessionRemoteServer(props.session.id, result.server.id)
            await refresh()
        } finally {
            setPending(null)
        }
    }, [candidate, props.api, props.session.id, refresh])

    const dismiss = useCallback(async () => {
        if (!candidate) return
        setPending('dismiss')
        try {
            await props.api.dismissRemoteServerCandidate(candidate.id)
            await refresh()
        } finally {
            setPending(null)
        }
    }, [candidate, props.api, refresh])

    if (!candidate) return null

    return (
        <div className="mx-auto mb-2 w-full max-w-content rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
            <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--app-subtle-bg)] text-[var(--app-fg)]">
                    <ServerIcon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-[var(--app-fg)]">
                        发现远程服务器
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                        <WorkspaceLabel workspace={candidate.workspace} />
                        <span className="min-w-0 truncate">{candidate.name}</span>
                        <AliasLabel alias={candidate.alias} />
                        <UserLabel user={candidate.user} />
                    </div>
                </div>
                {!editing ? (
                    <>
                        <button
                            type="button"
                            disabled={pending !== null}
                            onClick={dismiss}
                            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-60"
                        >
                            忽略
                        </button>
                        <button
                            type="button"
                            disabled={pending !== null}
                            onClick={() => setEditing(true)}
                            className="rounded-lg bg-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-60"
                        >
                            添加
                        </button>
                    </>
                ) : null}
            </div>
            {editing ? (
                <CandidateAcceptEditor
                    candidate={candidate}
                    busy={pending !== null}
                    compact
                    workspaceOptions={workspaceOptions}
                    onCancel={() => setEditing(false)}
                    onConfirm={(payload) => { void accept(payload) }}
                />
            ) : null}
        </div>
    )
}

export function RemoteServerContextBar(props: {
    api: ApiClient
    session: Session
    onChanged: () => void
}) {
    const { selectableServers, selected } = useRemoteServerContextSelection(props.api, props.session)
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    useOutsideClose(open, rootRef, () => setOpen(false))

    if (selectableServers.length === 0 && !selected) {
        return null
    }

    return (
        <div ref={rootRef} className="relative mx-auto mb-2 w-full max-w-content">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className="flex h-9 w-full items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-left text-sm shadow-[0_8px_24px_rgba(0,0,0,0.06)] transition-colors hover:bg-[var(--app-subtle-bg)]"
            >
                <ServerIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[var(--app-fg)]">
                    {selected ? (
                        <>
                            <span className="min-w-0 truncate">{selected.name}</span>
                            <WorkspaceLabel workspace={selected.workspace} />
                            <AliasLabel alias={selected.alias} />
                            <UserLabel user={selected.user} />
                        </>
                    ) : (
                        <span className="truncate">选择远程服务器上下文</span>
                    )}
                </span>
                <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
            </button>
            {open ? (
                <div className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-full overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-2xl">
                    <RemoteServerContextMenuContent
                        api={props.api}
                        session={props.session}
                        onChanged={props.onChanged}
                        onClose={() => setOpen(false)}
                    />
                </div>
            ) : null}
        </div>
    )
}

export function useRemoteServerContextSelection(api: ApiClient | null, session: Session | null) {
    const { servers, isLoading } = useRemoteServers(api, Boolean(api && session))
    const sessionMachineId = session?.metadata?.machineId ?? ''
    const selectableServers = useMemo(
        () => servers.filter((server) => (server.machineIds ?? []).includes(sessionMachineId)),
        [servers, sessionMachineId]
    )
    const selected = useMemo(
        () => servers.find((server) => server.id === session?.remoteServerId) ?? null,
        [servers, session?.remoteServerId]
    )

    return { servers, selectableServers, selected, isLoading }
}

export function RemoteServerContextMenuContent(props: {
    api: ApiClient
    session: Session
    onChanged: () => void
    onClose: () => void
}) {
    const queryClient = useQueryClient()
    const { selectableServers, selected, isLoading } = useRemoteServerContextSelection(props.api, props.session)
    const [pendingId, setPendingId] = useState<string | null>(null)

    const selectServer = useCallback(async (serverId: string | null) => {
        setPendingId(serverId ?? 'none')
        try {
            await props.api.setSessionRemoteServer(props.session.id, serverId)
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.session(props.session.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            ])
            props.onChanged()
            props.onClose()
        } finally {
            setPendingId(null)
        }
    }, [props, queryClient])

    if (isLoading) {
        return <div className="px-3 py-2 text-sm text-[var(--app-hint)]">加载中…</div>
    }

    if (selectableServers.length === 0 && !selected) {
        return (
            <div className="px-3 py-2 text-sm leading-5 text-[var(--app-hint)]">
                当前机器还没有可选的远程服务器。
            </div>
        )
    }

    return (
        <div className="py-1">
            <button
                type="button"
                disabled={pendingId !== null}
                onClick={() => { void selectServer(null) }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--app-subtle-bg)] disabled:opacity-60"
            >
                <span className="flex-1 text-[var(--app-fg)]">不使用远程服务器</span>
                {!selected ? <SelectedIcon className="h-4 w-4 shrink-0 text-emerald-500" /> : null}
            </button>
            {selectableServers.map((server) => (
                <button
                    key={server.id}
                    type="button"
                    disabled={pendingId !== null}
                    onClick={() => { void selectServer(server.id) }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] disabled:opacity-60"
                >
                    <ServerIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                    <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1">
                            <span className="truncate text-sm font-semibold text-[var(--app-fg)]">{server.name}</span>
                            <Tags tags={server.tags} />
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                            <WorkspaceLabel workspace={server.workspace} />
                            <AliasLabel alias={server.alias} />
                            <UserLabel user={server.user} />
                        </span>
                    </span>
                    {selected?.id === server.id ? <SelectedIcon className="h-4 w-4 shrink-0 text-emerald-500" /> : null}
                </button>
            ))}
        </div>
    )
}

function CandidateList(props: { api: ApiClient }) {
    const queryClient = useQueryClient()
    const { candidates } = useRemoteServerCandidates(props.api)
    const { servers } = useRemoteServers(props.api)
    const pendingCandidates = candidates.filter((candidate) => candidate.status === 'pending')
    const workspaceOptions = useMemo(
        () => buildWorkspaceOptions(servers, candidates),
        [servers, candidates]
    )
    const [busyId, setBusyId] = useState<string | null>(null)
    const [editingId, setEditingId] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.remoteServers }),
            queryClient.invalidateQueries({ queryKey: queryKeys.remoteServerCandidates }),
        ])
    }, [queryClient])

    if (pendingCandidates.length === 0) return null

    return (
        <div className="space-y-2">
            <div className="text-sm font-semibold text-[var(--app-fg)]">待确认</div>
            {pendingCandidates.map((candidate) => (
                <div key={candidate.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
                    <div className="flex items-start gap-3">
                        <ServerIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--app-hint)]" />
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-1">
                                <span className="truncate text-sm font-semibold text-[var(--app-fg)]">{candidate.name}</span>
                                <Tags tags={candidate.tags} />
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                                <WorkspaceLabel workspace={candidate.workspace} />
                                <AliasLabel alias={candidate.alias} />
                                <UserLabel user={candidate.user} />
                                <span className="truncate">{candidate.sourceProject}</span>
                            </div>
                        </div>
                    </div>
                    {editingId === candidate.id ? (
                        <CandidateAcceptEditor
                            candidate={candidate}
                            busy={busyId !== null}
                            workspaceOptions={workspaceOptions}
                            onCancel={() => setEditingId(null)}
                            onConfirm={async (payload) => {
                                setBusyId(candidate.id)
                                try {
                                    await props.api.acceptRemoteServerCandidate(candidate.id, payload)
                                    setEditingId(null)
                                    await refresh()
                                } finally {
                                    setBusyId(null)
                                }
                            }}
                        />
                    ) : (
                        <div className="mt-3 flex justify-end gap-2">
                            <button
                                type="button"
                                disabled={busyId !== null}
                                onClick={async () => {
                                    setBusyId(candidate.id)
                                    try {
                                        await props.api.dismissRemoteServerCandidate(candidate.id)
                                        await refresh()
                                    } finally {
                                        setBusyId(null)
                                    }
                                }}
                                className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-60"
                            >
                                忽略
                            </button>
                            <button
                                type="button"
                                disabled={busyId !== null}
                                onClick={() => setEditingId(candidate.id)}
                                className="rounded-lg bg-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-60"
                            >
                                添加
                            </button>
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}

function ServerCard(props: {
    api: ApiClient
    server: RemoteServer
    workspaceOptions: readonly string[]
    onChanged: () => void
}) {
    const [editing, setEditing] = useState(false)
    const [name, setName] = useState(props.server.name)
    const [alias, setAlias] = useState(props.server.alias)
    const [workspace, setWorkspace] = useState(props.server.workspace)
    const [tags, setTags] = useState(props.server.tags.join(', '))
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        setName(props.server.name)
        setAlias(props.server.alias)
        setWorkspace(props.server.workspace)
        setTags(props.server.tags.join(', '))
    }, [props.server])

    const save = useCallback(async () => {
        setBusy(true)
        try {
            await props.api.updateRemoteServer(props.server.id, {
                name,
                alias,
                workspace,
                tags: parseTagInput(tags)
            })
            setEditing(false)
            props.onChanged()
        } finally {
            setBusy(false)
        }
    }, [alias, name, props, tags, workspace])

    const remove = useCallback(async () => {
        if (!window.confirm(`删除远程服务器 ${props.server.name}？`)) return
        setBusy(true)
        try {
            await props.api.deleteRemoteServer(props.server.id)
            props.onChanged()
        } finally {
            setBusy(false)
        }
    }, [props])

    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            {editing ? (
                <div className="space-y-2">
                    <label className="block text-xs font-medium text-[var(--app-hint)]">
                        名称
                        <input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-normal text-[var(--app-fg)] outline-none focus:border-[var(--app-fg)]"
                            placeholder="服务器名称"
                        />
                    </label>
                    <label className="block text-xs font-medium text-[var(--app-hint)]">
                        别名
                        <input
                            value={alias}
                            onChange={(event) => setAlias(event.target.value)}
                            className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-normal text-[var(--app-fg)] outline-none focus:border-[var(--app-fg)]"
                            placeholder="未命名"
                        />
                    </label>
                    <label className="block text-xs font-medium text-[var(--app-hint)]">
                        工作区 <span className="font-normal text-[var(--app-hint)]">(workspace)</span>
                        <WorkspacePicker
                            value={workspace}
                            options={props.workspaceOptions}
                            onChange={setWorkspace}
                        />
                    </label>
                    <label className="block text-xs font-medium text-[var(--app-hint)]">
                        标签
                        <input
                            value={tags}
                            onChange={(event) => setTags(event.target.value)}
                            className="mt-1 h-9 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-normal text-[var(--app-fg)] outline-none focus:border-[var(--app-fg)]"
                            placeholder="标签，逗号分隔"
                        />
                    </label>
                    <div className="flex justify-end gap-2">
                        <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded-lg px-3 py-1.5 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">取消</button>
                        <button type="button" disabled={busy} onClick={() => { void save() }} className="rounded-lg bg-[var(--app-fg)] px-3 py-1.5 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-60">保存</button>
                    </div>
                </div>
            ) : (
                <>
                    <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--app-subtle-bg)] text-[var(--app-fg)]">
                            <ServerIcon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-1">
                                <span className="truncate text-sm font-semibold text-[var(--app-fg)]">{props.server.name}</span>
                                <Tags tags={props.server.tags} />
                            </div>
                            <div className="mt-1 truncate text-xs text-[var(--app-hint)]">{formatTarget(props.server)}</div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                                <WorkspaceLabel workspace={props.server.workspace} />
                                <AliasLabel alias={props.server.alias} />
                                <UserLabel user={props.server.user} />
                                <span className="truncate">{props.server.sourceProject}</span>
                            </div>
                        </div>
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                        <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">编辑</button>
                        <button type="button" disabled={busy} onClick={() => { void remove() }} className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-60">删除</button>
                    </div>
                </>
            )}
        </div>
    )
}

export default function RemoteServersPage() {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const { servers, isLoading, error } = useRemoteServers(api)
    const grouped = useMemo(() => {
        const map = new Map<string, RemoteServer[]>()
        for (const server of servers) {
            const list = map.get(server.workspace) ?? []
            list.push(server)
            map.set(server.workspace, list)
        }
        return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
    }, [servers])
    const workspaceOptions = useMemo(
        () => buildWorkspaceOptions(servers, []),
        [servers]
    )

    const refresh = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.remoteServers })
        void queryClient.invalidateQueries({ queryKey: queryKeys.remoteServerCandidates })
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }, [queryClient])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
                <button
                    type="button"
                    onClick={goBack}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    <BackIcon className="h-5 w-5" />
                </button>
                <div className="flex-1 text-base font-semibold text-[var(--app-fg)]">远程服务器</div>
            </div>
            <div className="app-scroll-y flex-1 space-y-5 p-3">
                {api ? <CandidateList api={api} /> : null}
                {error ? <div className="text-sm text-red-600">{error instanceof Error ? error.message : String(error)}</div> : null}
                {isLoading ? <div className="text-sm text-[var(--app-hint)]">加载中…</div> : null}
                {!isLoading && grouped.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[var(--app-border)] p-5 text-center text-sm text-[var(--app-hint)]">
                        还没有远程服务器。Agent 成功连接 SSH 后会在这里出现待确认项。
                    </div>
                ) : null}
                {grouped.map(([workspace, workspaceServers]) => (
                    <div key={workspace} className="space-y-2">
                        <div className="px-1">
                            <WorkspaceLabel workspace={workspace} />
                        </div>
                        {workspaceServers.map((server) => (
                            <ServerCard
                                key={server.id}
                                api={api}
                                server={server}
                                workspaceOptions={workspaceOptions}
                                onChanged={refresh}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    )
}
