import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    CircleAlert,
    CircleCheck,
    Folder as FolderIconNode,
    FolderOpen as FolderOpenIconNode,
    GitBranch as GitBranchIconNode,
    LoaderCircle,
    Plus as PlusIconNode,
    RefreshCw as RefreshIconNode,
    TreePine as TreePineIconNode
} from 'lucide'
import { Activity, Archive as ArchiveIconNode, ChevronDown, History, Pin } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary, SessionSummary } from '@/types/api'
import { formatRelativeTime } from '@/lib/relativeTime'
import { getDetachedBranchLabel } from '@/lib/files-i18n'
import { useMachineGitBranch } from '@/hooks/queries/useGitBranch'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { MotionIcon, toMotionIcon } from '@/components/MotionIcon'
import { useNativeCodexRealtime } from '@/lib/native-codex-realtime-context'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useLocalDayKey } from '@/hooks/useLocalDayKey'
import { formatShareTimelineTime, groupShareTimeline, localDateKey } from '@/lib/shareTimeline'
import { queryKeys } from '@/lib/query-keys'
import { scheduleBackgroundWork } from '@/lib/interaction-priority'
import {
    getNativeCodexSessionListUpdate,
    subscribeNativeCodexSessionUpdated,
    type NativeCodexSessionListUpdate
} from '@/lib/native-codex-realtime-events'

/** The sessions index intentionally stays focused on the last three days. */
export const RECENT_CODEX_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
const NATIVE_CODEX_LIST_FALLBACK_REFRESH_INTERVAL_MS = 5_000
const NATIVE_CODEX_LIST_UPDATE_BATCH_MS = 100
const HAPI_CODEX_ORIGINATOR = 'hapi-codex-client'

function isHapiInitiatedCodexSessionUpdate(update: NativeCodexSessionListUpdate): boolean {
    return update.originator?.trim().toLowerCase() === HAPI_CODEX_ORIGINATOR
}

/** Apply a runner-sent row update without waiting for a full list RPC. */
export function applyNativeCodexSessionListUpdate(
    sessions: CodexLocalSessionSummary[],
    update: NativeCodexSessionListUpdate,
    limit: number,
    options: { excludeHapiInitiated?: boolean } = {}
): CodexLocalSessionSummary[] {
    const withoutUpdated = sessions.filter((session) => session.id !== update.id)
    if (options.excludeHapiInitiated && isHapiInitiatedCodexSessionUpdate(update)) {
        return withoutUpdated
    }

    const previous = sessions.find((session) => session.id === update.id)
    const next: CodexLocalSessionSummary = {
        ...previous,
        ...update,
        // Transcript paths are intentionally omitted from realtime events. The
        // list does not need one to open the native thread by id.
        file: previous?.file ?? ''
    }
    return [...withoutUpdated, next]
        .sort((left, right) => right.modifiedAt - left.modifiedAt || left.id.localeCompare(right.id))
        .slice(0, limit)
}

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

