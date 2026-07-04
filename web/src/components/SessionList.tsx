import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { CopyIcon, CheckIcon, ScheduleIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { DEFAULT_SESSION_PREVIEW_LIMIT, useSessionPreviewLimit } from '@/hooks/useSessionPreviewLimit'
import { AgentFlavorStatusIcon } from '@/components/AgentFlavorIcon'
import { useSessionListStatusMode } from '@/hooks/useSessionListStatusMode'
import { useShowActiveSessionsOnly } from '@/hooks/useShowActiveSessionsOnly'
import { classifySessionAttention } from '@/lib/sessionAttention'
import { getSessionLastSeenAt } from '@/lib/sessionLastSeen'
import { getAttentionLabel, SessionAttentionIndicator } from '@/components/SessionAttentionIndicator'
import { HoverTooltip, SESSION_ROW_TOOLTIP_FOCUS_CLASS, useSessionRowTooltipIds } from '@/components/HoverTooltip'
import { formatScheduledTooltipDetail } from '@/lib/scheduledTime'
import { formatReopenError } from '@/lib/reopenError'

type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineId: string | null
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

function SessionsEmptyState(props: {
    onNewSession: () => void
    onBrowse?: () => void
}) {
    const { t } = useTranslation()
    return (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="44"
                height="44"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-[var(--app-hint)] opacity-60"
            >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M3 9h18" />
                <path d="M8 14h8" />
                <path d="M8 17h5" />
            </svg>
            <div className="text-base font-medium text-[var(--app-fg)]">
                {t('sessions.empty.title')}
            </div>
            <div className="max-w-sm text-sm text-[var(--app-hint)]">
                {t('sessions.empty.hint')}
            </div>
            <div className="flex items-center gap-2 mt-2">
                <button
                    type="button"
                    onClick={props.onNewSession}
                    className="px-4 py-1.5 text-sm rounded-lg bg-[var(--app-button)] text-[var(--app-button-text)] font-medium hover:opacity-90 transition-opacity"
                >
                    {t('sessions.empty.startSession')}
                </button>
                {props.onBrowse && (
                    <button
                        type="button"
                        onClick={props.onBrowse}
                        className="px-4 py-1.5 text-sm rounded-lg border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    >
                        {t('sessions.empty.browse')}
                    </button>
                )}
            </div>
        </div>
    )
}

type MachineGroup = {
    machineId: string | null
    label: string
    projectGroups: SessionGroup[]
    totalSessions: number
    hasActiveSession: boolean
    latestUpdatedAt: number
}

export function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    return parts[parts.length - 1]
}

export const UNKNOWN_MACHINE_ID = '__unknown__'
export const GROUP_SESSION_PREVIEW_LIMIT = DEFAULT_SESSION_PREVIEW_LIMIT

export function getSessionWorkspaceDirectory(session: SessionSummary): string | null {
    const worktreeBasePath = session.metadata?.worktree?.basePath?.trim()
    if (worktreeBasePath) return worktreeBasePath

    const path = session.metadata?.path?.trim()
    return path || null
}

export function getSessionWorkspaceTitle(
    sessions: SessionSummary[],
    selectedSessionId?: string | null,
    fallback = 'Workspace'
): string {
    const selectedSession = selectedSessionId
        ? sessions.find(session => session.id === selectedSessionId)
        : null
    const selectedDirectory = selectedSession ? getSessionWorkspaceDirectory(selectedSession) : null
    if (selectedDirectory) return getGroupDisplayName(selectedDirectory)

    const rankedSessions = [...sessions].sort((a, b) => {
        const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
        const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
        if (rankA !== rankB) return rankA - rankB
        return b.updatedAt - a.updatedAt
    })
    const workspaceSession = rankedSessions.find(session => getSessionWorkspaceDirectory(session))
    const directory = workspaceSession ? getSessionWorkspaceDirectory(workspaceSession) : null
    return directory ? getGroupDisplayName(directory) : fallback
}

