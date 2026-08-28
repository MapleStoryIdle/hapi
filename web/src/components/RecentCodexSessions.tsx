import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronDown, Folder, FolderOpen, History, Plus, RefreshCw, Sparkles } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary, SessionSummary } from '@/types/api'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { useNativeCodexRealtime } from '@/lib/native-codex-realtime-context'
import { subscribeNativeCodexSessionUpdated } from '@/lib/native-codex-realtime-events'

/** The sessions index intentionally stays focused on the last three days. */
export const RECENT_CODEX_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const NATIVE_CODEX_LIST_FALLBACK_REFRESH_INTERVAL_MS = 5_000

function toEpochMilliseconds(value: number): number {
    return value < 1_000_000_000_000 ? value * 1000 : value
}

export function isRecentCodexSession(
    modifiedAt: number,
    now = Date.now(),
    windowMs = RECENT_CODEX_WINDOW_MS
): boolean {
    const timestamp = toEpochMilliseconds(modifiedAt)
    return Number.isFinite(timestamp) && timestamp >= now - windowMs
}

function formatTimestamp(value: number): string {
    if (!Number.isFinite(value)) return ''
    return new Date(toEpochMilliseconds(value)).toLocaleString()
}

export type RecentCodexDirectoryGroup = {
    directory: string | null
    sessions: CodexLocalSessionSummary[]
    latestModifiedAt: number
}

export type CodexSessionSource = 'hapi' | 'native'

/** A display-only row shared by managed HAPI and runner-local Codex records. */
export type MergedCodexSession = {
    key: string
    id: string
    title: string
    cwd: string | null
    modifiedAt: number
    source: CodexSessionSource
    active: boolean
    hapiSession?: SessionSummary
    nativeSession?: CodexLocalSessionSummary
}

export type MergedCodexDirectoryGroup = {
    directory: string | null
    sessions: MergedCodexSession[]
    latestModifiedAt: number
}

function getDirectoryDisplayName(directory: string): string {
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    return parts.at(-1) ?? directory
}

function getHapiSessionDirectory(session: SessionSummary): string | null {
    const worktreePath = session.metadata?.worktree?.basePath?.trim()
    if (worktreePath) return worktreePath
    const path = session.metadata?.path?.trim()
    return path || null
}

function getHapiSessionTitle(session: SessionSummary): string {
    const metadata = session.metadata
    if (metadata?.name?.trim()) return metadata.name
    if (metadata?.summary?.text?.trim()) return metadata.summary.text
    const directory = getHapiSessionDirectory(session)
    if (directory) return getDirectoryDisplayName(directory)
    return session.id.slice(0, 8)
}

function isCodexFlavor(session: SessionSummary): boolean {
    return session.metadata?.flavor?.trim().toLowerCase() === 'codex'
}

/** Group local transcripts like the main session list, newest project first. */
export function groupRecentCodexSessionsByDirectory(
    sessions: CodexLocalSessionSummary[]
): RecentCodexDirectoryGroup[] {
    const groups = new Map<string | null, CodexLocalSessionSummary[]>()
    for (const session of sessions) {
        const directory = session.cwd?.trim() || null
        const group = groups.get(directory) ?? []
        group.push(session)
        groups.set(directory, group)
    }

    return Array.from(groups.entries())
        .map(([directory, groupedSessions]) => ({
            directory,
            sessions: [...groupedSessions].sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id)),
            latestModifiedAt: Math.max(...groupedSessions.map((session) => session.modifiedAt))
        }))
        .sort((a, b) => b.latestModifiedAt - a.latestModifiedAt
            || (a.directory ?? '').localeCompare(b.directory ?? ''))
}

function groupMergedCodexSessionsByDirectory(
    sessions: MergedCodexSession[]
): MergedCodexDirectoryGroup[] {
    const groups = new Map<string | null, MergedCodexSession[]>()
    for (const session of sessions) {
        const directory = session.cwd?.trim() || null
        const group = groups.get(directory) ?? []
        group.push(session)
        groups.set(directory, group)
    }

    return Array.from(groups.entries())
        .map(([directory, groupedSessions]) => ({
            directory,
            sessions: [...groupedSessions].sort((a, b) => {
                const activity = toEpochMilliseconds(b.modifiedAt) - toEpochMilliseconds(a.modifiedAt)
                if (activity !== 0) return activity
                if (a.source !== b.source) return a.source === 'hapi' ? -1 : 1
                return a.id.localeCompare(b.id)
            }),
            latestModifiedAt: Math.max(...groupedSessions.map((session) => toEpochMilliseconds(session.modifiedAt)))
        }))
        .sort((a, b) => b.latestModifiedAt - a.latestModifiedAt
            || (a.directory ?? '').localeCompare(b.directory ?? ''))
}