export function formatKanbanSessionTime(
    value: number,
    now: number,
    locale: string,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    const timestamp = toEpochMilliseconds(value)
    if (localDateKey(new Date(timestamp)) === localDateKey(new Date(now))) {
        return formatRelativeTime(timestamp, t, now) ?? formatShareTimelineTime(timestamp, locale)
    }
    return formatShareTimelineTime(timestamp, locale)
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

export type MergedCodexKanbanStatus = 'pending' | 'processing' | 'completed'

export type MergedCodexKanbanGroupId = 'pinned' | MergedCodexKanbanStatus

export type MergedCodexKanbanGroup = {
    id: MergedCodexKanbanGroupId
    sessions: MergedCodexSession[]
}

const EMPTY_PINNED_SESSION_KEYS: ReadonlySet<string> = new Set()

/**
 * Completed cards use directory color as a quiet project identity. Keep these
 * away from the amber/green status colors used by pending and processing.
 */
export const COMPLETED_SESSION_DIRECTORY_COLORS = [
    '#4E7CF5',
    '#7367E8',
    '#9862C7',
    '#C35E92',
    '#337FA8',
    '#258C91',
    '#647AA3',
    '#8A6F9E',
    '#496FAF',
    '#A06478'
] as const

function normalizeDirectoryColorKey(directory: string | null): string | null {
    return directory?.trim().replace(/\/+$/, '') || null
}

function getCompletedSessionDirectoryColorIndex(normalizedDirectory: string): number {
    let hash = 2_166_136_261
    for (let index = 0; index < normalizedDirectory.length; index += 1) {
        hash ^= normalizedDirectory.charCodeAt(index)
        hash = Math.imul(hash, 16_777_619)
    }
    return (hash >>> 0) % COMPLETED_SESSION_DIRECTORY_COLORS.length
}

export function getCompletedSessionDirectoryColor(directory: string | null): string | null {
    const normalized = normalizeDirectoryColorKey(directory)
    if (!normalized) return null
    return COMPLETED_SESSION_DIRECTORY_COLORS[getCompletedSessionDirectoryColorIndex(normalized)]
}

/** Avoid color collisions among the first palette-sized set of visible directories. */
export function assignCompletedSessionDirectoryColors(
    directories: readonly (string | null)[]
): ReadonlyMap<string, string> {
    const normalizedDirectories = [...new Set(
        directories
            .map(normalizeDirectoryColorKey)
            .filter((directory): directory is string => directory !== null)
    )].sort()
    const assignments = new Map<string, string>()
    const usedColors = new Set<string>()

    for (const directory of normalizedDirectories) {
        const preferredIndex = getCompletedSessionDirectoryColorIndex(directory)
        const preferredColor = COMPLETED_SESSION_DIRECTORY_COLORS[preferredIndex]
        let color = preferredColor
        if (usedColors.size < COMPLETED_SESSION_DIRECTORY_COLORS.length) {
            for (let offset = 0; offset < COMPLETED_SESSION_DIRECTORY_COLORS.length; offset += 1) {
                const candidate = COMPLETED_SESSION_DIRECTORY_COLORS[
                    (preferredIndex + offset) % COMPLETED_SESSION_DIRECTORY_COLORS.length
                ]
                if (!usedColors.has(candidate)) {
                    color = candidate
                    break
                }
            }
        }
        assignments.set(directory, color)
        usedColors.add(color)
    }
    return assignments
}

function getAssignedCompletedSessionDirectoryColor(
    assignments: ReadonlyMap<string, string>,
    directory: string | null
): string | null {
    const key = normalizeDirectoryColorKey(directory)
    return key ? assignments.get(key) ?? null : null
}

const KANBAN_GROUP_PRESENTATION: Record<MergedCodexKanbanGroupId, {
    labelKey: string
    dotClassName: string
    borderClassName: string
}> = {
    pinned: {
        labelKey: 'sessions.kanban.pinned',
        dotClassName: 'text-[var(--app-hint)]',
        borderClassName: 'border-l-[var(--app-divider)]'
    },
    pending: {
        labelKey: 'sessions.kanban.pending',
        dotClassName: 'bg-[#F59E0B]',
        borderClassName: 'border-l-[#F59E0B]'
    },
    processing: {
        labelKey: 'sessions.kanban.processing',
        dotClassName: 'bg-[#34C759]',
        borderClassName: 'border-l-[#34C759]'
    },
    completed: {
        labelKey: 'sessions.kanban.completed',
        dotClassName: 'bg-[var(--app-hint)]',
        borderClassName: 'border-l-[var(--app-divider)]'
    }
}

export function getMergedCodexKanbanStatus(session: MergedCodexSession): MergedCodexKanbanStatus {
    const hapi = session.hapiSession
    if ((hapi?.pendingRequestsCount ?? 0) > 0) {
        return 'pending'
    }
    if (hapi) {
        return hapi.active && (hapi.thinking || hapi.backgroundTaskCount > 0)
            ? 'processing'
            : 'completed'
    }
    if (session.nativeSession?.waitingForUserInput === true) {
        return 'pending'
    }
    return session.nativeSession?.runState === 'processing' ? 'processing' : 'completed'
}

export function groupMergedCodexCompletedTimeline(
    sessions: MergedCodexSession[],
    now: Date,
    locale: string,
    labels: {
        today: string
        yesterday: string
        daysAgo: (days: number) => string
    }
) {
    return groupShareTimeline(
        sessions.map((session) => ({ ...session, createdAt: toEpochMilliseconds(session.modifiedAt) })),
        now,
        locale,
        labels
    ).map((group) => ({
        ...group,
        shares: [...group.shares].sort(compareKanbanSessions)
    }))
}

function compareKanbanSessions(
    left: MergedCodexSession,
    right: MergedCodexSession
): number {
    const activity = toEpochMilliseconds(right.modifiedAt) - toEpochMilliseconds(left.modifiedAt)
    if (activity !== 0) return activity
    return left.key.localeCompare(right.key)
}

function compareThinkingKanbanSessions(
    left: MergedCodexSession,
    right: MergedCodexSession
): number {
    const leftDirectory = getKanbanDirectoryLabel(left.cwd)
    const rightDirectory = getKanbanDirectoryLabel(right.cwd)
    if (leftDirectory && !rightDirectory) return -1
    if (!leftDirectory && rightDirectory) return 1

    const directory = (leftDirectory ?? '').localeCompare(rightDirectory ?? '')
    if (directory !== 0) return directory
    const fullPath = (left.cwd ?? '').localeCompare(right.cwd ?? '')
    if (fullPath !== 0) return fullPath
    return left.key.localeCompare(right.key)
}

export function groupMergedCodexSessionsForKanban(
    sessions: MergedCodexSession[],
    pinnedSessionKeys: ReadonlySet<string> = EMPTY_PINNED_SESSION_KEYS
): MergedCodexKanbanGroup[] {
    const groups: MergedCodexKanbanGroup[] = [
        { id: 'pending', sessions: [] },
        { id: 'processing', sessions: [] },
        { id: 'pinned', sessions: [] },
        { id: 'completed', sessions: [] }
    ]
    const groupsById = new Map(groups.map((group) => [group.id, group]))

    for (const session of sessions) {
        const status = getMergedCodexKanbanStatus(session)
        // User action and active thinking take precedence over a local pin.
        // Pins collect only otherwise-completed sessions.
        const groupId = status === 'completed' && pinnedSessionKeys.has(session.key)
            ? 'pinned'
            : status
        groupsById.get(groupId)!.sessions.push(session)
    }

    for (const group of groups) {
        group.sessions.sort(group.id === 'processing' ? compareThinkingKanbanSessions : compareKanbanSessions)
    }

    return groups
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
    const codexHapiSessions = hapiSessions.filter(isCodexFlavor)
    const archivedManagedThreadIds = new Set(
        codexHapiSessions
            .filter((session) => session.metadata?.lifecycleState === 'archived')
            .flatMap((session) => [session.id, session.metadata?.agentSessionId?.trim()])
            .filter((id): id is string => Boolean(id))
    )
    const managed = codexHapiSessions
        .filter((session) => session.metadata?.lifecycleState !== 'archived')
        .filter((session) => isRecentCodexSession(session.updatedAt, now, windowMs))
        .map((session): MergedCodexSession => ({
            key: `hapi:${session.id}`,
            id: session.id,
            title: getHapiSessionTitle(session),
            cwd: getHapiSessionDirectory(session),
            modifiedAt: session.updatedAt,
            source: 'hapi',
            active: session.pendingRequestsCount === 0
                && session.active
                && (session.thinking || session.backgroundTaskCount > 0),
            hapiSession: session
        }))

    const managedThreadIds = new Set(
        [
            ...archivedManagedThreadIds,
            ...managed
                .map((session) => session.hapiSession?.metadata?.agentSessionId?.trim())
                .filter((id): id is string => Boolean(id))
        ]
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
            // Native local-input waits remain `processing` for safe queueing,
            // but visually belong in the pending/attention lane.
            active: session.runState === 'processing' && session.waitingForUserInput !== true,
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
            data-session-agent="codex"
            data-session-active={props.active || undefined}
        >
            <AgentFlavorIcon
                flavor="codex"
                className={`h-5 w-5 ${isHapi ? 'text-[#4EA1FF]' : 'text-[var(--app-fg)]'}`}
            />
            {props.active ? (
                <span
                    data-session-running-indicator
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-bg)] bg-[#34C759] motion-safe:animate-pulse"
                />
            ) : null}
        </span>
    )
}