export function getSessionDedupKey(session: SessionSummary): string | null {
    const agentId = session.metadata?.agentSessionId?.trim()
    if (!agentId) return null
    // Scope by flavor: agentSessionId is flattened from native ids and can retain a
    // stale cross-flavor value (codexSessionId ?? claudeSessionId ?? ...).
    return `${session.metadata?.flavor ?? 'unknown'}:${agentId}`
}

export function deduplicateSessionsByAgentId(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    const byAgentId = new Map<string, SessionSummary[]>()
    const result: SessionSummary[] = []

    for (const session of sessions) {
        const dedupKey = getSessionDedupKey(session)
        if (!dedupKey) {
            result.push(session)
            continue
        }
        const group = byAgentId.get(dedupKey)
        if (group) {
            group.push(session)
        } else {
            byAgentId.set(dedupKey, [session])
        }
    }

    for (const group of byAgentId.values()) {
        group.sort((a, b) => {
            // Active session always wins — it's the live connection
            if (a.active !== b.active) return a.active ? -1 : 1
            // Among inactive duplicates, keep the selected one visible
            if (a.id === selectedSessionId) return -1
            if (b.id === selectedSessionId) return 1
            return b.updatedAt - a.updatedAt
        })
        result.push(group[0])
    }

    return result
}

function hasSidebarTitleSignal(session: SessionSummary): boolean {
    const meta = session.metadata
    if (!meta) return false
    if (meta.name?.trim()) return true
    if (meta.summary?.text?.trim()) return true
    return false
}

export function isSidebarEmptySessionStub(session: SessionSummary): boolean {
    if (session.active) return false
    const meta = session.metadata
    if (!meta) return true
    if (meta.agentSessionId?.trim()) return false
    if (hasSidebarTitleSignal(session)) return false
    return true
}

export function shouldShowSessionInSidebar(session: SessionSummary, selectedSessionId?: string | null): boolean {
    if (session.id === selectedSessionId) return true
    if (session.active) return true
    return !isSidebarEmptySessionStub(session)
}

export function prepareSidebarSessions(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return deduplicateSessionsByAgentId(sessions, selectedSessionId)
        .filter(session => shouldShowSessionInSidebar(session, selectedSessionId))
}

// "Active sessions only" view: hide inactive sessions, but never hide the one the
// operator currently has open — otherwise toggling the filter would yank the
// selected session out from under them.
export function filterActiveSessionsOnly(sessions: SessionSummary[], selectedSessionId?: string | null): SessionSummary[] {
    return sessions.filter(session => session.active || session.id === selectedSessionId)
}

// Paginated "Show N more": reveal one batch (step) at a time instead of expanding
// every hidden session at once. Always advances by at least one and never exceeds
// the total so the button reliably reaches a fully-expanded state.
export function getNextSessionVisibleCount(current: number, step: number, total: number): number {
    return Math.min(current + Math.max(1, step), total)
}

