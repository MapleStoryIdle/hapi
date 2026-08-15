import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { CodexSubscriptionLimits, CodexSubscriptionLimitWindow, Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexSubscriptionLimits } from '@/hooks/queries/useCodexSubscriptionLimits'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { AgentFlavorStatusIcon } from '@/components/AgentFlavorIcon'
import { formatReopenError } from '@/lib/reopenError'
import { useTranslation } from '@/lib/use-translation'
import type { StatusBarProps } from '@/components/AssistantChat/StatusBar'
import { CheckIcon, CopyIcon } from '@/components/icons'

function getSessionTitle(session: Session): string {
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

function getSessionProjectPath(session: Session): string | null {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? null
}

function formatSessionAgentInfo(session: Session): string {
    const parts = [
        session.metadata?.flavor ?? 'unknown',
        session.model ? `model: ${session.model}` : null,
        session.modelReasoningEffort ? `reasoning: ${session.modelReasoningEffort}` : null,
        session.effort ? `effort: ${session.effort}` : null,
        session.serviceTier ? `tier: ${session.serviceTier}` : null,
        session.permissionMode ? `permission: ${session.permissionMode}` : null,
        session.collaborationMode ? `collaboration: ${session.collaborationMode}` : null
    ].filter((part): part is string => Boolean(part))

    return parts.join(' · ')
}

function SessionHeaderDetailRow(props: {
    label: string
    value: string
    copied: boolean
    onCopy: () => void
}) {
    const agentParts = props.label === 'Agent 信息'
        ? props.value.split(' · ').map((part) => part.trim()).filter(Boolean)
        : []

    return (
        <div className="min-w-0 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-3">
                <div className="text-[11px] font-semibold leading-4 tracking-wide text-[var(--app-hint)]">{props.label}</div>
                <button
                    type="button"
                    onClick={props.onCopy}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={`复制${props.label}`}
                    title={`复制${props.label}`}
                >
                    {props.copied
                        ? <CheckIcon className="h-4 w-4 text-green-500" />
                        : <CopyIcon className="h-4 w-4" />}
                </button>
            </div>

            {agentParts.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {agentParts.map((part, index) => {
                        const [rawKey, ...rest] = part.split(':')
                        const hasValue = rest.length > 0
                        const isAgentFlavor = !hasValue && index === 0
                        const key = hasValue ? rawKey.trim() : isAgentFlavor ? 'agent' : ''
                        const value = hasValue ? rest.join(':').trim() : part
                        return (
                            <span
                                // The agent info string is derived from session metadata;
                                // index keeps duplicate keys copy-safe without changing text.
                                key={`${part}-${index}`}
                                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-xs leading-4 text-[var(--app-fg)]"
                            >
                                {key ? (
                                    <span className="shrink-0 font-medium text-[var(--app-hint)]">{key}:</span>
                                ) : null}
                                <span className="min-w-0 truncate font-semibold">{value}</span>
                            </span>
                        )
                    })}
                </div>
            ) : (
                <div className="break-words text-sm font-medium leading-5 text-[var(--app-fg)]">{props.value}</div>
            )}
        </div>
    )
}

function getStatusDotClass(status?: StatusBarProps): string {
    if (!status) return 'hidden'
    const hasPermissions = status.agentState?.requests && Object.keys(status.agentState.requests).length > 0
    if (!status.active) return 'bg-[#999]'
    if (status.voiceStatus === 'connecting' || status.thinking || (status.backgroundTaskCount ?? 0) > 0) return 'bg-[#007AFF] animate-pulse'
    if (hasPermissions) return 'bg-[#FF9500] animate-pulse'
    return 'bg-[#34C759]'
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, value))
}

function formatLimitDuration(window: CodexSubscriptionLimitWindow | null): string {
    const duration = window?.windowDurationMins
    if (!duration || duration <= 0) {
        return 'limit'
    }
    if (duration === 300) {
        return '5h'
    }
    if (duration >= 7 * 24 * 60) {
        const days = Math.round(duration / (24 * 60))
        return `${days}d`
    }
    if (duration >= 60) {
        const hours = duration / 60
        return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
    }
    return `${duration}m`
}

function formatLimitWindow(window: CodexSubscriptionLimitWindow | null): string | null {
    if (!window) {
        return null
    }
    return `${formatLimitDuration(window)} ${Math.round(100 - clampPercent(window.usedPercent))}%`
}

function formatLimitUpdatedAt(updatedAt: number | null | undefined): string | null {
    if (!updatedAt) {
        return null
    }
    const timestamp = updatedAt > 1_000_000_000_000 ? updatedAt : updatedAt * 1000
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) {
        return null
    }
    return date.toLocaleTimeString([], {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    })
}