function getKanbanDirectoryLabel(directory: string | null): string | null {
    if (!directory) return null
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    return parts.slice(-2).join('/') || directory
}

function KanbanSessionCard(props: {
    api: ApiClient
    machineId: string | null
    session: MergedCodexSession
    selected?: boolean
    pinned: boolean
    onOpen: () => void
    onTogglePin?: () => void
    onArchived: (session: MergedCodexSession) => void
    dateLocale: string
    now: number
    directoryColor: string | null
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { api, machineId, session, selected = false, pinned, onOpen, onTogglePin, onArchived, dateLocale, now, directoryColor, t } = props
    const queryClient = useQueryClient()
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [isArchiving, setIsArchiving] = useState(false)
    const status = getMergedCodexKanbanStatus(session)
    const presentation = KANBAN_GROUP_PRESENTATION[status]
    const completedDirectoryColor = status === 'completed' ? directoryColor : null
    const modifiedAt = toEpochMilliseconds(session.modifiedAt)
    const directoryLabel = getKanbanDirectoryLabel(session.cwd) ?? t('recentCodex.noDirectory')
    const { branch, isWorktree, isDirty } = useMachineGitBranch(api, machineId, session.cwd)
    const branchLabel = branch ? getDetachedBranchLabel(branch, t) : null
    const branchIcon = isWorktree ? TreePineIconNode : GitBranchIconNode
    const archiveDescription = session.source === 'native'
        ? t('recentCodex.archive.nativeDescription', { name: session.title })
        : t('recentCodex.archive.hapiDescription', { name: session.title })

    const archiveSession = useCallback(async () => {
        setIsArchiving(true)
        try {
            if (session.source === 'native') {
                if (!machineId) throw new Error(t('recentCodex.runnerRequired'))
                await api.archiveCodexSession(session.id, { machineId })
            } else {
                await api.archiveSession(session.id)
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            }
            onArchived(session)
        } finally {
            setIsArchiving(false)
        }
    }, [api, machineId, onArchived, queryClient, session, t])

    return (
        <li className="min-w-0">
            {status !== 'processing' ? (
                <time
                    dateTime={new Date(modifiedAt).toISOString()}
                    className="mb-1 block px-1 text-xs tabular-nums text-[var(--app-hint)]"
                    title={formatTimestamp(session.modifiedAt)}
                    data-kanban-card-time
                >
                    {formatKanbanSessionTime(modifiedAt, now, dateLocale, t)}
                </time>
            ) : null}
            <div className="relative min-w-0">
                <button
                    type="button"
                    onClick={onOpen}
                    className={`session-kanban-card flex min-h-24 w-full min-w-0 flex-col rounded-[14px] border border-l-[3px] border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 pr-12 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[background-color,box-shadow] hover:bg-[var(--app-subtle-bg)] hover:shadow-[0_4px_12px_rgba(15,23,42,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${presentation.borderClassName} ${status === 'processing' ? 'session-kanban-card-thinking' : ''} ${selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                    style={completedDirectoryColor ? { borderLeftColor: completedDirectoryColor } : undefined}
                    aria-label={t('recentCodex.open', { title: session.title })}
                    aria-current={selected ? 'page' : undefined}
                    data-kanban-card-status={status}
                    data-kanban-directory-color={completedDirectoryColor ?? undefined}
                >
                    <span className="flex w-full min-w-0 items-center gap-2 pr-2" data-kanban-card-top-row>
                        <CodexSourceIcon source={session.source} active={status === 'processing'} />
                        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold leading-6 text-[var(--app-fg)]" title={session.title}>
                            {session.title}
                        </span>
                    </span>

                    <span className="mt-1.5 flex min-w-0 items-center gap-2" data-kanban-directory-row>
                        <MotionIcon
                            icon={toMotionIcon(FolderIconNode)}
                            className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]"
                            data-motion-icon="folder"
                            strokeWidth={1.8}
                            aria-hidden="true"
                        />
                        <span
                            className="min-w-0 truncate text-[13px] font-normal leading-5 text-[var(--app-hint)]"
                            title={session.cwd ?? undefined}
                            data-kanban-directory
                        >
                            {directoryLabel}
                        </span>
                        {isDirty && !branchLabel ? (
                            <GitDirtyIndicator label={t('recentCodex.gitDirty')} />
                        ) : null}
                    </span>

                    {branchLabel ? (
                        <span
                            className="mt-1.5 flex min-w-0 items-center gap-2 text-xs leading-4 text-[var(--app-hint)]"
                            data-git-kind={isWorktree ? 'worktree' : 'branch'}
                            title={isWorktree ? `${t('session.item.worktree')} · ${branchLabel}` : branchLabel}
                        >
                            <MotionIcon
                                icon={toMotionIcon(branchIcon)}
                                className={`h-3.5 w-3.5 shrink-0 ${isWorktree ? 'text-[var(--app-link)]' : ''}`}
                                data-motion-icon={isWorktree ? 'worktree' : 'branch'}
                                strokeWidth={1.8}
                                aria-hidden="true"
                            />
                            <span className="truncate">{branchLabel}</span>
                            {isDirty ? <GitDirtyIndicator label={t('recentCodex.gitDirty')} /> : null}
                        </span>
                    ) : null}
                </button>

                {onTogglePin ? (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            onTogglePin()
                        }}
                        className={`absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${pinned ? 'text-[var(--app-link)] hover:bg-[var(--app-secondary-bg)]' : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'}`}
                        aria-label={pinned ? t('sessions.kanban.unpin') : t('sessions.kanban.pin')}
                        title={pinned ? t('sessions.kanban.unpin') : t('sessions.kanban.pin')}
                        aria-pressed={pinned}
                    >
                        <Pin className="h-4 w-4" fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                ) : null}
                <button
                    type="button"
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setArchiveOpen(true)
                    }}
                    className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={t('session.action.archive')}
                    title={t('session.action.archive')}
                    data-kanban-archive
                >
                    <ArchiveIconNode className="h-4 w-4" aria-hidden="true" />
                </button>
                <ConfirmDialog
                    isOpen={archiveOpen}
                    onClose={() => setArchiveOpen(false)}
                    title={t('recentCodex.archive.title')}
                    description={archiveDescription}
                    confirmLabel={t('recentCodex.archive.confirm')}
                    confirmingLabel={t('recentCodex.archive.confirming')}
                    onConfirm={archiveSession}
                    isPending={isArchiving}
                    destructive
                />
            </div>
        </li>
    )
}