/**
 * Build the single Codex list shown on the sessions index. HAPI rows win over
 * their matching transcript so an app-server thread is not shown twice.
 */
export function mergeRecentCodexSessions(
    hapiSessions: SessionSummary[],
    nativeSessions: CodexLocalSessionSummary[],
    options: { now?: number; windowMs?: number } = {}
): MergedCodexSession[] {
    const now = options.now ?? Date.now()
    const windowMs = options.windowMs ?? RECENT_CODEX_WINDOW_MS
    const managed = hapiSessions
        .filter(isCodexFlavor)
        .filter((session) => isRecentCodexSession(session.updatedAt, now, windowMs))
        .map((session): MergedCodexSession => ({
            key: `hapi:${session.id}`,
            id: session.id,
            title: getHapiSessionTitle(session),
            cwd: getHapiSessionDirectory(session),
            modifiedAt: session.updatedAt,
            source: 'hapi',
            active: session.active,
            hapiSession: session
        }))

    const managedThreadIds = new Set(
        managed
            .map((session) => session.hapiSession?.metadata?.agentSessionId?.trim())
            .filter((id): id is string => Boolean(id))
    )
    const local = nativeSessions
        .filter((session) => isRecentCodexSession(session.modifiedAt, now, windowMs))
        .filter((session) => !managedThreadIds.has(session.id))
        .map((session): MergedCodexSession => ({
            key: `native:${session.id}`,
            id: session.id,
            title: session.title,
            cwd: session.cwd?.trim() || null,
            modifiedAt: session.modifiedAt,
            source: 'native',
            active: session.runState === 'processing',
            nativeSession: session
        }))

    return [...managed, ...local].sort((a, b) => {
        const activity = toEpochMilliseconds(b.modifiedAt) - toEpochMilliseconds(a.modifiedAt)
        if (activity !== 0) return activity
        if (a.source !== b.source) return a.source === 'hapi' ? -1 : 1
        return a.id.localeCompare(b.id)
    })
}

function CodexSourceIcon(props: { source: CodexSessionSource; active?: boolean }) {
    const { t } = useTranslation()
    const isHapi = props.source === 'hapi'
    return (
        <span
            className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center"
            title={isHapi ? t('recentCodex.source.hapi') : t('recentCodex.source.native')}
            aria-hidden="true"
            data-session-source={props.source}
            data-session-active={props.active || undefined}
        >
            {isHapi ? (
                <Sparkles className="h-[18px] w-[18px] text-[var(--app-link)]" strokeWidth={1.8} />
            ) : (
                <AgentFlavorIcon flavor="codex" className="h-5 w-5" />
            )}
            {props.active ? (
                <span
                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-bg)] ${isHapi ? 'bg-[#34C759]' : 'bg-sky-500/80 motion-safe:animate-pulse'}`}
                />
            ) : null}
        </span>
    )
}

const NO_DIRECTORY_KEY = '__no-directory__'

function getDirectoryKey(directory: string | null): string {
    return directory ?? NO_DIRECTORY_KEY
}

function DirectoryGroupHeader(props: {
    directory: string | null
    label: string
    sessionCount: number
    collapsed: boolean
    onToggle: () => void
    onNewSessionInDirectory?: (directory: string) => void
    isNewSessionPending?: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const {
        directory,
        label,
        sessionCount,
        collapsed,
        onToggle,
        onNewSessionInDirectory,
        isNewSessionPending = false,
        t
    } = props
    const FolderIcon = collapsed ? Folder : FolderOpen
    const actionLabel = collapsed
        ? t('recentCodex.directory.expand', { directory: label })
        : t('recentCodex.directory.collapse', { directory: label })
    const canCreateSession = Boolean(directory && onNewSessionInDirectory)

    return (
        <div className="group/project flex min-h-12 w-full min-w-0 items-center gap-1 rounded-2xl px-2.5 py-0.5 transition-colors hover:bg-[var(--app-subtle-bg)]">
            <button
                type="button"
                onClick={onToggle}
                className="flex min-h-11 min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] touch-manipulation"
                title={directory ?? undefined}
                aria-label={actionLabel}
                aria-expanded={!collapsed}
                data-directory-toggle={getDirectoryKey(directory)}
            >
                <FolderIcon className="h-[22px] w-[22px] shrink-0 text-[var(--app-fg)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-base font-semibold leading-5 text-[var(--app-fg)]">
                    {label}
                </span>
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                    {sessionCount}
                </span>
                <ChevronDown
                    className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
                    aria-hidden="true"
                />
            </button>
            {canCreateSession ? (
                <button
                    type="button"
                    onClick={() => onNewSessionInDirectory?.(directory!)}
                    disabled={isNewSessionPending}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] touch-manipulation disabled:cursor-not-allowed disabled:opacity-45"
                    title={t('sessions.group.new')}
                    aria-label={t('sessions.group.new')}
                    aria-busy={isNewSessionPending || undefined}
                >
                    {isNewSessionPending ? (
                        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                        <Plus className="h-5 w-5" aria-hidden="true" />
                    )}
                </button>
            ) : null}
        </div>
    )
}

function MergedCodexSessionRow(props: {
    session: MergedCodexSession
    onOpen: () => void
    selected?: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { session, onOpen, selected = false, t } = props
    const lastActiveLabel = formatRelativeTime(session.modifiedAt, t) ?? formatTimestamp(session.modifiedAt)
    return (
        <li className="min-w-0">
            <button
                type="button"
                onClick={onOpen}
                className={`session-list-item flex min-h-[3.5rem] w-full min-w-0 items-center justify-between gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                aria-label={t('recentCodex.open', { title: session.title })}
                aria-current={selected ? 'page' : undefined}
            >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                    <CodexSourceIcon source={session.source} active={session.active} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 tracking-normal text-[var(--app-fg)]" title={session.title}>
                        {session.title}
                    </span>
                </span>
                <span className="flex shrink-0 items-center">
                    <time
                        className="text-[11px] font-medium tabular-nums text-[var(--app-hint)]"
                        title={formatTimestamp(session.modifiedAt)}
                    >
                        {lastActiveLabel}
                    </time>
                </span>
            </button>
        </li>
    )
}