function getRemainingPercent(window: CodexSubscriptionLimitWindow): number {
    return Math.round(100 - clampPercent(window.usedPercent))
}

function getLimitPercentClass(remainingPercent: number | null): string {
    if (remainingPercent === null) {
        return 'text-[var(--app-hint)]'
    }
    if (remainingPercent < 10) {
        return 'text-red-500'
    }
    if (remainingPercent < 30) {
        return 'text-orange-500'
    }
    return 'text-[var(--app-hint)]'
}

function isDisplayableLimitWindow(window: CodexSubscriptionLimitWindow | null | undefined): window is CodexSubscriptionLimitWindow {
    return window != null && Number.isFinite(window.usedPercent)
}

function getDisplayLimitWindows(limits: CodexSubscriptionLimits | null): CodexSubscriptionLimitWindow[] {
    const windows = [limits?.primary, limits?.secondary]
        .filter(isDisplayableLimitWindow)

    const fiveHourWindow = windows.find((window) => window.windowDurationMins === 300)
    const weeklyWindow = windows.find((window) => (window.windowDurationMins ?? 0) >= 7 * 24 * 60)
    if (fiveHourWindow || weeklyWindow) {
        return [fiveHourWindow, weeklyWindow]
            .filter((window): window is CodexSubscriptionLimitWindow => Boolean(window))
    }

    return windows.sort((a, b) => (a.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (b.windowDurationMins ?? Number.MAX_SAFE_INTEGER))
}

function formatResetAt(resetsAt: number | null): string | null {
    if (!resetsAt) {
        return null
    }
    const timestamp = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) {
        return null
    }
    return date.toLocaleString()
}

function QuotaProgressBar(props: { remainingPercent: number | null }) {
    const remaining = props.remainingPercent === null ? 0 : clampPercent(props.remainingPercent)
    const fillStyle = {
        clipPath: `inset(0 ${100 - remaining}% 0 0)`,
        background: 'linear-gradient(90deg, #ef4444 0%, #ef4444 8%, #f97316 22%, #f97316 32%, #38bdf8 48%, #38bdf8 62%, #22c55e 78%, #22c55e 100%)'
    } satisfies CSSProperties

    return (
        <div className="relative h-1.5 overflow-hidden rounded-full bg-[var(--app-border)]">
            <div className="absolute inset-0" style={fillStyle} />
        </div>
    )
}