const NO_DIRECTORY_KEY = '__no-directory__'

function GitDirtyIndicator(props: { label: string }) {
    return (
        <span
            role="img"
            aria-label={props.label}
            title={props.label}
            data-git-dirty
            className="h-2 w-2 shrink-0 rounded-full bg-[#F5A524] shadow-[0_0_0_2px_rgba(245,165,36,0.14)]"
        />
    )
}

function ThinkingKanbanLabel(props: { label: string }) {
    return (
        <span className="inline-flex whitespace-nowrap" data-kanban-thinking-label>
            {props.label}
            <span className="inline-flex w-[1.35em]" aria-hidden="true">
                <span>.</span>
                <span className="session-kanban-thinking-dot-second">.</span>
                <span className="session-kanban-thinking-dot-third">.</span>
            </span>
        </span>
    )
}

function getDirectoryKey(directory: string | null): string {
    return directory ?? NO_DIRECTORY_KEY
}

function DirectoryGroupHeader(props: {
    directory: string | null
    label: string
    machineId: string | null
    api: ApiClient
    collapsed: boolean
    onToggle: () => void
    onNewSessionInDirectory?: (directory: string) => Promise<boolean>
    isNewSessionPending?: boolean
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const {
        directory,
        label,
        machineId,
        api,
        collapsed,
        onToggle,
        onNewSessionInDirectory,
        isNewSessionPending = false,
        t
    } = props
    const [isCreating, setIsCreating] = useState(false)
    const [creationSucceeded, setCreationSucceeded] = useState(false)
    const creationFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const mountedRef = useRef(true)
    const folderIcon = toMotionIcon(collapsed ? FolderIconNode : FolderOpenIconNode)
    const { branch, isWorktree, isDirty } = useMachineGitBranch(api, machineId, directory)
    const branchLabel = branch ? getDetachedBranchLabel(branch, t) : null
    const branchIcon = isWorktree ? TreePineIconNode : GitBranchIconNode
    const actionLabel = collapsed
        ? t('recentCodex.directory.expand', { directory: label })
        : t('recentCodex.directory.collapse', { directory: label })
    const canCreateSession = Boolean(directory && onNewSessionInDirectory)
    const createPending = isCreating || isNewSessionPending
    const creationIcon = isCreating
        ? LoaderCircle
        : creationSucceeded
            ? CircleCheck
            : PlusIconNode

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            if (creationFeedbackTimerRef.current) {
                clearTimeout(creationFeedbackTimerRef.current)
            }
        }
    }, [])

    const createSession = useCallback(async () => {
        if (!directory || !onNewSessionInDirectory || createPending) return
        if (creationFeedbackTimerRef.current) {
            clearTimeout(creationFeedbackTimerRef.current)
            creationFeedbackTimerRef.current = null
        }
        setCreationSucceeded(false)
        setIsCreating(true)

        let created = false
        try {
            created = await onNewSessionInDirectory(directory)
        } catch {
            // The caller already surfaces the create failure as a toast.
        }

        if (!mountedRef.current) return
        setIsCreating(false)
        if (!created) return

        setCreationSucceeded(true)
        creationFeedbackTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setCreationSucceeded(false)
        }, 720)
    }, [createPending, directory, onNewSessionInDirectory])

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
                <MotionIcon
                    icon={folderIcon}
                    className="h-[27.5px] w-[27.5px] shrink-0 text-[var(--app-fg)]"
                    data-motion-icon={collapsed ? 'folder' : 'folder-open'}
                />
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span
                            data-testid="recent-codex-directory-name"
                            className="block min-w-0 truncate text-[17px] font-semibold leading-6 text-[var(--app-fg)]"
                        >
                            {label}
                        </span>
                        {isDirty && !branchLabel ? (
                            <GitDirtyIndicator label={t('recentCodex.gitDirty')} />
                        ) : null}
                    </span>
                    {branchLabel ? (
                        <span
                            data-testid="recent-codex-directory-branch"
                            data-git-kind={isWorktree ? 'worktree' : 'branch'}
                            className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-[var(--app-hint)]"
                            title={isWorktree ? `${t('session.item.worktree')} · ${branchLabel}` : branchLabel}
                        >
                            <MotionIcon
                                icon={toMotionIcon(branchIcon)}
                                className={`h-3 w-3 shrink-0 ${isWorktree ? 'text-[var(--app-link)]' : ''}`}
                                data-motion-icon={isWorktree ? 'worktree' : 'branch'}
                                strokeWidth={1.8}
                                aria-hidden="true"
                            />
                            <span className="truncate">{branchLabel}</span>
                            {isDirty ? <GitDirtyIndicator label={t('recentCodex.gitDirty')} /> : null}
                        </span>
                    ) : null}
                </span>
                <ChevronDown
                    className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
                    aria-hidden="true"
                />
            </button>
            {canCreateSession ? (
                <button
                    type="button"
                    onClick={() => void createSession()}
                    disabled={createPending}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] touch-manipulation disabled:cursor-not-allowed disabled:opacity-45"
                    title={t('sessions.group.new')}
                    aria-label={t('sessions.group.new')}
                    aria-busy={createPending || undefined}
                >
                    <MotionIcon
                        icon={toMotionIcon(creationIcon)}
                        className={isCreating ? 'h-4 w-4 motion-safe:animate-spin' : 'h-5 w-5'}
                        data-motion-icon={isCreating ? 'loader' : creationSucceeded ? 'check' : 'plus'}
                    />
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
    onNewSessionInDirectory?: (directory: string) => Promise<boolean>
    /** Disable directory creation actions while a session is being created. */
    isNewSessionPending?: boolean
    /** Switch the merged sessions index between its directory list and board. */
    viewMode?: 'list' | 'kanban'
    /** Browser-local board pins, scoped by the merged session key. */
    pinnedSessionKeys?: ReadonlySet<string>
    /** Toggle a browser-local board pin. */
    onTogglePin?: (sessionKey: string) => void
}) {
    const { locale, t } = useTranslation()
    const localDay = useLocalDayKey()
    const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
    const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now())
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
    const realtimeListUpdateBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const manualRefreshFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const mountedRef = useRef(true)
    const realtimeListUpdatesRef = useRef(new Map<string, { receivedAt: number; update: NativeCodexSessionListUpdate }>())
    const pendingRealtimeListUpdatesRef = useRef(new Map<string, NativeCodexSessionListUpdate>())
    const realtimeListUpdateBatchGenerationRef = useRef(0)
    const hasInitializedRealtimeStateRef = useRef(false)
    const [manualRefreshFeedback, setManualRefreshFeedback] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
    const [archivedSessionKeys, setArchivedSessionKeys] = useState<Set<string>>(() => new Set())

    useEffect(() => {
        const updateRelativeTime = () => setRelativeTimeNow(Date.now())
        const interval = window.setInterval(updateRelativeTime, 30_000)
        document.addEventListener('visibilitychange', updateRelativeTime)
        return () => {
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', updateRelativeTime)
        }
    }, [])
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
                .filter((session) => !archivedSessionKeys.has(session.key))
            : [],
        [archivedSessionKeys, isMerged, props.hapiSessions, recentNativeSessions]
    )
    const completedDirectoryColors = useMemo(
        () => assignCompletedSessionDirectoryColors(
            mergedSessions
                .filter((session) => getMergedCodexKanbanStatus(session) === 'completed')
                .map((session) => session.cwd)
        ),
        [mergedSessions]
    )
    const mergedDirectoryGroups = useMemo(
        () => groupMergedCodexSessionsByDirectory(mergedSessions),
        [mergedSessions]
    )
    const kanbanGroups = useMemo(
        () => groupMergedCodexSessionsForKanban(mergedSessions, props.pinnedSessionKeys),
        [mergedSessions, props.pinnedSessionKeys]
    )
    const completedTimelineGroups = useMemo(() => {
        const completed = kanbanGroups.find((group) => group.id === 'completed')?.sessions ?? []
        return groupMergedCodexCompletedTimeline(completed, new Date(), dateLocale, {
            today: t('shares.timeline.today'),
            yesterday: t('shares.timeline.yesterday'),
            daysAgo: (days) => t('shares.timeline.daysAgo', { days })
        })
    }, [dateLocale, kanbanGroups, localDay, t])

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

    const refresh = useCallback(async (forceRefresh = false): Promise<boolean> => {
        const startedAt = Date.now()
        setIsLoading(true)
        setLoadError(null)
        const machineId = props.machineId
        if (!machineId) {
            setSessions([])
            setIsLoading(false)
            return false
        }
        try {
            const response = isMerged
                ? await props.api.getCodexSessions({
                    machineId,
                    limit,
                    ...(forceRefresh ? { forceRefresh: true } : {})
                })
                : await props.api.getCodexSessions({
                    machineId,
                    limit,
                    excludeHapiInitiated: true,
                    ...(forceRefresh ? { forceRefresh: true } : {})
                })
            const updatesWhileFetching = Array.from(realtimeListUpdatesRef.current.values())
                .filter((entry) => entry.receivedAt >= startedAt)
                .map((entry) => entry.update)
            setSessions(() => updatesWhileFetching.reduce(
                (next, update) => applyNativeCodexSessionListUpdate(next, update, limit, {
                    excludeHapiInitiated: !isMerged
                }),
                response.sessions
            ))
            setLastUpdatedAt(Date.now())
            return true
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error))
            return false
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

        const batchGeneration = realtimeListUpdateBatchGenerationRef.current
        const flushRealtimeListUpdates = () => {
            realtimeListUpdateBatchTimerRef.current = null
            scheduleBackgroundWork(() => {
                if (
                    !mountedRef.current
                    || realtimeListUpdateBatchGenerationRef.current !== batchGeneration
                ) {
                    return
                }

                const updates = Array.from(pendingRealtimeListUpdatesRef.current.values())
                pendingRealtimeListUpdatesRef.current.clear()
                if (updates.length === 0) return

                setSessions((current) => updates.reduce(
                    (next, update) => applyNativeCodexSessionListUpdate(next, update, limit, {
                        excludeHapiInitiated: !isMerged
                    }),
                    current
                ))
                setLastUpdatedAt(Date.now())
            })
        }

        const scheduleRealtimeListUpdateBatch = () => {
            if (realtimeListUpdateBatchTimerRef.current) return
            realtimeListUpdateBatchTimerRef.current = setTimeout(
                flushRealtimeListUpdates,
                NATIVE_CODEX_LIST_UPDATE_BATCH_MS
            )
        }

        const unsubscribe = subscribeNativeCodexSessionUpdated((event) => {
            if (event.machineId !== machineId) {
                return
            }
            const update = getNativeCodexSessionListUpdate(event)
            if (update) {
                realtimeListUpdatesRef.current.set(update.id, { receivedAt: Date.now(), update })
                pendingRealtimeListUpdatesRef.current.set(update.id, update)
                scheduleRealtimeListUpdateBatch()
                return
            }
            if (realtimeRefreshTimerRef.current) {
                clearTimeout(realtimeRefreshTimerRef.current)
            }
            realtimeRefreshTimerRef.current = setTimeout(() => {
                realtimeRefreshTimerRef.current = null
                void refresh(true)
            }, 100)
        })

        return () => {
            unsubscribe()
            realtimeListUpdateBatchGenerationRef.current += 1
            if (realtimeListUpdateBatchTimerRef.current) {
                clearTimeout(realtimeListUpdateBatchTimerRef.current)
                realtimeListUpdateBatchTimerRef.current = null
            }
            pendingRealtimeListUpdatesRef.current.clear()
        }
    }, [isMerged, limit, props.machineId, refresh])

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            if (realtimeRefreshTimerRef.current) {
                clearTimeout(realtimeRefreshTimerRef.current)
                realtimeRefreshTimerRef.current = null
            }
            if (manualRefreshFeedbackTimerRef.current) {
                clearTimeout(manualRefreshFeedbackTimerRef.current)
                manualRefreshFeedbackTimerRef.current = null
            }
        }
    }, [])

    const handleManualRefresh = useCallback(async () => {
        if (isLoading || !props.machineId) return
        if (manualRefreshFeedbackTimerRef.current) {
            clearTimeout(manualRefreshFeedbackTimerRef.current)
            manualRefreshFeedbackTimerRef.current = null
        }
        setManualRefreshFeedback('loading')
        const refreshed = await refresh(true)
        if (!mountedRef.current) return

        setManualRefreshFeedback(refreshed ? 'success' : 'error')
        manualRefreshFeedbackTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) setManualRefreshFeedback('idle')
        }, 720)
    }, [isLoading, props.machineId, refresh])

    const handleArchived = useCallback((session: MergedCodexSession) => {
        setArchivedSessionKeys((current) => new Set(current).add(session.key))
        if (session.source === 'native') {
            setSessions((current) => current.filter((candidate) => candidate.id !== session.id))
            void refresh(true)
        }
    }, [refresh])

    // Current runners patch this list through SSE. Older runners, or a
    // temporarily disconnected event stream, retain a small polling fallback.
    useEffect(() => {
        if (!props.machineId || hasRealtimeUpdates) {
            return
        }

        const refreshIfVisible = () => {
            if (document.visibilityState === 'visible') {
                void refresh(true)
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
    const refreshIcon = manualRefreshFeedback === 'success'
        ? CircleCheck
        : manualRefreshFeedback === 'error'
            ? CircleAlert
            : isLoading || manualRefreshFeedback === 'loading'
                ? LoaderCircle
                : RefreshIconNode

    return (
        <section
            className={embedded
                ? 'app-scroll-y flex min-h-0 w-full flex-1 flex-col px-4 pb-3 pt-1 sm:px-6 [font-family:var(--app-control-font-family)]'
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
                            onClick={() => void handleManualRefresh()}
                            disabled={isLoading || !props.machineId}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                            aria-label={t('recentCodex.refresh')}
                            title={t('recentCodex.refresh')}
                        >
                            <MotionIcon
                                icon={toMotionIcon(refreshIcon)}
                                className={`h-3.5 w-3.5 ${isLoading || manualRefreshFeedback === 'loading' ? 'motion-safe:animate-spin' : ''}`}
                                data-motion-icon={manualRefreshFeedback === 'success'
                                    ? 'check'
                                    : manualRefreshFeedback === 'error'
                                        ? 'alert'
                                        : isLoading || manualRefreshFeedback === 'loading'
                                            ? 'loader'
                                            : 'refresh'}
                            />
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
                            onClick={() => void handleManualRefresh()}
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
            ) : isMerged && props.viewMode === 'kanban' ? (
                <div
                    className={embedded
                        ? 'mt-1 flex min-h-0 flex-col gap-6 pb-3'
                        : 'mt-4 flex min-h-0 flex-col gap-6 overflow-y-auto pb-3 pr-1'}
                    data-testid="session-kanban-board"
                >
                    {kanbanGroups
                        .filter((group) => group.id !== 'completed' && group.sessions.length > 0)
                        .map((group) => {
                        const presentation = KANBAN_GROUP_PRESENTATION[group.id]
                        return (
                            <section key={group.id} className="min-w-0" data-kanban-group={group.id}>
                                <div className="flex items-center gap-2 px-1">
                                    {group.id === 'pinned' ? (
                                        <Pin className={`h-3.5 w-3.5 shrink-0 ${presentation.dotClassName}`} fill="currentColor" aria-hidden="true" />
                                    ) : (
                                        <span
                                            className={`h-2 w-2 shrink-0 rounded-full ${presentation.dotClassName} ${group.id === 'processing' ? 'motion-safe:animate-pulse' : ''}`}
                                            aria-hidden="true"
                                        />
                                    )}
                                    <h2 className="text-xs font-semibold tracking-[0.04em] text-[var(--app-hint)]">
                                        {group.id === 'processing' ? (
                                            <ThinkingKanbanLabel label={t(presentation.labelKey)} />
                                        ) : t(presentation.labelKey)}
                                    </h2>
                                </div>
                                <ul className="mt-2 flex flex-col gap-2.5 pl-5" data-kanban-card-column>
                                    {group.sessions.map((session) => (
                                        <KanbanSessionCard
                                            key={session.key}
                                            api={props.api}
                                            machineId={props.machineId}
                                            session={session}
                                            selected={session.source === 'hapi' && session.id === props.selectedSessionId}
                                            pinned={props.pinnedSessionKeys?.has(session.key) ?? false}
                                            dateLocale={dateLocale}
                                            now={relativeTimeNow}
                                            directoryColor={getAssignedCompletedSessionDirectoryColor(completedDirectoryColors, session.cwd)}
                                            t={t}
                                            onTogglePin={props.onTogglePin ? () => props.onTogglePin?.(session.key) : undefined}
                                            onArchived={handleArchived}
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
                            </section>
                        )
                    })}
                    {completedTimelineGroups.length > 0 ? (
                        <section className="min-w-0" data-kanban-group="completed">
                            <div
                                className="flex items-center gap-2 px-1"
                                role="separator"
                                aria-label={`${t('sessions.kanban.completed')} ${completedTimelineGroups.reduce((count, group) => count + group.shares.length, 0)}`}
                                data-kanban-completed-divider
                            >
                                <span
                                    className="h-px min-w-3 flex-1 bg-[color-mix(in_srgb,var(--app-border)_72%,transparent)]"
                                    aria-hidden="true"
                                    data-kanban-divider-line
                                />
                                <h2 className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-[var(--app-hint)]">
                                    <MotionIcon
                                        icon={toMotionIcon(CircleCheck)}
                                        className="h-3.5 w-3.5 shrink-0 text-[#34C759]"
                                        data-motion-icon="completed"
                                        aria-hidden="true"
                                    />
                                    {t('sessions.kanban.completed')}
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">
                                        {completedTimelineGroups.reduce((count, group) => count + group.shares.length, 0)}
                                    </span>
                                </h2>
                                <span
                                    className="h-px min-w-3 flex-1 bg-[color-mix(in_srgb,var(--app-border)_72%,transparent)]"
                                    aria-hidden="true"
                                    data-kanban-divider-line
                                />
                            </div>
                            <div className="relative mt-3 pl-5" data-kanban-card-column>
                                <div aria-hidden="true" className="absolute bottom-2 left-[5px] top-2 w-px bg-gradient-to-b from-transparent via-[var(--app-divider)] to-transparent" />
                                <div className="space-y-5">
                                    {completedTimelineGroups.map((group) => (
                                        <section key={group.key} className="relative" data-kanban-date-group={group.key}>
                                            <span
                                                aria-hidden="true"
                                                className="absolute -left-[21px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_1px_3px_rgba(15,23,42,0.12)]"
                                            >
                                                <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-hint)]" />
                                            </span>
                                            <div className="flex min-w-0 items-center gap-2">
                                                <h3 className="shrink-0 text-[11px] font-semibold tracking-[0.04em] text-[var(--app-hint)]">
                                                    {group.label}
                                                </h3>
                                                <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-gradient-to-r from-[var(--app-divider)] to-transparent" />
                                            </div>
                                            <ul className="mt-2 flex flex-col gap-2.5">
                                                {group.shares.map((session) => (
                                                    <KanbanSessionCard
                                                        key={session.key}
                                                        api={props.api}
                                                        machineId={props.machineId}
                                                        session={session}
                                                        selected={session.source === 'hapi' && session.id === props.selectedSessionId}
                                                        pinned={props.pinnedSessionKeys?.has(session.key) ?? false}
                                                        dateLocale={dateLocale}
                                                        now={relativeTimeNow}
                                                        directoryColor={getAssignedCompletedSessionDirectoryColor(completedDirectoryColors, session.cwd)}
                                                        t={t}
                                                        onTogglePin={props.onTogglePin ? () => props.onTogglePin?.(session.key) : undefined}
                                                        onArchived={handleArchived}
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
                                        </section>
                                    ))}
                                </div>
                            </div>
                        </section>
                    ) : null}
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
                                    machineId={props.machineId}
                                    api={props.api}
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
                                    machineId={props.machineId}
                                    api={props.api}
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