function groupSessionsByDirectory(sessions: SessionSummary[]): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineId: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const path = getSessionWorkspaceDirectory(session) ?? 'Other'
        const machineId = session.metadata?.machineId ?? null
        const key = `${machineId ?? UNKNOWN_MACHINE_ID}::${path}`
        if (!groups.has(key)) {
            groups.set(key, {
                directory: path,
                machineId,
                sessions: []
            })
        }
        groups.get(key)!.sessions.push(session)
    })

    return Array.from(groups.entries())
        .map(([key, group]) => {
            const sortedSessions = [...group.sessions].sort((a, b) => {
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const displayName = getGroupDisplayName(group.directory)

            return {
                key,
                directory: group.directory,
                displayName,
                machineId: group.machineId,
                sessions: sortedSessions,
                latestUpdatedAt,
                hasActiveSession
            }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
}


export function expandSelectedSessionCollapseOverrides(
    overrides: Map<string, boolean>,
    group: { key: string; machineId: string | null }
): Map<string, boolean> {
    const next = new Map(overrides)
    let changed = false

    // Expand project group if collapsed. Project and machine keys use true = collapsed.
    if (overrides.has(group.key) && overrides.get(group.key)) {
        next.delete(group.key)
        changed = true
    }

    const machineKey = `machine::${group.machineId ?? UNKNOWN_MACHINE_ID}`
    if (overrides.has(machineKey) && overrides.get(machineKey)) {
        next.delete(machineKey)
        changed = true
    }

    return changed ? next : overrides
}

function groupByMachine(
    groups: SessionGroup[],
    resolveMachineLabel: (id: string | null) => string
): MachineGroup[] {
    const map = new Map<string, MachineGroup>()
    for (const g of groups) {
        const key = g.machineId ?? UNKNOWN_MACHINE_ID
        let mg = map.get(key)
        if (!mg) {
            mg = {
                machineId: g.machineId,
                label: resolveMachineLabel(g.machineId),
                projectGroups: [],
                totalSessions: 0,
                hasActiveSession: false,
                latestUpdatedAt: 0,
            }
            map.set(key, mg)
        }
        mg.projectGroups.push(g)
        mg.totalSessions += g.sessions.length
        if (g.hasActiveSession) mg.hasActiveSession = true
        if (g.latestUpdatedAt > mg.latestUpdatedAt) mg.latestUpdatedAt = g.latestUpdatedAt
    }
    return [...map.values()].sort((a, b) => {
        if (a.hasActiveSession !== b.hasActiveSession) return a.hasActiveSession ? -1 : 1
        return b.latestUpdatedAt - a.latestUpdatedAt
    })
}

function CopyPathButton({ path, className }: { path: string; className?: string }) {
    const [copied, setCopied] = useState(false)
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        navigator.clipboard.writeText(path)
        setCopied(true)
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
    }

    useEffect(() => () => clearTimeout(timerRef.current), [])

    return (
        <button
            type="button"
            className={`shrink-0 p-0.5 rounded transition-colors ${copied ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'} ${className ?? ''}`}
            title={copied ? 'Copied!' : `Copy: ${path}`}
            onClick={handleClick}
        >
            {copied
                ? <CheckIcon className="h-3.5 w-3.5" />
                : <CopyIcon className="h-3.5 w-3.5" />
            }
        </button>
    )
}


function PlusIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function FolderIcon(props: { className?: string; open?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            {props.open ? (
                <path d="M6 14l1.5-4A2 2 0 0 1 9.37 8.7H20a2 2 0 0 1 1.9 2.63l-1.5 4A2 2 0 0 1 18.53 17H5a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2h4l2 2h4a2 2 0 0 1 2 2v1.2" />
            ) : (
                <path d="M3.5 7.5a2.5 2.5 0 0 1 2.5-2.5h3.3l2.1 2.2H18a2.5 2.5 0 0 1 2.5 2.5v6.8A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5Z" />
            )}
        </svg>
    )
}

function ComposeIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
        </svg>
    )
}

function LoaderIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <line x1="12" y1="2" x2="12" y2="6" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
            <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="6" y2="12" />
            <line x1="18" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
            <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
        </svg>
    )
}

function BulbIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.2 1 2h6c0-.8.4-1.4 1-2a7 7 0 0 0-4-12Z" />
        </svg>
    )
}