function CodexSubscriptionLimitsBadge(props: {
    limits: CodexSubscriptionLimits | null
    isFetching: boolean
    error: string | null
}) {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const windows = getDisplayLimitWindows(props.limits)
    const text = windows.map(formatLimitWindow).filter(Boolean).join(' · ')
    const rows = windows.map((window) => ({
        label: formatLimitDuration(window),
        remaining: getRemainingPercent(window),
        resetAt: formatResetAt(window.resetsAt)
    }))
    const resetDetails = windows
        .map((window) => {
            const resetAt = formatResetAt(window.resetsAt)
            const used = Math.round(clampPercent(window.usedPercent))
            const remaining = getRemainingPercent(window)
            const prefix = `${formatLimitDuration(window)}: ${remaining}% remaining, ${used}% used`
            return resetAt ? `${prefix}, resets ${resetAt}` : prefix
        })
        .filter(Boolean)
        .join('\n')
    const title = props.error
        ? `Codex limits unavailable: ${props.error}`
        : resetDetails || 'Codex subscription limits'
    const updatedAt = formatLimitUpdatedAt(props.limits?.updatedAt)

    useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (rootRef.current?.contains(target)) return
            setOpen(false)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [open])

    if (windows.length === 0) {
        return null
    }

    return (
        <div ref={rootRef} className="pointer-events-auto relative shrink-0">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className={[
                    'flex h-12 min-w-[54px] flex-col items-start justify-center gap-1 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-[11px] font-semibold leading-none tabular-nums text-[var(--app-hint)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                    props.isFetching ? 'opacity-60' : ''
                ].filter(Boolean).join(' ')}
                title={title}
                aria-label={`Codex subscription limits: ${text}`}
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                {rows.map((row) => (
                    <span key={row.label} className="grid grid-cols-[auto_auto] items-center gap-x-1.5">
                        <span className="text-[var(--app-fg)]">{row.label}</span>
                        <span className={getLimitPercentClass(row.remaining)}>
                            {row.remaining === null ? '--' : `${row.remaining}%`}
                        </span>
                    </span>
                ))}
            </button>

            {open ? (
                <div
                    role="dialog"
                    aria-label="Codex 额度"
                    className="absolute right-0 top-full z-50 mt-2 w-[248px] rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
                >
                    <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
                        <div className="text-sm font-semibold text-[var(--app-fg)]">Codex 额度</div>
                        <div className="text-[11px] text-[var(--app-hint)]">
                            {props.isFetching ? '更新中' : updatedAt ? `${updatedAt} 更新` : '已更新'}
                        </div>
                    </div>

                    <div className="flex flex-col gap-2">
                        {rows.map((row) => (
                            <div key={row.label} className="rounded-[13px] border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2.5">
                                <div className="mb-2 flex items-baseline justify-between gap-3 tabular-nums">
                                    <div className="text-sm font-semibold text-[var(--app-fg)]">{row.label} 额度</div>
                                    <div className={['text-lg font-bold', getLimitPercentClass(row.remaining)].join(' ')}>
                                        {row.remaining === null ? '--' : `${row.remaining}%`}
                                    </div>
                                </div>
                                <QuotaProgressBar remainingPercent={row.remaining} />
                                <div className="mt-2 truncate text-[11px] text-[var(--app-hint)]">
                                    {row.resetAt ? `重置：${row.resetAt}` : '重置时间未知'}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export function SessionHeader(props: {
    session: Session
    onBack: () => void
    onToggleFiles?: () => void
    filesActive?: boolean
    onToggleOutline?: () => void
    outlineActive?: boolean
    api: ApiClient | null
    onSessionDeleted?: () => void
    onSessionReopened?: (newSessionId: string) => void
    onCreateSideSession?: () => void
    sideSessionPending?: boolean
    status?: StatusBarProps
    floating?: boolean
}) {
    const { t } = useTranslation()
    const { session, api, onSessionDeleted, onSessionReopened } = props
    const title = useMemo(() => getSessionTitle(session), [session])
    const projectPath = useMemo(() => getSessionProjectPath(session), [session])
    const agentInfo = useMemo(() => formatSessionAgentInfo(session), [session])
    const sessionDetails = useMemo(() => [
        { key: 'title', label: '完整名称', value: title },
        { key: 'session-id', label: '会话 ID', value: session.id },
        { key: 'path', label: '项目路径', value: projectPath ?? '—' },
        { key: 'agent', label: 'Agent 信息', value: agentInfo || '—' }
    ], [agentInfo, projectPath, session.id, title])

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const detailsId = useId()
    const titleDetailsRef = useRef<HTMLDivElement | null>(null)
    const copyResetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
    const [detailsOpen, setDetailsOpen] = useState(false)
    const [copiedDetailKey, setCopiedDetailKey] = useState<string | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)

    const { archiveSession, reopenSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )
    const codexLimitsState = useCodexSubscriptionLimits({
        api,
        sessionId: session.id,
        model: session.model ?? null,
        enabled: session.active && session.metadata?.flavor === 'codex',
        thinking: props.status?.thinking ?? session.thinking
    })
    const [reopenError, setReopenError] = useState<string | null>(null)

    const handleDelete = async () => {
        await deleteSession()
        onSessionDeleted?.()
    }

    const handleReopen = async () => {
        setReopenError(null)
        try {
            const result = await reopenSession()
            if (result.sessionId && result.sessionId !== session.id) {
                onSessionReopened?.(result.sessionId)
            }
        } catch (error) {
            setReopenError(formatReopenError(error))
        }
    }

    const handleMenuToggle = () => {
        if (!menuOpen && menuAnchorRef.current) {
            const rect = menuAnchorRef.current.getBoundingClientRect()
            setMenuAnchorPoint({ x: rect.right, y: rect.bottom })
        }
        setMenuOpen((open) => !open)
    }

    const copyDetail = async (key: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value)
            setCopiedDetailKey(key)
            clearTimeout(copyResetTimerRef.current)
            copyResetTimerRef.current = setTimeout(() => setCopiedDetailKey(null), 1400)
        } catch {
            // Clipboard may be unavailable in insecure/local browser contexts.
        }
    }

    useEffect(() => {
        if (!detailsOpen) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (titleDetailsRef.current?.contains(target)) return
            setDetailsOpen(false)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setDetailsOpen(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [detailsOpen])

    useEffect(() => () => clearTimeout(copyResetTimerRef.current), [])

    // In Telegram, don't render header (Telegram provides its own)
    if (isTelegramApp()) {
        return null
    }

    // A small visual minimum keeps the title clear of the top edge when a
    // standalone WebKit viewport reports a zero inset. On notched devices the
    // browser-provided inset remains the source of truth.
    const headerTopInsetClass = 'pt-[max(var(--app-safe-area-top),0.75rem)]'
    const headerShellClass = props.floating
        ? `pointer-events-none absolute inset-x-0 top-0 z-20 bg-[var(--app-bg)] ${headerTopInsetClass}`
        : `bg-[var(--app-bg)] ${headerTopInsetClass}`
    const headerSurfaceClass = 'border-[var(--app-border)] bg-[var(--app-bg)]'
    const menuButtonSurfaceClass = headerSurfaceClass

    return (
        <>
            <div className={headerShellClass}>
                <div className={`mx-auto flex w-full max-w-content items-center gap-2 px-3 pb-3 ${props.floating ? 'pt-0' : 'pt-3'}`}>
                    <div className={`${props.floating ? 'pointer-events-auto' : ''} flex min-w-0 items-center gap-0.5 rounded-[20px] border px-1.5 py-1.5 ${headerSurfaceClass}`}>
                        {/* Back button */}
                        <button
                            type="button"
                            onClick={props.onBack}
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                        </button>

                        <div ref={titleDetailsRef} className="relative min-w-0">
                            <button
                                type="button"
                                onClick={() => setDetailsOpen((open) => !open)}
                                className="block max-w-full truncate rounded-full px-0.5 pr-1 text-left font-semibold transition-colors hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                aria-haspopup="dialog"
                                aria-expanded={detailsOpen}
                                aria-controls={detailsOpen ? detailsId : undefined}
                                title={title}
                            >
                                {title}
                            </button>

                            {detailsOpen ? (
                                <div
                                    id={detailsId}
                                    role="dialog"
                                    aria-label="会话详情"
                                    className="fixed left-3 top-[calc(env(safe-area-inset-top)+4.25rem)] z-50 w-[min(calc(100vw-1.5rem),22rem)] rounded-[20px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
                                >
                                    <div className="mb-2 px-1 text-sm font-semibold text-[var(--app-fg)]">会话详情</div>
                                    <div className="flex flex-col gap-2">
                                        {sessionDetails.map((row) => (
                                            <SessionHeaderDetailRow
                                                key={row.key}
                                                label={row.label}
                                                value={row.value}
                                                copied={copiedDetailKey === row.key}
                                                onCopy={() => copyDetail(row.key, row.value)}
                                            />
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className={`${props.floating ? 'pointer-events-none' : ''} ml-auto flex shrink-0 items-center gap-1.5`}>
                        {session.metadata?.flavor === 'codex' ? (
                            <CodexSubscriptionLimitsBadge
                                limits={codexLimitsState.limits}
                                isFetching={codexLimitsState.isFetching}
                                error={codexLimitsState.error}
                            />
                        ) : null}

                        <button
                            type="button"
                            onClick={handleMenuToggle}
                            onPointerDown={(e) => e.stopPropagation()}
                            ref={menuAnchorRef}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-controls={menuOpen ? menuId : undefined}
                            className={`pointer-events-auto flex h-12 w-12 items-center justify-center rounded-[18px] border text-[var(--app-hint)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] ${menuButtonSurfaceClass}`}
                            title={t('session.more')}
                        >
                            <AgentFlavorStatusIcon
                                flavor={session.metadata?.flavor ?? 'claude'}
                                className="h-5 w-5 shrink-0"
                                showStatus={Boolean(props.status)}
                                statusClassName={getStatusDotClass(props.status)}
                            />
                        </button>
                    </div>
                </div>
            </div>

            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={session.active}
                onRename={() => setRenameOpen(true)}
                onExport={() => setExportOpen(true)}
                onArchive={() => setArchiveOpen(true)}
                onReopen={handleReopen}
                onDelete={() => setDeleteOpen(true)}
                onToggleFiles={props.onToggleFiles}
                filesActive={props.filesActive}
                onToggleOutline={props.onToggleOutline}
                outlineActive={props.outlineActive}
                onCreateSideSession={props.onCreateSideSession}
                sideSessionPending={props.sideSessionPending}
                anchorPoint={menuAnchorPoint}
                menuId={menuId}
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
                currentName={title}
                onRename={renameSession}
                isPending={isPending}
            />

            <SessionExportDialog
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                session={session}
                api={api}
            />

            <ConfirmDialog
                isOpen={archiveOpen}
                onClose={() => setArchiveOpen(false)}
                title={t('dialog.archive.title')}
                description={t('dialog.archive.description', { name: title })}
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
                description={t('dialog.delete.description', { name: title })}
                confirmLabel={t('dialog.delete.confirm')}
                confirmingLabel={t('dialog.delete.confirming')}
                onConfirm={handleDelete}
                isPending={isPending}
                destructive
            />
        </>
    )
}