/**
 * Native Codex transcripts use the same list language as HAPI sessions. In
 * merged mode (`hapiSessions` supplied), this is the complete three-day Codex
 * index; without it, the component keeps its standalone native-history mode.
 */
export function RecentCodexSessions(props: {
    api: ApiClient
    machineId: string | null
    onOpen: (session: CodexLocalSessionSummary) => void
    onOpenHapi?: (session: SessionSummary) => void
    hapiSessions?: SessionSummary[]
    hapiIsLoading?: boolean
    selectedSessionId?: string | null
    /** Render as a non-scrolling section inside the main HAPI session list. */
    embedded?: boolean
    /** Optional heading override used by source panels such as running. */
    title?: string
    /** Optional description override; pass null to keep the heading compact. */
    description?: string | null
    /** Hide the module heading when it is already clear from the page context. */
    hideHeader?: boolean
    /** Limit the list to native turns currently reported as processing. */
    onlyProcessing?: boolean
    /** Number of recent transcripts to request. Defaults to the product list size. */
    limit?: number
    /** Filter the displayed records to the recent window. */
    recentOnly?: boolean
    /** Current runner can publish native transcript changes over app SSE. */
    realtimeAvailable?: boolean
    /** Optional empty-state copy for filtered views such as running. */
    emptyMessage?: string
    /** Create a fresh HAPI session using a known session directory. */
    onNewSessionInDirectory?: (directory: string) => void
    /** Disable directory creation actions while a session is being created. */
    isNewSessionPending?: boolean
}) {
    const { t } = useTranslation()
    const nativeRealtime = useNativeCodexRealtime()
    const hasRealtimeUpdates = props.realtimeAvailable === true && nativeRealtime?.connected === true
    const embedded = props.embedded ?? false
    const title = props.title ?? t('recentCodex.title')
    const description = props.description === undefined ? t('recentCodex.description') : props.description
    const onlyProcessing = props.onlyProcessing ?? false
    const isMerged = props.hapiSessions !== undefined
    const shouldFilterRecent = props.recentOnly ?? isMerged
    const limit = props.limit ?? (isMerged ? 100 : 5)
    const SectionIcon = onlyProcessing ? Activity : History
    const [sessions, setSessions] = useState<CodexLocalSessionSummary[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
    // Keep directory disclosure choices local to this list.  A refresh should
    // update rows without unexpectedly reopening a directory the user closed.
    const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set())
    const autoExpandedSelectionRef = useRef<string | null>(null)
    const realtimeRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hasInitializedRealtimeStateRef = useRef(false)
    const visibleSessions = useMemo(
        () => onlyProcessing ? sessions.filter((session) => session.runState === 'processing') : sessions,
        [onlyProcessing, sessions]
    )
    const recentNativeSessions = useMemo(
        () => shouldFilterRecent
            ? visibleSessions.filter((session) => isRecentCodexSession(session.modifiedAt))
            : visibleSessions,
        [shouldFilterRecent, visibleSessions]
    )
    const directoryGroups = useMemo(
        () => groupRecentCodexSessionsByDirectory(recentNativeSessions),
        [recentNativeSessions]
    )
    const mergedSessions = useMemo(
        () => isMerged
            ? mergeRecentCodexSessions(props.hapiSessions ?? [], recentNativeSessions)
            : [],
        [isMerged, props.hapiSessions, recentNativeSessions]
    )
    const mergedDirectoryGroups = useMemo(
        () => groupMergedCodexSessionsByDirectory(mergedSessions),
        [mergedSessions]
    )

    const directoryGroupsForDisclosure = isMerged ? mergedDirectoryGroups : directoryGroups

    const toggleDirectory = useCallback((directory: string | null) => {
        const key = getDirectoryKey(directory)
        setCollapsedDirectories((current) => {
            const next = new Set(current)
            if (next.has(key)) {
                next.delete(key)
            } else {
                next.add(key)
            }
            return next
        })
    }, [])

    // Do not leave disclosure state for directories that are no longer present,
    // and make sure opening a selected HAPI session never leaves it hidden.
    useEffect(() => {
        const knownKeys = new Set(directoryGroupsForDisclosure.map((group) => getDirectoryKey(group.directory)))
        setCollapsedDirectories((current) => {
            let changed = false
            const next = new Set<string>()
            for (const key of current) {
                if (knownKeys.has(key)) next.add(key)
                else changed = true
            }
            return changed ? next : current
        })

        if (!props.selectedSessionId || !isMerged) {
            autoExpandedSelectionRef.current = null
            return
        }
        const selectedGroup = mergedDirectoryGroups.find((group) => group.sessions.some((session) => (
            session.source === 'hapi' && session.id === props.selectedSessionId
        )))
        if (!selectedGroup) return

        const selectionKey = `${props.selectedSessionId}:${getDirectoryKey(selectedGroup.directory)}`
        if (autoExpandedSelectionRef.current === selectionKey) return
        autoExpandedSelectionRef.current = selectionKey
        const directoryKey = getDirectoryKey(selectedGroup.directory)
        setCollapsedDirectories((current) => {
            if (!current.has(directoryKey)) return current
            const next = new Set(current)
            next.delete(directoryKey)
            return next
        })
    }, [directoryGroupsForDisclosure, isMerged, mergedDirectoryGroups, props.selectedSessionId])

    const refresh = useCallback(async () => {
        setIsLoading(true)
        setLoadError(null)
        const machineId = props.machineId
        if (!machineId) {
            setSessions([])
            setIsLoading(false)
            return
        }
        try {
            const response = isMerged
                ? await props.api.getCodexSessions({ machineId, limit })
                : await props.api.getCodexSessions({
                    machineId,
                    limit,
                    excludeHapiInitiated: true
                })
            setSessions(response.sessions)
            setLastUpdatedAt(Date.now())
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
            setIsLoading(false)
        }
    }, [isMerged, limit, props.api, props.machineId])

    const isDefaultNamespaceUnavailable = loadError !== null && (
        loadError.includes('Codex transcript import is not available outside the default namespace')
        || loadError.includes('default namespace')
        || loadError.includes('默认命名空间')
    )

    useEffect(() => {
        void refresh()
    }, [refresh])

    // Reconcile once as a healthy real-time stream becomes available. This
    // catches transcript writes made during the brief route/SSE startup gap.
    useEffect(() => {
        if (!hasInitializedRealtimeStateRef.current) {
            hasInitializedRealtimeStateRef.current = true
            return
        }
        if (hasRealtimeUpdates) {
            void refresh()
        }
    }, [hasRealtimeUpdates, refresh])

    useEffect(() => {
        const machineId = props.machineId
        if (!machineId) {
            return
        }

        return subscribeNativeCodexSessionUpdated((event) => {
            if (event.machineId !== machineId) {
                return
            }
            if (realtimeRefreshTimerRef.current) {
                clearTimeout(realtimeRefreshTimerRef.current)
            }
            realtimeRefreshTimerRef.current = setTimeout(() => {
                realtimeRefreshTimerRef.current = null
                void refresh()
            }, 100)
        })
    }, [props.machineId, refresh])

    useEffect(() => {
        return () => {
            if (realtimeRefreshTimerRef.current) {
                clearTimeout(realtimeRefreshTimerRef.current)
                realtimeRefreshTimerRef.current = null
            }
        }
    }, [])

    // Current runners update this list through the SSE invalidation above.
    // Older runners, or a temporarily disconnected event stream, retain a
    // small foreground-only poll as a correctness fallback.
    useEffect(() => {
        if (!props.machineId || hasRealtimeUpdates) {
            return
        }

        const refreshIfVisible = () => {
            if (document.visibilityState === 'visible') {
                void refresh()
            }
        }
        const interval = window.setInterval(refreshIfVisible, NATIVE_CODEX_LIST_FALLBACK_REFRESH_INTERVAL_MS)
        window.addEventListener('focus', refreshIfVisible)
        document.addEventListener('visibilitychange', refreshIfVisible)
        return () => {
            window.clearInterval(interval)
            window.removeEventListener('focus', refreshIfVisible)
            document.removeEventListener('visibilitychange', refreshIfVisible)
        }
    }, [hasRealtimeUpdates, props.machineId, refresh])

    const hasRows = isMerged ? mergedSessions.length > 0 : recentNativeSessions.length > 0
    const busy = isLoading || Boolean(props.hapiIsLoading)

    return (
        <section
            className={embedded
                ? 'app-scroll-y flex min-h-0 w-full flex-1 flex-col px-0 pb-3 pt-1 [font-family:var(--app-control-font-family)]'
                : 'flex min-h-0 w-full flex-1 flex-col px-4 pb-4 pt-3 sm:px-6 [font-family:var(--app-control-font-family)]'}
            aria-label={title}
            aria-busy={busy || undefined}
            data-testid="recent-codex-sessions"
        >
            {!props.hideHeader ? (
                <div className={`flex items-center justify-between gap-3 ${embedded ? '' : 'pr-10'}`}>
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--app-hint)]">
                            <SectionIcon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0">
                            <h2 className="truncate text-xs font-semibold uppercase tracking-[0.08em] text-[var(--app-hint)]">{title}</h2>
                            {description ? <p className="mt-0.5 truncate text-[11px] text-[var(--app-hint)]">{description}</p> : null}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        {lastUpdatedAt ? (
                            <span className="sr-only" aria-live="polite">
                                {t('recentCodex.updated', { time: formatRelativeTime(lastUpdatedAt, t) ?? formatTimestamp(lastUpdatedAt) })}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            disabled={isLoading || !props.machineId}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                            aria-label={t('recentCodex.refresh')}
                            title={t('recentCodex.refresh')}
                        >
                            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                        </button>
                    </div>
                </div>
            ) : null}

            {loadError ? (
                <div className={isDefaultNamespaceUnavailable
                    ? 'mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-xs text-[var(--app-hint)]'
                    : 'mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-xs text-red-600'} role="status">
                    <span className="min-w-0 break-words">
                        {isDefaultNamespaceUnavailable ? t('recentCodex.defaultNamespaceOnly') : loadError}
                    </span>
                    {isDefaultNamespaceUnavailable ? null : (
                        <button
                            type="button"
                            onClick={() => void refresh()}
                            className="shrink-0 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
                        >
                            {t('recentCodex.retry')}
                        </button>
                    )}
                </div>
            ) : null}

            {busy && !hasRows ? (
                <div className="mt-3 px-2 text-sm text-[var(--app-hint)]">{t('loading')}</div>
            ) : !props.machineId ? (
                <div className="mt-3 px-2 py-2 text-xs leading-5 text-[var(--app-hint)]">
                    {t('recentCodex.runnerRequired')}
                </div>
            ) : loadError && !hasRows ? null : !hasRows ? (
                <div className="mt-3 px-2 py-2 text-xs leading-5 text-[var(--app-hint)]">
                    {props.emptyMessage ?? t('recentCodex.empty')}
                </div>
            ) : isMerged ? (
                <div className={embedded
                    ? 'mt-1 flex min-h-0 flex-col gap-1'
                    : 'mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto pr-1'}>
                    {mergedDirectoryGroups.map((group) => {
                        const directoryLabel = group.directory
                            ? getDirectoryDisplayName(group.directory)
                            : t('recentCodex.noDirectory')
                        const directoryKey = getDirectoryKey(group.directory)
                        const collapsed = collapsedDirectories.has(directoryKey)
                        return (
                            <section key={directoryKey} className="min-w-0 py-1" data-directory={directoryKey} data-directory-collapsed={collapsed || undefined}>
                                <DirectoryGroupHeader
                                    directory={group.directory}
                                    label={directoryLabel}
                                    sessionCount={group.sessions.length}
                                    collapsed={collapsed}
                                    onToggle={() => toggleDirectory(group.directory)}
                                    onNewSessionInDirectory={props.onNewSessionInDirectory}
                                    isNewSessionPending={props.isNewSessionPending}
                                    t={t}
                                />
                                {!collapsed ? (
                                    <div className="collapsible-panel" data-open>
                                        <div className="collapsible-inner">
                                            <ul className="relative mt-1 ml-5 flex flex-col border-l border-[var(--app-divider)] py-1 pl-3.5">
                                                {group.sessions.map((session) => (
                                                    <MergedCodexSessionRow
                                                        key={session.key}
                                                        session={session}
                                                        selected={session.source === 'hapi' && session.id === props.selectedSessionId}
                                                        t={t}
                                                        onOpen={() => {
                                                            if (session.source === 'hapi') {
                                                                if (session.hapiSession) props.onOpenHapi?.(session.hapiSession)
                                                            } else if (session.nativeSession) {
                                                                props.onOpen(session.nativeSession)
                                                            }
                                                        }}
                                                    />
                                                ))}
                                            </ul>
                                        </div>
                                    </div>
                                ) : null}
                            </section>
                        )
                    })}
                </div>
            ) : (
                <div className={embedded
                    ? 'mt-3 flex min-h-0 flex-col gap-1'
                    : 'mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto pr-1'}>
                    {directoryGroups.map((group) => {
                        const directoryLabel = group.directory
                            ? getDirectoryDisplayName(group.directory)
                            : t('recentCodex.noDirectory')
                        const directoryKey = getDirectoryKey(group.directory)
                        const collapsed = collapsedDirectories.has(directoryKey)
                        return (
                            <section key={directoryKey} className="min-w-0 py-1" data-directory={directoryKey} data-directory-collapsed={collapsed || undefined}>
                                <DirectoryGroupHeader
                                    directory={group.directory}
                                    label={directoryLabel}
                                    sessionCount={group.sessions.length}
                                    collapsed={collapsed}
                                    onToggle={() => toggleDirectory(group.directory)}
                                    onNewSessionInDirectory={props.onNewSessionInDirectory}
                                    isNewSessionPending={props.isNewSessionPending}
                                    t={t}
                                />
                                {!collapsed ? (
                                    <div className="collapsible-panel" data-open>
                                        <div className="collapsible-inner">
                                            <ul className="relative mt-1 ml-5 flex flex-col border-l border-[var(--app-divider)] py-1 pl-3.5">
                                                {group.sessions.map((session) => {
                                                    const lastActiveLabel = formatRelativeTime(session.modifiedAt, t) ?? formatTimestamp(session.modifiedAt)
                                                    return (
                                                        <li key={session.id} className="min-w-0">
                                                            <button
                                                                type="button"
                                                                onClick={() => props.onOpen(session)}
                                                                className="session-list-item flex min-h-[3.5rem] w-full min-w-0 items-center justify-between gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                                                aria-label={t('recentCodex.open', { title: session.title })}
                                                            >
                                                                <span className="flex min-w-0 flex-1 items-center gap-3">
                                                                    <CodexSourceIcon source="native" active={session.runState === 'processing'} />
                                                                    <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 tracking-normal text-[var(--app-fg)]" title={session.title}>
                                                                        {session.title}
                                                                    </span>
                                                                </span>
                                                                <span className="flex shrink-0 items-center">
                                                                    <time
                                                                        className="text-[11px] font-medium tabular-nums text-[var(--app-hint)]"
                                                                        title={formatTimestamp(session.modifiedAt)}
                                                                    >
                                                                        {lastActiveLabel}
                                                                    </time>
                                                                </span>
                                                            </button>
                                                        </li>
                                                    )
                                                })}
                                            </ul>
                                        </div>
                                    </div>
                                ) : null}
                            </section>
                        )
                    })}
                </div>
            )}
        </section>
    )
}