function ChevronIcon(props: { className?: string; collapsed?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${props.className ?? ''} transition-transform duration-200 ${props.collapsed ? '-rotate-90' : ''}`}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

export function getSessionTitle(session: SessionSummary): string {
    if (session.metadata?.name) {
        return session.metadata.name
    }
    if (session.metadata?.summary?.text) {
        return session.metadata.summary.text
    }
    if (session.metadata?.path) {
        const parts = session.metadata.path.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : session.id.slice(0, 8)
    }
    return session.id.slice(0, 8)
}

function getTodoProgress(session: SessionSummary): { completed: number; total: number } | null {
    if (!session.todoProgress) return null
    if (session.todoProgress.completed === session.todoProgress.total) return null
    return session.todoProgress
}

export function normalizeSearch(value: string | null | undefined): string {
    return (value ?? '').trim().toLowerCase()
}

export function sessionMatchesQuery(session: SessionSummary, query: string, machineLabel: string): boolean {
    if (!query) return true
    const searchable = [
        getSessionTitle(session),
        session.id,
        session.metadata?.path,
        session.metadata?.worktree?.basePath,
        session.metadata?.name,
        session.metadata?.summary?.text,
        session.metadata?.flavor,
        machineLabel,
    ]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n')
        .toLowerCase()
    return searchable.includes(query)
}


export function getVisibleSessionPreview(
    sessions: SessionSummary[],
    options: {
        expanded?: boolean
        selectedSessionId?: string | null
        limit?: number
    } = {}
): SessionSummary[] {
    const limit = options.limit ?? GROUP_SESSION_PREVIEW_LIMIT
    if (options.expanded || sessions.length <= limit) return sessions

    const requiredIds = new Set<string>()
    for (const session of sessions) {
        if (session.pendingRequestsCount > 0) requiredIds.add(session.id)
    }
    if (options.selectedSessionId && sessions.some(session => session.id === options.selectedSessionId)) {
        requiredIds.add(options.selectedSessionId)
    }

    const visible: SessionSummary[] = sessions.filter((session, index) => {
        return index < limit || requiredIds.has(session.id)
    })

    for (let index = visible.length - 1; visible.length > limit && index >= 0; index -= 1) {
        const session = visible[index]
        if (!session || requiredIds.has(session.id)) continue
        visible.splice(index, 1)
    }

    return visible
}

function SessionItem(props: {
    session: SessionSummary
    onSelect: (sessionId: string) => void
    showPath?: boolean
    api: ApiClient | null
    selected?: boolean
    showDetailedStatus?: boolean
}) {
    const { t } = useTranslation()
    const { session: s, onSelect, showPath = true, api, selected = false, showDetailedStatus = false } = props
    const { haptic } = usePlatform()
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const [renameOpen, setRenameOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, reopenSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        s.id,
        s.metadata?.flavor ?? null
    )
    const [reopenError, setReopenError] = useState<string | null>(null)

    const handleReopen = async () => {
        setReopenError(null)
        try {
            const result = await reopenSession()
            // resumeSession may merge the row into a freshly-spawned sessionId.
            // Follow it so the operator lands on the live session.
            if (result.sessionId && result.sessionId !== s.id) {
                onSelect(result.sessionId)
            }
        } catch (error) {
            setReopenError(formatReopenError(error))
        }
    }

    const longPressHandlers = useLongPress({
        onLongPress: (point) => {
            haptic.impact('medium')
            setMenuAnchorPoint(point)
            setMenuOpen(true)
        },
        onClick: () => {
            if (!menuOpen) {
                onSelect(s.id)
            }
        },
        threshold: 500
    })

    const sessionName = getSessionTitle(s)
    const todoProgress = getTodoProgress(s)
    const attention = useMemo(
        () => showDetailedStatus
            ? classifySessionAttention(s, {
                selected,
                lastSeenAt: getSessionLastSeenAt(s.id)
            })
            : null,
        [s, selected, showDetailedStatus]
    )
    const attentionLabel = attention ? getAttentionLabel(attention, t) : null
    const scheduledLabel = s.futureScheduledMessageCount > 1
        ? t('session.item.scheduledMessages', { count: s.futureScheduledMessageCount })
        : t('session.item.scheduledMessage')
    const hasScheduleTooltip = showDetailedStatus && s.futureScheduledMessageCount > 0
    const { attentionId, scheduleId, describedBy } = useSessionRowTooltipIds(
        Boolean(attention),
        hasScheduleTooltip
    )
    return (
        <>
            <button
                type="button"
                {...longPressHandlers}
                className={`session-list-item group/session-row flex w-full items-center justify-between gap-3 rounded-xl px-0 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none ${selected ? 'text-[var(--app-fg)]' : ''}`}
                style={{ WebkitTouchCallout: 'none' }}
                aria-current={selected ? 'page' : undefined}
                aria-describedby={describedBy}
            >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <AgentFlavorStatusIcon
                        flavor={s.metadata?.flavor}
                        className="h-[18px] w-[18px]"
                        showStatus={s.active}
                        statusClassName="bg-[#34C759]"
                    />
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-normal leading-[18px] tracking-normal text-[var(--app-fg)]">
                            {sessionName}
                        </div>
                        {showPath ? (
                            <div className="mt-0.5 truncate text-xs leading-4 text-[var(--app-hint)]">
                                {s.metadata?.path ?? s.id}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="flex h-6 shrink-0 items-center justify-end gap-2 text-[var(--app-hint)]">
                    {s.active && s.thinking ? (
                        <LoaderIcon className="h-6 w-6 animate-spin-slow text-[var(--app-fg)]" />
                    ) : attention ? (
                        <SessionAttentionIndicator
                            attention={attention}
                            summary={s}
                            label={attentionLabel ?? ''}
                            tooltipId={attentionId!}
                        />
                    ) : todoProgress ? (
                        <span className="flex items-center gap-1 text-xs text-[var(--app-hint)]">
                            <BulbIcon className="h-3 w-3" />
                            {todoProgress.completed}/{todoProgress.total}
                        </span>
                    ) : null}
                    {hasScheduleTooltip ? (
                        <HoverTooltip
                            id={scheduleId!}
                            target={<ScheduleIcon className="h-4 w-4 text-[var(--app-hint)]" />}
                            side="bottom"
                            align="start"
                            className="shrink-0"
                            revealOnParentFocusClass={SESSION_ROW_TOOLTIP_FOCUS_CLASS}
                        >
                            <span className="block">
                                <span className="block font-medium">{scheduledLabel}</span>
                                <span className="mt-1 block text-[var(--app-hint)]">
                                    {formatScheduledTooltipDetail(s, t)}
                                </span>
                            </span>
                        </HoverTooltip>
                    ) : null}
                    {!attention && s.pendingRequestsCount > 0 ? (
                        <span className="rounded-full bg-[var(--app-badge-warning-bg)] px-2 py-0.5 text-xs text-[var(--app-badge-warning-text)]">
                            {s.pendingRequestsCount}
                        </span>
                    ) : null}
                </div>
            </button>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={s.active}
                onRename={() => setRenameOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onReopen={handleReopen}
                onDelete={() => setDeleteOpen(true)}
                anchorPoint={menuAnchorPoint}
            />

            {reopenError ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setReopenError(null)}
                    title={t('dialog.reopen.errorTitle')}
                    description={reopenError}
                    confirmLabel={t('dialog.reopen.dismiss')}
                    confirmingLabel={t('dialog.reopen.dismiss')}
                    onConfirm={async () => setReopenError(null)}
                    isPending={false}
                />
            ) : null}

            <RenameSessionDialog
                isOpen={renameOpen}
                onClose={() => setRenameOpen(false)}
                currentName={sessionName}
                onRename={renameSession}
                isPending={isPending}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: sessionName })}
                confirmLabel={t('dialog.archive.confirm')}
                confirmingLabel={t('dialog.archive.confirming')}
                onConfirm={archiveSession}
                isPending={isPending}
                destructive
            />

            <ConfirmDialog
                isOpen={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={t('dialog.delete.title')}
                description={t('dialog.delete.description', { name: sessionName })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={deleteSession}
                isPending={isPending}
                destructive
            />
        </>
    )
}

export function SessionList(props: {
    sessions: SessionSummary[]
    onSelect: (sessionId: string) => void
    onNewSession: () => void
    onNewSessionInDirectory?: (args: { machineId: string | null; directory: string }) => void
    onBrowse?: () => void
    onRefresh: () => void
    isLoading: boolean
    renderHeader?: boolean
    api: ApiClient | null
    machineLabelsById?: Record<string, string>
    selectedSessionId?: string | null
}) {
    const { t } = useTranslation()
    const { renderHeader = true, api, selectedSessionId, machineLabelsById = {}, onNewSessionInDirectory } = props
    const { sessionPreviewLimit } = useSessionPreviewLimit()
    const { sessionListStatusMode } = useSessionListStatusMode()
    const { showActiveSessionsOnly } = useShowActiveSessionsOnly()
    const showDetailedStatus = sessionListStatusMode === 'detailed'

    const resolveMachineLabel = (machineId: string | null): string => {
        if (machineId && machineLabelsById[machineId]) {
            return machineLabelsById[machineId]
        }
        if (machineId) {
            return machineId.slice(0, 8)
        }
        return t('machine.unknown')
    }

    const allSessions = useMemo(
        () => {
            const prepared = prepareSidebarSessions(props.sessions, selectedSessionId)
            return showActiveSessionsOnly ? filterActiveSessionsOnly(prepared, selectedSessionId) : prepared
        },
        [props.sessions, selectedSessionId, showActiveSessionsOnly]
    )
    const allGroups = useMemo(
        () => groupSessionsByDirectory(allSessions),
        [allSessions]
    )
    const [collapseOverrides, setCollapseOverrides] = useState<Map<string, boolean>>(
        () => new Map()
    )
    const autoExpandedSelectedSessionKeyRef = useRef<string | null>(null)
    const isGroupCollapsed = (group: SessionGroup): boolean => {
        const override = collapseOverrides.get(group.key)
        if (override !== undefined) return override
        const hasSelectedSession = selectedSessionId
            ? group.sessions.some(session => session.id === selectedSessionId)
            : false
        return !group.hasActiveSession && !hasSelectedSession
    }

    const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(groupKey, !isCollapsed)
            return next
        })
    }

    // Per-group reveal cap for paginated "Show N more". Absent = collapsed to the
    // preview limit; each "Show more" bumps it by one batch (step = preview limit).
    const [sessionVisibleCounts, setSessionVisibleCounts] = useState<Map<string, number>>(
        () => new Map()
    )

    const getGroupVisibleCount = (group: SessionGroup): number => {
        return sessionVisibleCounts.get(group.key) ?? sessionPreviewLimit
    }

    const showMoreSessions = (group: SessionGroup) => {
        setSessionVisibleCounts(prev => {
            const next = new Map(prev)
            const current = prev.get(group.key) ?? sessionPreviewLimit
            next.set(group.key, getNextSessionVisibleCount(current, sessionPreviewLimit, group.sessions.length))
            return next
        })
    }

    const collapseSessionGroup = (group: SessionGroup) => {
        setSessionVisibleCounts(prev => {
            if (!prev.has(group.key)) return prev
            const next = new Map(prev)
            next.delete(group.key)
            return next
        })
    }

    const getVisibleGroupSessions = (group: SessionGroup): SessionSummary[] => {
        return getVisibleSessionPreview(
            group.sessions,
            {
                selectedSessionId,
                limit: getGroupVisibleCount(group)
            }
        )
    }

    const machineGroups = useMemo(
        () => groupByMachine(allGroups, resolveMachineLabel),
        [allGroups, machineLabelsById] // eslint-disable-line react-hooks/exhaustive-deps
    )

    const isMachineCollapsed = (mg: MachineGroup): boolean => {
        const key = `machine::${mg.machineId ?? UNKNOWN_MACHINE_ID}`
        const override = collapseOverrides.get(key)
        if (override !== undefined) return override
        const hasSelected = selectedSessionId
            ? mg.projectGroups.some(pg => pg.sessions.some(s => s.id === selectedSessionId))
            : false
        return !mg.hasActiveSession && !hasSelected
    }

    const toggleMachine = (mg: MachineGroup) => {
        const key = `machine::${mg.machineId ?? UNKNOWN_MACHINE_ID}`
        const current = isMachineCollapsed(mg)
        setCollapseOverrides(prev => {
            const next = new Map(prev)
            next.set(key, !current)
            return next
        })
    }

    // Auto-expand group (and machine) containing the selected session only when
    // the selected-session/group pair changes. Without this guard, every live
    // session-list refresh (for example tool-call updates from a running selected
    // session) reopens a path the user just collapsed.
    useEffect(() => {
        if (!selectedSessionId) {
            autoExpandedSelectedSessionKeyRef.current = null
            return
        }

        const group = allGroups.find(g =>
            g.sessions.some(s => s.id === selectedSessionId)
        )
        if (!group) return

        const autoExpandKey = `${selectedSessionId}::${group.key}`
        if (autoExpandedSelectedSessionKeyRef.current === autoExpandKey) return
        autoExpandedSelectedSessionKeyRef.current = autoExpandKey

        setCollapseOverrides(prev => expandSelectedSessionCollapseOverrides(prev, group))
    }, [selectedSessionId, allGroups])

    // Clean up stale collapse overrides
    useEffect(() => {
        setCollapseOverrides(prev => {
            if (prev.size === 0) return prev
            const next = new Map(prev)
            const knownKeys = new Set<string>()
            for (const g of allGroups) {
                knownKeys.add(g.key)
                knownKeys.add(`sessions::${g.key}`)
                knownKeys.add(`machine::${g.machineId ?? UNKNOWN_MACHINE_ID}`)
            }
            let changed = false
            for (const key of next.keys()) {
                if (!knownKeys.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [allGroups])

    // Clean up reveal caps for groups that no longer exist.
    useEffect(() => {
        setSessionVisibleCounts(prev => {
            if (prev.size === 0) return prev
            const knownKeys = new Set(allGroups.map(g => g.key))
            const next = new Map(prev)
            let changed = false
            for (const key of next.keys()) {
                if (!knownKeys.has(key)) {
                    next.delete(key)
                    changed = true
                }
            }
            return changed ? next : prev
        })
    }, [allGroups])

    return (
        <div className="mx-auto flex h-full min-h-0 w-full max-w-[620px] flex-1 flex-col">
            {renderHeader ? (
                <div className="flex items-center justify-between px-8 pb-2 pt-1">
                    <div className="text-sm text-[var(--app-hint)]">
                        {t('sessions.count', { n: allSessions.length, m: allGroups.length })}
                    </div>
                    <button
                        type="button"
                        onClick={props.onNewSession}
                        className="session-list-new-button p-1.5 rounded-full text-[var(--app-link)] transition-colors"
                        title={t('sessions.new')}
                    >
                        <PlusIcon className="h-5 w-5" />
                    </button>
                </div>
            ) : null}

            {props.sessions.length === 0 && (
                <SessionsEmptyState
                    onNewSession={props.onNewSession}
                    onBrowse={props.onBrowse}
                />
            )}

            <div className="app-scroll-y desktop-scrollbar-left flex min-h-0 flex-1 flex-col px-8 pb-6 pt-2">
                {machineGroups.map((mg) => {
                    const machineCollapsed = isMachineCollapsed(mg)
                    const showMachineHeading = machineGroups.length > 1
                    return (
                        <div key={mg.machineId ?? UNKNOWN_MACHINE_ID} className="flex flex-col">
                            {showMachineHeading ? (
                                <button
                                    type="button"
                                    onClick={() => toggleMachine(mg)}
                                    className="mb-3 flex items-center gap-2 rounded-xl py-1 text-left text-sm font-medium text-[var(--app-hint)]"
                                >
                                    <span className="h-2 w-2 rounded-full bg-[#34C759]" aria-hidden="true" />
                                    <span>{mg.label}</span>
                                    <ChevronIcon className="h-3.5 w-3.5" collapsed={machineCollapsed} />
                                </button>
                            ) : null}

                            <div className="collapsible-panel" data-open={!machineCollapsed || undefined}>
                                <div className="collapsible-inner">
                                <div className="flex flex-col gap-6">
                                    {mg.projectGroups.map((group) => {
                                        const isCollapsed = isGroupCollapsed(group)
                                        const visibleGroupSessions = getVisibleGroupSessions(group)
                                        const hiddenSessionCount = group.sessions.length - visibleGroupSessions.length
                                        const canCollapseSessions = getGroupVisibleCount(group) > sessionPreviewLimit
                                        const showMoreCount = Math.min(sessionPreviewLimit, hiddenSessionCount)
                                        const canStartInGroupDirectory = group.directory !== 'Other'
                                        return (
                                            <section key={group.key} className="min-w-0">
                                                <div
                                                    className="group/project flex min-w-0 cursor-pointer select-none items-center gap-3 rounded-2xl py-1 text-left transition-colors"
                                                    onClick={() => toggleGroup(group.key, isCollapsed)}
                                                    title={group.directory}
                                                >
                                                    <FolderIcon open={!isCollapsed} className="h-8 w-8 shrink-0 text-[var(--app-fg)]" />
                                                    <span className="min-w-0 max-w-[min(18rem,calc(100%-8rem))] truncate text-[20px] font-semibold leading-7 text-[var(--app-fg)]">
                                                        {group.displayName}
                                                    </span>
                                                    <ChevronIcon className="h-4 w-4 shrink-0 text-[#8e8e93]" collapsed={isCollapsed} />
                                                    <span className="flex-1" aria-hidden="true" />
                                                    <CopyPathButton path={group.directory} className="hidden opacity-0 transition-opacity duration-150 group-hover/project:opacity-100 sm:flex" />
                                                    {onNewSessionInDirectory && canStartInGroupDirectory ? (
                                                        <button
                                                            type="button"
                                                            onClick={(event) => {
                                                                event.stopPropagation()
                                                                onNewSessionInDirectory({
                                                                    machineId: group.machineId,
                                                                    directory: group.directory
                                                                })
                                                            }}
                                                            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8e8e93] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                                            title={t('sessions.group.new')}
                                                            aria-label={t('sessions.group.new')}
                                                        >
                                                            <ComposeIcon className="h-6 w-6" />
                                                        </button>
                                                    ) : null}
                                                </div>

                                                {/* Level 3: Sessions */}
                                                <div className="collapsible-panel" data-open={!isCollapsed || undefined}>
                                                    <div className="collapsible-inner">
                                                    <div className="flex flex-col py-2 pl-4">
                                                        {visibleGroupSessions.map((s) => (
                                                            <SessionItem
                                                                key={s.id}
                                                                session={s}
                                                                onSelect={props.onSelect}
                                                                showPath={false}
                                                                api={api}
                                                                selected={s.id === selectedSessionId}
                                                                showDetailedStatus={showDetailedStatus}
                                                            />
                                                        ))}
                                                        {group.sessions.length > sessionPreviewLimit && (hiddenSessionCount > 0 || canCollapseSessions) ? (
                                                            <button
                                                                type="button"
                                                                onClick={() => hiddenSessionCount > 0
                                                                    ? showMoreSessions(group)
                                                                    : collapseSessionGroup(group)}
                                                                className={cn(
                                                                    'my-1 rounded-xl px-0 py-2 text-left text-base text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]'
                                                                )}
                                                            >
                                                                {hiddenSessionCount > 0
                                                                    ? t('sessions.group.showMore', { n: showMoreCount })
                                                                    : t('sessions.group.showLess')}
                                                            </button>
                                                        ) : null}
                                                    </div>
                                                    </div>
                                                </div>
                                            </section>
                                        )
                                    })}
                                </div>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
