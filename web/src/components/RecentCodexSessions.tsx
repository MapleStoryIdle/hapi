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
import {
    Activity,
    Bot as BotIcon,
    ChevronDown,
    ChevronRight,
    CircleAlert as CircleAlertIcon,
    CircleCheck as CircleCheckIcon,
    Clock3,
    Eye as EyeIcon,
    History,
    LoaderCircle as LoaderCircleIcon,
    Pin,
    ArrowDownUp,
    type LucideIcon
} from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { SessionGroup } from '@hapi/protocol/sessionGroups'
import { resolveSessionGroup, useSessionGroups } from '@/hooks/useSessionGroups'
import { useSessionPins, type SessionPinTarget } from '@/hooks/useSessionPins'
import { useKanbanOrder, kanbanOrderQueryKey } from '@/hooks/useKanbanOrder'
import { normalizeKanbanOrder, sortKanbanLanes } from '@hapi/protocol/kanbanOrder'
import { KanbanOrderDrawer } from '@/components/KanbanOrderDrawer'
import type { CodexLocalSessionSummary, SessionSummary } from '@/types/api'
import { formatRelativeTime } from '@/lib/relativeTime'
import { getDetachedBranchLabel } from '@/lib/files-i18n'
import { useMachineGitBranch } from '@/hooks/queries/useGitBranch'
import { KanbanGitControl } from '@/components/KanbanGitControl'
import { useTranslation } from '@/lib/use-translation'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import { SessionThinkingIndicator } from '@/components/SessionThinkingIndicator'
import { MotionIcon, toMotionIcon } from '@/components/MotionIcon'
import { useNativeCodexRealtime } from '@/lib/native-codex-realtime-context'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SwipeArchiveRow } from '@/components/SwipeArchiveRow'
import { useLocalDayKey } from '@/hooks/useLocalDayKey'
import { formatShareTimelineTime, groupShareTimeline, localDateKey } from '@/lib/shareTimeline'
import { queryKeys } from '@/lib/query-keys'
import { scheduleBackgroundWork } from '@/lib/interaction-priority'
import {
    getNativeCodexSessionListUpdate,
    subscribeNativeCodexSessionUpdated,
    type NativeCodexSessionListUpdate
} from '@/lib/native-codex-realtime-events'
import {
    initializeCodexKanbanLastSeen,
    markSessionSeen,
    useSessionLastSeenState
} from '@/lib/sessionLastSeen'

/** The sessions index intentionally stays focused on the last three days. */
export const RECENT_CODEX_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
export const RECENT_COMPLETED_WINDOW_MS = 30 * 60 * 1000
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

/** A display-only row shared by managed SHAPI and runner-local Codex records. */
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

type BuiltInKanbanGroupId = 'pinned' | 'unviewed' | 'recent' | MergedCodexKanbanStatus
export type MergedCodexKanbanGroupId = BuiltInKanbanGroupId | `custom:${string}`

export type MergedCodexKanbanGroup = {
    id: MergedCodexKanbanGroupId
    sessions: MergedCodexSession[]
    customGroup?: SessionGroup
}

const EMPTY_PINNED_SESSION_KEYS: ReadonlySet<string> = new Set()
const EMPTY_SESSION_GROUPS: ReadonlyMap<string, SessionGroup> = new Map()
const KANBAN_HEADING_CLASS_NAME = 'text-xs font-semibold tracking-[0.04em] text-[var(--app-hint)]'
const KANBAN_DATE_EMOJIS = ['🌿', '🌤️', '🌻', '🍀', '🌙', '🌊', '🍁', '✨', '🌸', '🪴', '🪁', '🍊'] as const

/** Varied by calendar date, stable across refreshes and locale changes. */
export function getKanbanDateEmoji(dateKey: string): string {
    let hash = 0
    for (const char of dateKey) hash = Math.imul(hash, 31) + char.charCodeAt(0)
    return KANBAN_DATE_EMOJIS[(hash >>> 0) % KANBAN_DATE_EMOJIS.length]
}

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
    return directory?.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || null
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

/** Group identity follows the full name, never its lane, emoji or neighbors. */
export function getSessionGroupColor(name: string): string {
    return COMPLETED_SESSION_DIRECTORY_COLORS[getCompletedSessionDirectoryColorIndex(name.trim())]
}

/** Project names keep their color regardless of parent path or visible neighbors. */
export function assignCompletedSessionDirectoryColors(
    directories: readonly (string | null)[]
): ReadonlyMap<string, string> {
    const normalizedDirectories = [...new Set(
        directories
            .map(normalizeDirectoryColorKey)
            .filter((directory): directory is string => directory !== null)
    )].sort()
    const assignments = new Map<string, string>()

    for (const directory of normalizedDirectories) {
        assignments.set(directory, COMPLETED_SESSION_DIRECTORY_COLORS[getCompletedSessionDirectoryColorIndex(directory)])
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

const KANBAN_GROUP_PRESENTATION: Record<BuiltInKanbanGroupId, {
    labelKey: string
    Icon: LucideIcon
    iconClassName: string
    borderClassName: string
}> = {
    pinned: {
        labelKey: 'sessions.kanban.pinned',
        Icon: Pin,
        iconClassName: 'text-[var(--app-hint)]',
        borderClassName: 'border-l-[var(--app-divider)]'
    },
    pending: {
        labelKey: 'sessions.kanban.pending',
        Icon: CircleAlertIcon,
        iconClassName: 'text-[#F59E0B]',
        borderClassName: 'border-l-[#F59E0B]'
    },
    processing: {
        labelKey: 'sessions.kanban.processing',
        Icon: LoaderCircleIcon,
        iconClassName: 'text-[#34C759]',
        borderClassName: 'border-l-[#34C759]'
    },
    unviewed: {
        labelKey: 'sessions.kanban.unviewed',
        Icon: EyeIcon,
        iconClassName: 'text-[#4E7CF5]',
        borderClassName: 'border-l-[#4E7CF5]'
    },
    recent: {
        labelKey: 'sessions.kanban.recent',
        Icon: Clock3,
        iconClassName: 'text-[var(--app-hint)]',
        borderClassName: 'border-l-[var(--app-divider)]'
    },
    completed: {
        labelKey: 'sessions.kanban.completed',
        Icon: CircleCheckIcon,
        iconClassName: 'text-[var(--app-hint)]',
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

function getHapiSessionUpdatedAt(session: MergedCodexSession): number {
    return session.hapiSession?.updatedAt ?? session.modifiedAt
}

/** A completed managed Codex row stays unviewed only inside the recent completion window. */
export function isMergedCodexSessionUnviewed(
    session: MergedCodexSession,
    lastSeenAtBySession: Readonly<Record<string, number>>,
    now = Date.now()
): boolean {
    if (session.source !== 'hapi' || getMergedCodexKanbanStatus(session) !== 'completed') {
        return false
    }

    const completedAt = toEpochMilliseconds(getHapiSessionUpdatedAt(session))
    // A Hub timestamp can be a few milliseconds ahead of the browser clock.
    // Treat that as a just-finished session rather than hiding its unread state.
    const age = Math.max(0, now - completedAt)
    if (!Number.isFinite(completedAt) || age >= RECENT_COMPLETED_WINDOW_MS) {
        return false
    }

    return completedAt > toEpochMilliseconds(lastSeenAtBySession[session.id] ?? 0)
}

export function groupMergedCodexSessionsForKanban(
    sessions: MergedCodexSession[],
    pinnedSessionKeys: ReadonlySet<string> = EMPTY_PINNED_SESSION_KEYS,
    lastSeenAtBySession: Readonly<Record<string, number>> | null = null,
    now = Date.now(),
    sessionGroups: ReadonlyMap<string, SessionGroup> = EMPTY_SESSION_GROUPS
): MergedCodexKanbanGroup[] {
    const customGroups = [...new Map([...sessionGroups.values()].map(group => [group.id, group])).values()]
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    const groups: MergedCodexKanbanGroup[] = [
        { id: 'processing', sessions: [] },
        { id: 'pending', sessions: [] },
        { id: 'unviewed', sessions: [] },
        { id: 'pinned', sessions: [] },
        ...customGroups.map((group): MergedCodexKanbanGroup => ({ id: `custom:${group.id}`, customGroup: group, sessions: [] })),
        { id: 'recent', sessions: [] },
        { id: 'completed', sessions: [] }
    ]
    const groupsById = new Map(groups.map((group) => [group.id, group]))

    for (const session of sessions) {
        const status = getMergedCodexKanbanStatus(session)
        const customGroup = sessionGroups.get(session.key)
        // List summaries expose activity time, not a separate completion time.
        const age = now - toEpochMilliseconds(session.modifiedAt)
        // User action and active thinking take precedence over a local pin.
        // An unviewed completed managed session takes precedence over a pin.
        const groupId: MergedCodexKanbanGroupId = status === 'completed' && lastSeenAtBySession !== null
            && isMergedCodexSessionUnviewed(session, lastSeenAtBySession, now)
            ? 'unviewed'
            : status === 'completed' && pinnedSessionKeys.has(session.key)
                ? 'pinned'
                : status === 'completed' && customGroup
                    ? `custom:${customGroup.id}`
                    : status === 'completed' && age >= 0 && age < RECENT_COMPLETED_WINDOW_MS
                        ? 'recent'
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
 * Build the single Codex list shown on the sessions index. SHAPI rows win over
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

function CodexSourceIcon(props: { source: CodexSessionSource; active?: boolean; sshControlled?: boolean }) {
    const { t } = useTranslation()
    const isHapi = props.source === 'hapi'
    const sourceLabel = isHapi ? t('recentCodex.source.hapi') : t('recentCodex.source.native')
    const isSshControlled = !isHapi && props.sshControlled === true
    const accessibleLabel = props.active
        ? t(isHapi ? 'recentCodex.status.hapiProcessing' : 'recentCodex.status.processing')
        : isSshControlled ? t('recentCodex.sshControl.title') : sourceLabel
    return (
        <span
            className="cupertino-session-source relative inline-flex h-5 w-5 shrink-0 items-center justify-center"
            title={isSshControlled ? t('recentCodex.sshControl.title') : sourceLabel}
            role="img"
            aria-label={accessibleLabel}
            data-session-source={props.source}
            data-session-agent="codex"
            data-session-active={props.active || undefined}
            data-session-ssh-controlled={isSshControlled || undefined}
        >
            <AgentFlavorIcon
                flavor="codex"
                className={`cupertino-session-source-glyph h-5 w-5 ${isSshControlled ? 'text-[#F5A524]' : isHapi ? 'text-[#4EA1FF]' : 'text-[var(--app-fg)]'}`}
            />
            {props.active ? (
                <span
                    data-session-running-indicator
                    className="cupertino-session-live-signal absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-bg)] bg-[#34C759] motion-safe:animate-pulse"
                    aria-hidden="true"
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

function isHapiSideSession(session: MergedCodexSession): boolean {
    return session.source === 'hapi'
        && Boolean(session.hapiSession?.metadata?.sideSession?.parentSessionId?.trim())
}

function KanbanSubagentBadge(props: { label: string; title: string }) {
    return (
        <span
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-[#7254D6]/20 bg-[#7254D6]/10 px-1.5 text-[10px] font-semibold leading-none text-[#7254D6]"
            title={props.title}
            data-kanban-subagent-badge
        >
            <BotIcon
                className="h-3 w-3 shrink-0"
                aria-hidden="true"
                data-kanban-subagent-icon
            />
            <span>{props.label}</span>
        </span>
    )
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
    sessionGroup?: SessionGroup
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const { api, machineId, session, selected = false, pinned, onOpen, onTogglePin, onArchived, dateLocale, now, directoryColor, t } = props
    const queryClient = useQueryClient()
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [isArchiving, setIsArchiving] = useState(false)
    const status = getMergedCodexKanbanStatus(session)
    const presentation = KANBAN_GROUP_PRESENTATION[status]
    const completedDirectoryColor = status === 'completed' ? directoryColor : null
    const groupColor = props.sessionGroup ? getSessionGroupColor(props.sessionGroup.name) : null
    const borderColor = groupColor ?? completedDirectoryColor
    const modifiedAt = toEpochMilliseconds(session.modifiedAt)
    const directoryLabel = getKanbanDirectoryLabel(session.cwd) ?? t('recentCodex.noDirectory')
    const gitMachineId = session.hapiSession?.metadata?.machineId ?? machineId
    const gitCwd = session.hapiSession?.metadata?.path ?? session.cwd
    const git = useMachineGitBranch(api, gitMachineId, gitCwd)
    const { branch, isWorktree, isDirty } = git
    const branchLabel = branch ? getDetachedBranchLabel(branch, t) : null
    const branchIcon = isWorktree ? TreePineIconNode : GitBranchIconNode
    const completedTime = status === 'completed'
        ? formatKanbanSessionTime(modifiedAt, now, dateLocale, t)
        : null
    const isSubagent = isHapiSideSession(session)
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
            <SwipeArchiveRow label={t('session.action.archive')} onArchive={() => setArchiveOpen(true)} disabled={isArchiving}>
            <div className="relative min-w-0">
                <div
                    className={`cupertino-session-card session-kanban-card flex min-h-[5.625rem] w-full min-w-0 flex-col rounded-[14px] border border-l-[3px] border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[background-color,box-shadow,transform] hover:bg-[var(--app-subtle-bg)] hover:shadow-[0_4px_12px_rgba(15,23,42,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${presentation.borderClassName} ${status === 'processing' ? 'session-kanban-card-thinking' : ''} ${selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                    style={borderColor ? { borderLeftColor: borderColor } : undefined}
                    data-kanban-card-status={status}
                    data-kanban-directory-color={!groupColor ? completedDirectoryColor ?? undefined : undefined}
                    data-kanban-group-color={groupColor ?? undefined}
                    data-kanban-subagent={isSubagent ? 'true' : undefined}
                >
                    <button type="button" onClick={onOpen} aria-label={t('recentCodex.open', { title: session.title })} aria-current={selected ? 'page' : undefined} className="absolute inset-0 rounded-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" />
                    <span className="pointer-events-none relative flex w-full min-w-0 items-center gap-2 pr-8" data-kanban-card-top-row>
                        <CodexSourceIcon
                            source={session.source}
                            active={status === 'processing'}
                            sshControlled={session.source === 'native' && session.nativeSession?.controlledByCodexSsh === true}
                        />
                        {isSubagent ? (
                            <KanbanSubagentBadge
                                label={t('recentCodex.sideSession.badge')}
                                title={t('recentCodex.sideSession.badgeTitle')}
                            />
                        ) : null}
                        <span className="cupertino-session-card-title min-w-0 flex-1 truncate text-[17px] font-semibold leading-6 text-[var(--app-fg)]" title={session.title}>
                            {session.title}
                        </span>
                    </span>

                    <span className="pointer-events-none relative mt-1.5 flex min-w-0 items-center gap-2" data-kanban-directory-row>
                        <MotionIcon
                            icon={toMotionIcon(FolderIconNode)}
                            className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]"
                            data-motion-icon="folder"
                            strokeWidth={1.8}
                            aria-hidden="true"
                        />
                        <span className="inline-flex min-w-0 items-center" data-git-label>
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
                    </span>

                        <span
                            className="pointer-events-none relative mt-1.5 flex w-full min-w-0 items-center gap-2 text-xs leading-4 text-[var(--app-hint)]"
                            data-kanban-branch-row
                            data-git-kind={git.isGitRepository ? (isWorktree ? 'worktree' : 'branch') : git.repositoryState}
                            title={branchLabel ? (isWorktree ? `${t('session.item.worktree')} · ${branchLabel}` : branchLabel) : undefined}
                        >
                            <KanbanGitControl api={api} machineId={gitMachineId} cwd={gitCwd} git={git}>
                            <MotionIcon
                                icon={toMotionIcon(branchIcon)}
                                className={`h-3.5 w-3.5 shrink-0 ${isWorktree ? 'text-[var(--app-link)]' : ''}`}
                                data-motion-icon={isWorktree ? 'worktree' : 'branch'}
                                strokeWidth={1.8}
                                aria-hidden="true"
                            />
                            <span className="inline-flex min-w-0 items-center" data-git-label>
                                <span className="truncate">{branchLabel ?? 'Git'}</span>
                                {isDirty ? <GitDirtyIndicator label={t('recentCodex.gitDirty')} /> : null}
                            </span>
                            </KanbanGitControl>
                            {completedTime ? (
                                <time
                                    dateTime={new Date(modifiedAt).toISOString()}
                                    className="cupertino-kanban-card-time ml-auto shrink-0 tabular-nums"
                                    title={formatTimestamp(session.modifiedAt)}
                                    data-kanban-card-time
                                >
                                    {completedTime}
                                </time>
                            ) : null}
                        </span>
                </div>

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
            </div>
            </SwipeArchiveRow>
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
            className="shrink-0 text-sm font-bold leading-none text-[var(--app-fg)]"
        >
            *
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
        <div className="cupertino-directory-header group/project flex min-h-12 w-full min-w-0 items-center gap-1 rounded-2xl px-2.5 py-0.5 transition-colors hover:bg-[var(--app-subtle-bg)]">
            <button
                type="button"
                onClick={onToggle}
                className="cupertino-directory-toggle flex min-h-11 min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] touch-manipulation"
                title={directory ?? undefined}
                aria-label={actionLabel}
                aria-expanded={!collapsed}
                data-directory-toggle={getDirectoryKey(directory)}
            >
                <span className="cupertino-directory-folder-tile flex h-8 w-8 shrink-0 items-center justify-center">
                    <MotionIcon
                        icon={folderIcon}
                        className="cupertino-directory-folder-glyph h-[27.5px] w-[27.5px] shrink-0 text-[var(--app-fg)]"
                        data-motion-icon={collapsed ? 'folder' : 'folder-open'}
                        aria-hidden="true"
                    />
                </span>
                <span className="cupertino-directory-summary min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex min-w-0 items-center" data-git-label>
                            <span
                                data-testid="recent-codex-directory-name"
                                className="cupertino-directory-name block min-w-0 truncate text-[17px] font-semibold leading-6 text-[var(--app-fg)]"
                            >
                                {label}
                            </span>
                            {isDirty && !branchLabel ? (
                                <GitDirtyIndicator label={t('recentCodex.gitDirty')} />
                            ) : null}
                        </span>
                    </span>
                    {branchLabel ? (
                        <span
                            data-testid="recent-codex-directory-branch"
                            data-git-kind={isWorktree ? 'worktree' : 'branch'}
                            className="cupertino-directory-branch mt-0.5 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-[var(--app-hint)]"
                            title={isWorktree ? `${t('session.item.worktree')} · ${branchLabel}` : branchLabel}
                        >
                            <MotionIcon
                                icon={toMotionIcon(branchIcon)}
                                className={`h-3 w-3 shrink-0 ${isWorktree ? 'text-[var(--app-link)]' : ''}`}
                                data-motion-icon={isWorktree ? 'worktree' : 'branch'}
                                strokeWidth={1.8}
                                aria-hidden="true"
                            />
                            <span className="inline-flex min-w-0 items-center" data-git-label>
                                <span className="truncate">{branchLabel}</span>
                                {isDirty ? <GitDirtyIndicator label={t('recentCodex.gitDirty')} /> : null}
                            </span>
                        </span>
                    ) : null}
                </span>
                <ChevronDown
                    className={`cupertino-directory-disclosure h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
                    aria-hidden="true"
                />
            </button>
            {canCreateSession ? (
                <button
                    type="button"
                    onClick={() => void createSession()}
                    disabled={createPending}
                    className="cupertino-directory-add flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] touch-manipulation disabled:cursor-not-allowed disabled:opacity-45"
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
        <li className="cupertino-session-row-item min-w-0">
            <button
                type="button"
                onClick={onOpen}
                className={`cupertino-session-row session-list-item flex min-h-[3.5rem] w-full min-w-0 items-center justify-between gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${selected ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                aria-label={t('recentCodex.open', { title: session.title })}
                aria-current={selected ? 'page' : undefined}
            >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                    <CodexSourceIcon
                        source={session.source}
                        active={session.active}
                        sshControlled={session.source === 'native' && session.nativeSession?.controlledByCodexSsh === true}
                    />
                    <span className="cupertino-session-title min-w-0 flex-1 truncate text-sm font-medium leading-5 tracking-normal text-[var(--app-fg)]" title={session.title}>
                        {session.title}
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                    <time
                        className="cupertino-session-time text-[11px] font-medium tabular-nums text-[var(--app-hint)]"
                        title={formatTimestamp(session.modifiedAt)}
                    >
                        {lastActiveLabel}
                    </time>
                    <ChevronRight className="cupertino-session-row-disclosure h-4 w-4 shrink-0" aria-hidden="true" />
                </span>
            </button>
        </li>
    )
}

/**
 * Native Codex transcripts use the same list language as SHAPI sessions. In
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
    /** Render as a non-scrolling section inside the main SHAPI session list. */
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
    /** Create a fresh SHAPI session using a known session directory. */
    onNewSessionInDirectory?: (directory: string) => Promise<boolean>
    /** Disable directory creation actions while a session is being created. */
    isNewSessionPending?: boolean
    /** Switch the merged sessions index between its directory list and board. */
    viewMode?: 'list' | 'kanban'
    /** Optional controlled pins for embedded consumers. Hub pins take precedence. */
    pinnedSessionKeys?: ReadonlySet<string>
    /** Toggle controlled pins for embedded consumers. */
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
    // Keep the richer Cupertino card treatment for Kanban only. The directory
    // list intentionally uses the earlier compact, nested list presentation.
    const isCupertinoPresentation = isMerged && embedded && props.viewMode === 'kanban'
    const shouldFilterRecent = props.recentOnly ?? isMerged
    const limit = props.limit ?? (isMerged ? 100 : 5)
    const SectionIcon = onlyProcessing ? Activity : History
    const [sessions, setSessions] = useState<CodexLocalSessionSummary[]>([])
    const [sessionsOwner, setSessionsOwner] = useState<{ api: ApiClient; machineId: string } | null>(null)
    const currentSourceRef = useRef({ api: props.api, machineId: props.machineId })
    currentSourceRef.current = { api: props.api, machineId: props.machineId }
    const hasSshControlledSession = sessions.some((session) => session.controlledByCodexSsh === true)
    const [isLoading, setIsLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
    // Keep directory disclosure choices local to this list.  A refresh should
    // update rows without unexpectedly reopening a directory the user closed.
    const [collapsedDirectories, setCollapsedDirectories] = useState<Set<string>>(() => new Set())
    const [collapsedSessionGroups, setCollapsedSessionGroups] = useState<Set<string>>(() => new Set())
    const toggleKanbanSection = (key: string) => setCollapsedSessionGroups(current => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })
    const sessionGroupsQuery = useSessionGroups(props.api)
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
    const sessionLastSeenState = useSessionLastSeenState()
    const codexKanbanLastSeenScope = props.machineId ?? 'all-runners'
    const isCodexKanbanLastSeenInitialized = sessionLastSeenState.codexKanbanInitializedScopes[codexKanbanLastSeenScope] === true

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
    const pinTargets = useMemo((): SessionPinTarget[] => mergedSessions.flatMap(session => {
        const metadata = session.hapiSession?.metadata
        const machineId = session.source === 'hapi' ? metadata?.machineId : props.machineId
        const nativeId = metadata?.agentSessionId?.trim()
        if (session.source === 'hapi') {
            return [{
                key: session.key,
                source: nativeId && machineId
                    ? { type: 'native-codex' as const, machineId, codexSessionId: nativeId }
                    : { type: 'managed' as const, sessionId: session.id },
                legacyKeys: [session.key]
            }]
        }
        return machineId && sessionsOwner?.api === props.api && sessionsOwner.machineId === machineId ? [{
            key: session.key,
            source: { type: 'native-codex' as const, machineId, codexSessionId: session.id },
            // Legacy native keys contain no machine identity. Keep those local
            // records untouched rather than guessing which machine owns them.
            legacyKeys: []
        }] : []
    }), [mergedSessions, props.api, props.machineId, sessionsOwner])
    const sessionPins = useSessionPins(props.api, pinTargets)
    const kanbanOrder = useKanbanOrder(props.api, isMerged && props.viewMode === 'kanban')
    const [orderDrawerOpen, setOrderDrawerOpen] = useState(false)
    const pinnedSessionKeys = sessionPins.enabled ? sessionPins.pinnedSessionKeys : props.pinnedSessionKeys
    const onTogglePin = sessionPins.enabled ? sessionPins.togglePinnedSessionKey : props.onTogglePin
    const completedDirectoryColors = useMemo(
        () => assignCompletedSessionDirectoryColors(
            mergedSessions
                .filter((session) => getMergedCodexKanbanStatus(session) === 'completed')
                .map((session) => session.cwd)
        ),
        [mergedSessions]
    )
    const sessionGroupsByKey = useMemo(() => {
        const assignments = new Map<string, SessionGroup>()
        for (const session of mergedSessions) {
            const nativeId = session.hapiSession?.metadata?.agentSessionId
            const nativeMachineId = session.hapiSession?.metadata?.machineId ?? props.machineId
            const nativeAlias = nativeId && nativeMachineId
                ? { type: 'native-codex' as const, machineId: nativeMachineId, codexSessionId: nativeId }
                : undefined
            const source = session.source === 'hapi'
                ? { type: 'managed' as const, sessionId: session.id }
                : props.machineId
                    ? { type: 'native-codex' as const, machineId: props.machineId, codexSessionId: session.id }
                    : null
            if (!source) continue
            const group = resolveSessionGroup(sessionGroupsQuery.data, source, nativeAlias)
            if (group) assignments.set(session.key, group)
        }
        return assignments
    }, [mergedSessions, props.machineId, sessionGroupsQuery.data])
    const completedHapiSessionsForKanbanBootstrap = useMemo(
        () => mergedSessions
            .filter((session) => session.source === 'hapi' && getMergedCodexKanbanStatus(session) === 'completed')
            .map((session) => ({ id: session.id, updatedAt: getHapiSessionUpdatedAt(session) })),
        [mergedSessions]
    )
    const mergedDirectoryGroups = useMemo(
        () => groupMergedCodexSessionsByDirectory(mergedSessions),
        [mergedSessions]
    )
    const kanbanGroups = useMemo(
        () => groupMergedCodexSessionsForKanban(
            mergedSessions,
            pinnedSessionKeys,
            isCodexKanbanLastSeenInitialized
                ? sessionLastSeenState.lastSeenAtBySession
                : null,
            Date.now(),
            sessionGroupsByKey
        ),
        [isCodexKanbanLastSeenInitialized, mergedSessions, pinnedSessionKeys, relativeTimeNow, sessionLastSeenState.lastSeenAtBySession, sessionGroupsByKey]
    )
    const completedTimelineGroups = useMemo(() => {
        const completed = kanbanGroups.find((group) => group.id === 'completed')?.sessions ?? []
        return groupMergedCodexCompletedTimeline(completed, new Date(), dateLocale, {
            today: t('shares.timeline.today'),
            yesterday: t('shares.timeline.yesterday'),
            daysAgo: (days) => t('shares.timeline.daysAgo', { days })
        })
    }, [dateLocale, kanbanGroups, localDay, t])
    const orderedKanbanGroups = sortKanbanLanes(kanbanGroups, normalizeKanbanOrder(
        kanbanOrder.data?.order ?? [], sessionGroupsQuery.data?.groups.map(group => group.id) ?? [...sessionGroupsByKey.values()].map(group => group.id)
    ))
    const sortableLanes = orderedKanbanGroups.filter(group => group.id !== 'processing' && group.id !== 'completed' && (!group.customGroup || group.sessions.length > 0)).map(group => {
        const presentation = KANBAN_GROUP_PRESENTATION[group.customGroup ? 'completed' : group.id as BuiltInKanbanGroupId]
        const Icon = presentation.Icon
        return { id: group.id, label: group.customGroup?.name ?? t(presentation.labelKey), icon: group.customGroup ? <span>{group.customGroup.emoji}</span> : <Icon className="h-4 w-4" /> }
    })

    useEffect(() => {
        if (!isMerged || props.hapiIsLoading || isCodexKanbanLastSeenInitialized) {
            return
        }
        initializeCodexKanbanLastSeen(completedHapiSessionsForKanbanBootstrap, codexKanbanLastSeenScope)
    }, [codexKanbanLastSeenScope, completedHapiSessionsForKanbanBootstrap, isCodexKanbanLastSeenInitialized, isMerged, props.hapiIsLoading])

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
    // and make sure opening a selected SHAPI session never leaves it hidden.
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
            if (currentSourceRef.current.api !== props.api || currentSourceRef.current.machineId !== machineId) return false
            setSessionsOwner({ api: props.api, machineId })
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

    const handleOpenMergedSession = useCallback((session: MergedCodexSession) => {
        if (session.source === 'hapi') {
            if (!session.hapiSession) return
            markSessionSeen(session.id, getHapiSessionUpdatedAt(session))
            props.onOpenHapi?.(session.hapiSession)
            return
        }
        if (session.nativeSession) {
            props.onOpen(session.nativeSession)
        }
    }, [props.onOpen, props.onOpenHapi])

    // Current runners patch this list through SSE. Older runners, or a
    // temporarily disconnected event stream, retain a small polling fallback.
    useEffect(() => {
        if (!props.machineId || (hasRealtimeUpdates && !hasSshControlledSession)) {
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
    }, [hasRealtimeUpdates, hasSshControlledSession, props.machineId, refresh])

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
                ? 'cupertino-session-list app-scroll-y flex min-h-0 w-full flex-1 flex-col px-4 pb-3 pt-1 sm:px-6 [font-family:var(--app-control-font-family)]'
                : 'cupertino-session-list flex min-h-0 w-full flex-1 flex-col px-4 pb-4 pt-3 sm:px-6 [font-family:var(--app-control-font-family)]'}
            aria-label={title}
            aria-busy={busy || undefined}
            data-testid="recent-codex-sessions"
            data-session-list-presentation={isCupertinoPresentation ? 'cupertino' : undefined}
            data-session-list-view={isCupertinoPresentation ? (props.viewMode ?? 'list') : undefined}
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

            {sessionPins.error ? <div className="px-3 py-2 text-sm text-red-600" role="alert">{sessionPins.error.message}</div> : null}
            {loadError ? (
                <div className={isDefaultNamespaceUnavailable
                    ? 'cupertino-session-callout mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-xs text-[var(--app-hint)]'
                    : 'cupertino-session-callout mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-xs text-red-600'} role="status" data-session-callout-tone={isDefaultNamespaceUnavailable ? 'warning' : 'error'}>
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
                <div className="cupertino-session-state mt-3 px-2 text-sm text-[var(--app-hint)]">{t('loading')}</div>
            ) : !props.machineId ? (
                <div className="cupertino-session-state mt-3 px-2 py-2 text-xs leading-5 text-[var(--app-hint)]">
                    {t('recentCodex.runnerRequired')}
                </div>
            ) : loadError && !hasRows ? null : !hasRows ? (
                <div className="cupertino-session-state mt-3 px-2 py-2 text-xs leading-5 text-[var(--app-hint)]">
                    {props.emptyMessage ?? t('recentCodex.empty')}
                </div>
            ) : isMerged && props.viewMode === 'kanban' ? (
                <div
                    className={embedded
                        ? 'cupertino-session-board mt-1 flex min-h-0 flex-col gap-4 pb-3'
                        : 'mt-4 flex min-h-0 flex-col gap-4 overflow-y-auto pb-3 pr-1'}
                    data-testid="session-kanban-board"
                >
                    {orderedKanbanGroups
                        .filter((group) => group.id !== 'completed' && group.sessions.length > 0)
                        .map((group) => {
                        const presentation = KANBAN_GROUP_PRESENTATION[group.customGroup ? 'completed' : group.id as BuiltInKanbanGroupId]
                        const GroupIcon = presentation.Icon
                        const collapsible = group.id !== 'processing' && group.id !== 'pending'
                        const collapsed = collapsible && collapsedSessionGroups.has(group.id)
                        return (
                            <section key={group.id} className="min-w-0" data-kanban-group={group.id}>
                                <div className="cupertino-kanban-heading flex items-center gap-2 px-1">
                                    {!group.customGroup && group.id !== 'processing' ? (
                                        <GroupIcon
                                            className={`h-3.5 w-3.5 shrink-0 ${presentation.iconClassName}`}
                                            {...(group.id === 'pinned' ? { fill: 'currentColor' } : {})}
                                            aria-hidden="true"
                                            data-kanban-group-icon={group.id}
                                        />
                                    ) : null}
                                    <h2 className={KANBAN_HEADING_CLASS_NAME}>
                                        {collapsible ? (
                                            <button
                                                type="button"
                                                className="flex min-h-11 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                                aria-expanded={!collapsed}
                                                onClick={() => toggleKanbanSection(group.id)}
                                            >
                                                {group.customGroup ? <span aria-hidden="true">{group.customGroup.emoji}</span> : null}
                                                <span>{group.customGroup?.name ?? t(presentation.labelKey)}</span>
                                                {collapsed ? <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                                            </button>
                                        ) : group.id === 'processing' ? (
                                            <SessionThinkingIndicator compact showElapsed={false} />
                                        ) : t(presentation.labelKey)}
                                    </h2>
                                </div>
                                {!collapsed ? <ul className="cupertino-kanban-card-column mt-1 flex flex-col gap-2.5" data-kanban-card-column>
                                    {group.sessions.map((session) => (
                                        <KanbanSessionCard
                                            key={session.key}
                                            api={props.api}
                                            machineId={props.machineId}
                                            session={session}
                                            selected={session.source === 'hapi' && session.id === props.selectedSessionId}
                                            pinned={pinnedSessionKeys?.has(session.key) ?? false}
                                            dateLocale={dateLocale}
                                            now={relativeTimeNow}
                                            directoryColor={getAssignedCompletedSessionDirectoryColor(completedDirectoryColors, session.cwd)}
                                            sessionGroup={sessionGroupsByKey.get(session.key)}
                                            t={t}
                                            onTogglePin={onTogglePin ? () => onTogglePin(session.key) : undefined}
                                            onArchived={handleArchived}
                                            onOpen={() => handleOpenMergedSession(session)}
                                        />
                                    ))}
                                </ul> : null}
                            </section>
                        )
                    })}
                    {completedTimelineGroups.length > 0 ? (
                        <section className="min-w-0" data-kanban-group="completed">
                            <div className="cupertino-kanban-date-groups" data-kanban-card-column>
                                <div className="space-y-4">
                                    {completedTimelineGroups.map((group) => (
                                        <section key={group.key} data-kanban-date-group={group.key}>
                                            <h3 className={`cupertino-kanban-date-heading flex min-h-6 items-center gap-2 px-1 ${KANBAN_HEADING_CLASS_NAME}`}>
                                                <button type="button" className="flex min-h-11 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" aria-expanded={!collapsedSessionGroups.has(`date:${group.key}`)} onClick={() => toggleKanbanSection(`date:${group.key}`)}>
                                                <span aria-hidden="true" className="shrink-0 font-normal" data-kanban-date-emoji>{getKanbanDateEmoji(group.key)}</span>
                                                <span>{group.label}</span>
                                                {collapsedSessionGroups.has(`date:${group.key}`) ? <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                                                </button>
                                            </h3>
                                            {!collapsedSessionGroups.has(`date:${group.key}`) ? <ul className="cupertino-kanban-card-column mt-1 flex flex-col gap-2.5">
                                                {group.shares.map((session) => (
                                                    <KanbanSessionCard
                                                        key={session.key}
                                                        api={props.api}
                                                        machineId={props.machineId}
                                                        session={session}
                                                        selected={session.source === 'hapi' && session.id === props.selectedSessionId}
                                                        pinned={pinnedSessionKeys?.has(session.key) ?? false}
                                                        dateLocale={dateLocale}
                                                        now={relativeTimeNow}
                                                        directoryColor={getAssignedCompletedSessionDirectoryColor(completedDirectoryColors, session.cwd)}
                                                        sessionGroup={sessionGroupsByKey.get(session.key)}
                                                        t={t}
                                                        onTogglePin={onTogglePin ? () => onTogglePin(session.key) : undefined}
                                                        onArchived={handleArchived}
                                                        onOpen={() => handleOpenMergedSession(session)}
                                                    />
                                                ))}
                                            </ul> : null}
                                        </section>
                                    ))}
                                </div>
                            </div>
                        </section>
                    ) : null}
                    <button type="button" className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl text-sm text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" onClick={() => setOrderDrawerOpen(true)}>
                        <ArrowDownUp className="h-4 w-4" aria-hidden="true" />{t('kanbanOrder.title')}
                    </button>
                    {orderDrawerOpen ? <KanbanOrderDrawer key={kanbanOrderQueryKey(props.api).join(':')} lanes={sortableLanes} revision={kanbanOrder.data?.revision ?? 0} ready={Boolean(kanbanOrder.data) && !kanbanOrder.isError} saving={kanbanOrder.saving} onSave={kanbanOrder.save} onRetry={() => { void kanbanOrder.refetch() }} onClose={() => setOrderDrawerOpen(false)} /> : null}
                </div>
            ) : isMerged ? (
                <div className={embedded
                    ? 'cupertino-session-groups mt-1 flex shrink-0 flex-col gap-1'
                    : 'cupertino-session-groups mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1'}>
                    {mergedDirectoryGroups.map((group) => {
                        const directoryLabel = group.directory
                            ? getDirectoryDisplayName(group.directory)
                            : t('recentCodex.noDirectory')
                        const directoryKey = getDirectoryKey(group.directory)
                        const collapsed = collapsedDirectories.has(directoryKey)
                        return (
                            <section key={directoryKey} className="cupertino-session-directory-group min-w-0 shrink-0 py-1" data-directory={directoryKey} data-directory-collapsed={collapsed || undefined}>
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
                                            <ul className="cupertino-session-group-list relative mt-1 ml-5 flex flex-col border-l border-[var(--app-divider)] py-1 pl-3.5">
                                                {group.sessions.map((session) => (
                                                    <MergedCodexSessionRow
                                                        key={session.key}
                                                        session={session}
                                                        selected={session.source === 'hapi' && session.id === props.selectedSessionId}
                                                        t={t}
                                                    onOpen={() => handleOpenMergedSession(session)}
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
                    ? 'cupertino-session-groups mt-3 flex shrink-0 flex-col gap-1'
                    : 'cupertino-session-groups mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1'}>
                    {directoryGroups.map((group) => {
                        const directoryLabel = group.directory
                            ? getDirectoryDisplayName(group.directory)
                            : t('recentCodex.noDirectory')
                        const directoryKey = getDirectoryKey(group.directory)
                        const collapsed = collapsedDirectories.has(directoryKey)
                        return (
                            <section key={directoryKey} className="cupertino-session-directory-group min-w-0 shrink-0 py-1" data-directory={directoryKey} data-directory-collapsed={collapsed || undefined}>
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
                                            <ul className="cupertino-session-group-list relative mt-1 ml-5 flex flex-col border-l border-[var(--app-divider)] py-1 pl-3.5">
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
                                                                    <CodexSourceIcon
                                                                        source="native"
                                                                        active={session.runState === 'processing'}
                                                                        sshControlled={session.controlledByCodexSsh === true}
                                                                    />
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
