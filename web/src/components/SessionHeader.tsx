import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { CodexTokenUsage, CodexUsageAccount } from '@hapi/protocol/codexUsage'
import { CodexUsageDrawer } from './CodexUsageDrawer'
import { RefreshCw as RefreshIconNode, Wifi as WifiIconNode, WifiOff as WifiOffIconNode } from 'lucide'
import { Bot, ChevronRight, Clock3, Folder, Hash, Pencil, Tag, UsersRound, X } from 'lucide-react'
import type { CodexSubscriptionLimits, CodexSubscriptionLimitWindow, Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCodexSubscriptionLimits } from '@/hooks/queries/useCodexSubscriptionLimits'
import {
    useSessionConnection,
    type SessionConnectionContextValue,
    type SessionConnectionHealth
} from '@/lib/session-connection-context'
import { SessionActionMenu } from '@/components/SessionActionMenu'
import { SessionGroupDrawer } from '@/components/SessionGroupDrawer'
import { SessionLabelDialog } from '@/components/SessionLabelDialog'
import { resolveSessionGroup, useSessionGroups } from '@/hooks/useSessionGroups'
import { resolveSessionLabel, useSessionLabels } from '@/hooks/useSessionLabels'
import type { SessionGroup } from '@hapi/protocol/sessionGroups'
import { GitBranchesDrawer } from '@/components/GitBranchesDrawer'
import { SessionExportDialog } from '@/components/SessionExportDialog'
import { RenameSessionDialog } from '@/components/RenameSessionDialog'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { AgentFlavorStatusIcon } from '@/components/AgentFlavorIcon'
import { formatReopenError } from '@/lib/reopenError'
import { useTranslation } from '@/lib/use-translation'
import { MOBILE_LAYOUT_CONTRACT, mobileLayoutHeaderShellStyle } from '@/lib/mobileLayoutContract'
import type { StatusBarProps } from '@/components/AssistantChat/StatusBar'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { MotionIcon, toMotionIcon } from '@/components/MotionIcon'
import { SESSION_DETAIL_HEADER_ROW_CLASS, SESSION_DETAIL_HEADER_SAFE_AREA_CLASS } from '@/components/SessionDetailHeader'
import { useMachineGitBranch } from '@/hooks/queries/useGitBranch'
import { getSessionDisplayTitle } from '@/lib/session-title'

type Translator = (key: string, params?: Record<string, string | number>) => string

function getSessionProjectPath(session: Session): string | null {
    return session.metadata?.worktree?.basePath ?? session.metadata?.path ?? null
}

function SessionHeaderDetailRow(props: {
    detail: SessionHeaderDetail
    copied: boolean
    onCopy: () => void
    divided?: boolean
}) {
    const { t } = useTranslation()
    const { detail } = props
    const agentParts = detail.isAgentInfo
        ? detail.value.split(' · ').map((part) => part.trim()).filter(Boolean)
        : []
    const Icon = detail.key === 'group'
        ? UsersRound
        : detail.key === 'label'
            ? Tag
            : detail.key === 'path'
                ? Folder
                : detail.key === 'last-activity'
                    ? Clock3
                    : detail.key === 'agent'
                        ? Bot
                        : Hash

    const content = (
        <>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                <Icon className="h-[17px] w-[17px]" strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 py-2.5">
                <span className="block text-[11px] font-medium leading-4 text-[var(--app-hint)]">{detail.label}</span>
                {agentParts.length > 0 ? (
                    <span className="mt-0.5 block">
                        <span className="block truncate text-sm font-semibold leading-5 text-[var(--app-fg)]">{agentParts[0]}</span>
                        {agentParts.length > 1 ? (
                            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                                {agentParts.slice(1).map((part, index) => {
                                    const [rawKey, ...rest] = part.split(':')
                                    const hasValue = rest.length > 0
                                    return (
                                        <span key={`${part}-${index}`} className="min-w-0 text-xs leading-4 text-[var(--app-hint)]">
                                            {hasValue ? <><span>{rawKey.trim()}:</span> <span className="font-medium text-[var(--app-fg)]">{rest.join(':').trim()}</span></> : <span className="font-medium text-[var(--app-fg)]">{part}</span>}
                                        </span>
                                    )
                                })}
                            </span>
                        ) : null}
                    </span>
                ) : (
                    <span className={`mt-0.5 block text-sm font-medium leading-5 text-[var(--app-fg)] ${detail.key === 'session-id' || detail.key === 'codex-session-id' ? 'break-all font-mono text-xs' : 'line-clamp-2 break-words'}`} title={detail.value}>{detail.value}</span>
                )}
            </span>
        </>
    )

    if (detail.onSelect) return (
        <button
            type="button"
            aria-label={detail.value}
            onClick={detail.onSelect}
            className={`flex min-h-[58px] w-full items-center gap-3 px-3 text-left transition-colors active:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)] ${props.divided ? 'border-t border-[var(--app-divider)]' : ''}`}
        >
            {content}
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-hint)]" strokeWidth={1.8} aria-hidden="true" />
        </button>
    )

    return (
        <div className={`flex min-h-[58px] items-center gap-3 px-3 ${props.divided ? 'border-t border-[var(--app-divider)]' : ''}`}>
            {content}
            <button
                type="button"
                onClick={props.onCopy}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors active:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                aria-label={t('session.header.details.copy', { label: detail.label })}
                title={t('session.header.details.copy', { label: detail.label })}
            >
                {props.copied
                    ? <CheckIcon className="h-4 w-4 text-green-500" />
                    : <CopyIcon className="h-4 w-4" />}
            </button>
        </div>
    )
}

export type SessionHeaderDetail = {
    key: string
    label: string
    value: string
    isAgentInfo?: boolean
    onSelect?: () => void
}

type SessionHeaderDetailsRef = {
    current: readonly SessionHeaderDetail[]
}

const EMPTY_SESSION_HEADER_DETAILS: readonly SessionHeaderDetail[] = []

/**
 * Keep the title details dialog consistent across SHAPI-backed and native
 * Codex detail pages.  The transports provide different records, but the
 * operator should see the same rows in the same order.
 */
export function buildSessionHeaderDetails(input: {
    group?: SessionGroup
    onSetGroup?: () => void
    label?: string
    onSetLabel?: () => void
    title: string
    sessionId: string
    codexSessionId?: string | null
    projectPath?: string | null
    lastActivityAt?: number | null
    agentFlavor?: string | null
    model?: string | null
    reasoning?: string | null
    effort?: string | null
    serviceTier?: string | null
    permissionMode?: string | null
    collaborationMode?: string | null
}, t: Translator): SessionHeaderDetail[] {
    const agentInfo = [
        input.agentFlavor?.trim() || t('session.header.agent.unknown'),
        input.model ? `${t('session.header.agent.model')}: ${input.model}` : null,
        input.reasoning ? `${t('session.header.agent.reasoning')}: ${input.reasoning}` : null,
        input.effort ? `${t('session.header.agent.effort')}: ${input.effort}` : null,
        input.serviceTier ? `${t('session.header.agent.tier')}: ${input.serviceTier}` : null,
        input.permissionMode ? `${t('session.header.agent.permission')}: ${input.permissionMode}` : null,
        input.collaborationMode ? `${t('session.header.agent.collaboration')}: ${input.collaborationMode}` : null
    ].filter((part): part is string => Boolean(part)).join(' · ')

    const lastActivity = input.lastActivityAt === undefined || input.lastActivityAt === null
        ? t('session.header.details.unavailable')
        : formatHeaderDateTime(input.lastActivityAt)

    return [
        { key: 'title', label: t('session.header.details.fullName'), value: input.title },
        ...(input.onSetGroup ? [{ key: 'group', label: t('session.groups.title'), value: input.group ? `${input.group.emoji} ${input.group.name}` : t('session.groups.none'), onSelect: input.onSetGroup }] : []),
        ...(input.onSetLabel ? [{ key: 'label', label: t('session.labels.title'), value: input.label ?? t('session.labels.none'), onSelect: input.onSetLabel }] : []),
        { key: 'session-id', label: t('session.header.details.sessionId'), value: input.sessionId },
        ...(input.codexSessionId && input.codexSessionId !== input.sessionId
            ? [{ key: 'codex-session-id', label: t('session.header.details.codexSessionId'), value: input.codexSessionId }]
            : []),
        {
            key: 'path',
            label: t('session.header.details.projectPath'),
            value: input.projectPath?.trim() || t('session.header.details.unavailable')
        },
        {
            key: 'last-activity',
            label: t('session.header.details.lastActivity'),
            value: lastActivity
        },
        {
            key: 'agent',
            label: t('session.header.details.agentInfo'),
            value: agentInfo || t('session.header.details.unavailable'),
            isAgentInfo: true
        }
    ]
}

function formatHeaderDateTime(value: number): string {
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

/** The shared title trigger and details popover used by all session chat pages. */
export const SessionTitleDetails = memo(function SessionTitleDetails(props: {
    title: string
    sessionId?: string
    onRename?: () => void
    details?: readonly SessionHeaderDetail[]
    /**
     * Normal SHAPI chats keep their latest details in this stable ref. A token
     * stream can update it without invalidating the title control; opening
     * the popover reads the newest snapshot.
     */
    detailsRef?: SessionHeaderDetailsRef
    /** Changes only for meaningful title-detail fields, never updatedAt. */
    detailsRevision?: string
}) {
    const { t } = useTranslation()
    const [detailsOpen, setDetailsOpen] = useState(false)
    const [detailsTab, setDetailsTab] = useState<'overview' | 'technical'>('overview')
    const detailsId = useId()
    const titleDetailsRef = useRef<HTMLDivElement | null>(null)
    const copyResetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
    const [copiedDetailKey, setCopiedDetailKey] = useState<string | null>(null)
    const details = props.detailsRef?.current ?? props.details ?? EMPTY_SESSION_HEADER_DETAILS

    const toggleDetails = useCallback(() => {
        setDetailsOpen((open) => !open)
    }, [])

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

    useEffect(() => {
        if (!detailsOpen) setDetailsTab('overview')
    }, [detailsOpen])

    useEffect(() => {
        setDetailsOpen(false)
        setDetailsTab('overview')
        setCopiedDetailKey(null)
    }, [props.sessionId])

    const titleDetail = details.find((detail) => detail.key === 'title')
    const detailGroups = detailsTab === 'overview'
        ? [
            details.filter((detail) => detail.key === 'group' || detail.key === 'label'),
            details.filter((detail) => detail.key === 'path'),
            details.filter((detail) => detail.key === 'agent')
        ].filter((group) => group.length > 0)
        : [
            details.filter((detail) => detail.key === 'last-activity'),
            details.filter((detail) => detail.key === 'session-id' || detail.key === 'codex-session-id')
        ].filter((group) => group.length > 0)

    return (
        <div ref={titleDetailsRef} className="relative min-w-0 max-w-[min(58vw,22rem)]">
            <button
                type="button"
                onClick={toggleDetails}
                className="pointer-events-auto touch-manipulation flex h-11 w-full min-w-0 items-center rounded-full px-1 text-left text-[15px] font-medium leading-5 tracking-[-0.01em] text-[var(--app-fg)] transition-colors hover:text-[var(--app-link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                aria-haspopup="dialog"
                aria-expanded={detailsOpen}
                aria-controls={detailsOpen ? detailsId : undefined}
                title={props.title}
            >
                <span className="min-w-0 flex-1 truncate">{props.title}</span>
            </button>

            {detailsOpen ? (
                <div
                    id={detailsId}
                    role="dialog"
                    aria-label={t('session.header.details.title')}
                    data-testid="session-title-details-popover"
                    className="session-title-popover pointer-events-auto fixed z-50 overflow-y-auto overscroll-contain rounded-[22px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2.5 text-left shadow-[0_20px_56px_rgba(15,23,42,0.2)]"
                >
                    <div className="flex min-h-11 items-center justify-between gap-3 px-1.5">
                        <div className="min-w-0 text-[13px] font-semibold text-[var(--app-hint)]">{t('session.header.details.title')}</div>
                        <button
                            type="button"
                            onClick={() => setDetailsOpen(false)}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors active:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            aria-label={t('button.close')}
                        >
                            <X className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden="true" />
                        </button>
                    </div>

                    <div role="tablist" aria-label={t('session.header.details.title')} className="mb-2.5 grid grid-cols-2 rounded-xl bg-[var(--app-subtle-bg)] p-1">
                        {(['overview', 'technical'] as const).map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                role="tab"
                                aria-selected={detailsTab === tab}
                                onClick={() => setDetailsTab(tab)}
                                className={`min-h-9 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${detailsTab === tab ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)]'}`}
                            >
                                {t(tab === 'overview' ? 'session.header.details.overview' : 'session.header.details.technical')}
                            </button>
                        ))}
                    </div>

                    <div className="flex flex-col gap-2.5">
                        <div className="flex min-h-[68px] items-center gap-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5" data-session-detail-group="title">
                            <span className="min-w-0 flex-1">
                                <span className="block text-[11px] font-medium leading-4 text-[var(--app-hint)]">{titleDetail?.label ?? t('session.header.details.fullName')}</span>
                                <span className="mt-0.5 line-clamp-3 block break-words text-[15px] font-semibold leading-5 text-[var(--app-fg)]" title={titleDetail?.value ?? props.title}>
                                    {titleDetail?.value ?? props.title}
                                </span>
                            </span>
                            {props.onRename ? <button
                                type="button"
                                onClick={() => { setDetailsOpen(false); props.onRename?.() }}
                                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors active:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                aria-label={t('session.action.rename')}
                            >
                                <Pencil className="h-4 w-4" aria-hidden="true" />
                            </button> : null}
                        </div>

                        {detailGroups.map((group, groupIndex) => (
                            <div
                                key={group.map((detail) => detail.key).join('-')}
                                data-session-detail-group={`${detailsTab}-${groupIndex}`}
                                className="overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)]"
                            >
                                {group.map((detail, rowIndex) => (
                                    <SessionHeaderDetailRow
                                        key={detail.key}
                                        detail={detail.onSelect
                                            ? { ...detail, onSelect: () => { setDetailsOpen(false); detail.onSelect?.() } }
                                            : detail}
                                        copied={copiedDetailKey === detail.key}
                                        onCopy={() => copyDetail(detail.key, detail.value)}
                                        divided={rowIndex > 0}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    )
})

export function SessionHeaderBackButton(props: { onBack: () => void; label?: string }) {
    const { t } = useTranslation()

    return (
        <button
            type="button"
            onClick={props.onBack}
            data-testid="session-header-back"
            aria-label={props.label ?? t('session.back')}
            title={props.label ?? t('session.back')}
            className="pointer-events-auto touch-manipulation flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
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
    )
}

function SessionConnectionIcon(props: { health: SessionConnectionHealth }) {
    const icon = props.health === 'offline'
        ? WifiOffIconNode
        : props.health === 'recovering'
            ? RefreshIconNode
            : WifiIconNode
    const state = props.health === 'offline'
        ? 'wifi-off'
        : props.health === 'recovering'
            ? 'refresh'
            : 'wifi'

    return (
        <MotionIcon
            icon={toMotionIcon(icon)}
            className={props.health === 'recovering' ? 'h-5 w-5 motion-safe:animate-spin' : 'h-5 w-5'}
            data-motion-icon={state}
            strokeWidth={2.25}
            aria-hidden="true"
        />
    )
}

function formatConnectionLastUpdated(value: number | null | undefined): string | null {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return null
    }
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
    const date = new Date(milliseconds)
    if (Number.isNaN(date.getTime())) {
        return null
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Shared visual control for a detail page whose live data connection needs
 * attention. SHAPI sessions obtain the value from the SSE provider; native
 * Codex sessions can supply the same shape from their runner queries.
 */
export type SessionConnectionStatusLabels = {
    degraded: string
    recovering: string
    offline: string
    recover: string
}

export function SessionConnectionStatusControl(props: {
    connection: SessionConnectionContextValue | null
    testId?: string
    labels?: Partial<SessionConnectionStatusLabels>
}) {
    const connection = props.connection
    const { t } = useTranslation()
    const labels: SessionConnectionStatusLabels = {
        degraded: props.labels?.degraded ?? t('session.connection.degraded'),
        recovering: props.labels?.recovering ?? t('session.connection.recovering'),
        offline: props.labels?.offline ?? t('session.connection.offline'),
        recover: props.labels?.recover ?? t('session.connection.recover')
    }
    const [initialRecoveryGraceElapsed, setInitialRecoveryGraceElapsed] = useState(
        () => connection?.health !== 'recovering'
    )
    useEffect(() => {
        if (initialRecoveryGraceElapsed) return
        if (connection?.health !== 'recovering') {
            setInitialRecoveryGraceElapsed(true)
            return
        }
        const timer = window.setTimeout(() => setInitialRecoveryGraceElapsed(true), 3_000)
        return () => window.clearTimeout(timer)
    }, [connection?.health, initialRecoveryGraceElapsed])
    const recover = useCallback(() => {
        if (!connection || connection.health === 'recovering') {
            return
        }
        void connection.recover()
    }, [connection])
    if (
        !connection
        || connection.health === 'connected'
        || (connection.health === 'recovering' && !initialRecoveryGraceElapsed)
    ) {
        return null
    }

    const presentation = connection.health === 'degraded'
        ? {
            label: labels.degraded,
            icon: <SessionConnectionIcon health={connection.health} />,
            iconClass: 'text-amber-500'
        }
        : connection.health === 'recovering'
            ? {
                label: labels.recovering,
                icon: <SessionConnectionIcon health={connection.health} />,
                iconClass: 'text-amber-500'
            }
            : {
                label: labels.offline,
                icon: <SessionConnectionIcon health={connection.health} />,
                iconClass: 'text-red-500'
            }
    const lastUpdated = formatConnectionLastUpdated(connection.lastUpdatedAt)
    const updatedLabel = lastUpdated ? t('session.connection.lastUpdated', { time: lastUpdated }) : null
    const actionLabel = connection.health === 'recovering'
        ? presentation.label
        : `${presentation.label} · ${labels.recover}${updatedLabel ? ` · ${updatedLabel}` : ''}`

    const edgeOffset = 'max(0.75rem, calc((100% - var(--content-max-w, 960px)) / 2 + 0.75rem))'

    const testId = props.testId ?? 'session-connection-recovery'

    return (
        <div
            data-testid={`${testId}-float`}
            data-last-updated-at={connection.lastUpdatedAt ?? undefined}
            className="fixed top-[calc(var(--app-safe-area-top)+4.75rem)] z-30"
            style={{ right: edgeOffset }}
        >
            <button
                type="button"
                onClick={recover}
                disabled={connection.health === 'recovering'}
                data-testid={testId}
                className="pointer-events-auto touch-manipulation relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--app-fg)_14%,var(--app-bg))] bg-[var(--app-bg)] shadow-[0_8px_24px_rgba(15,23,42,0.10)] transition-colors hover:border-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-wait dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]"
                aria-label={actionLabel}
                title={actionLabel}
                aria-busy={connection.health === 'recovering' || undefined}
            >
                <span className={presentation.iconClass}>{presentation.icon}</span>
            </button>
        </div>
    )
}

/** SHAPI-session adapter for the shared detail-page connection control. */
export function SessionConnectionRecoveryControl(props: {
    labels?: Partial<SessionConnectionStatusLabels>
    testId?: string
} = {}) {
    const connection = useSessionConnection()
    return <SessionConnectionStatusControl connection={connection} labels={props.labels} testId={props.testId} />
}

/** Shared floating header shell for normal and external Codex session details. */
export function FloatingSessionHeader(props: {
    onBack: () => void
    backLabel?: string
    title: string
    sessionId?: string
    details?: readonly SessionHeaderDetail[]
    detailsRef?: SessionHeaderDetailsRef
    detailsRevision?: string
    onRename?: () => void
    actions?: ReactNode
    floating?: boolean
}) {
    // In Telegram, don't render header (Telegram provides its own).
    if (isTelegramApp()) {
        return null
    }

    // A small visual minimum keeps the title clear of the top edge when a
    // standalone WebKit viewport reports a zero inset. On notched devices the
    // browser-provided inset remains the source of truth.
    const headerTopInsetClass = SESSION_DETAIL_HEADER_SAFE_AREA_CLASS
    // The message viewport intentionally scrolls under this transparent
    // shell. Only visible controls receive hits: the empty transparent area
    // must continue sending a vertical pan to the conversation below.
    const headerShellClass = props.floating
        ? `pointer-events-none absolute inset-x-0 top-0 z-40 isolate ${headerTopInsetClass}`
        : headerTopInsetClass
    // The full-width title-bar shell is transparent. Its compact controls
    // deliberately keep their own solid surface for legibility.
    const headerSurfaceClass = 'border-[color-mix(in_srgb,var(--app-fg)_14%,var(--app-bg))] bg-[var(--app-bg)]'
    const headerElevationClass = 'shadow-[0_8px_24px_rgba(15,23,42,0.10)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]'

    return (
        <div
            className={`${headerShellClass} session-header-shell`}
            style={mobileLayoutHeaderShellStyle}
            data-testid={MOBILE_LAYOUT_CONTRACT.header.testId}
            data-mobile-layout-contract={MOBILE_LAYOUT_CONTRACT.header.state}
        >
            <div className={SESSION_DETAIL_HEADER_ROW_CLASS} data-testid="session-header-row">
                <div
                    data-testid="session-header-controls"
                    className={`pointer-events-auto flex h-11 min-w-0 items-center gap-0 rounded-full border pl-1 pr-5 ${headerSurfaceClass} ${headerElevationClass}`}
                >
                    <SessionHeaderBackButton onBack={props.onBack} label={props.backLabel} />
                    <SessionTitleDetails
                        title={props.title}
                        sessionId={props.sessionId}
                        details={props.details}
                        detailsRef={props.detailsRef}
                        detailsRevision={props.detailsRevision}
                        onRename={props.onRename}
                    />
                </div>

                {props.actions ? (
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                        {props.actions}
                    </div>
                ) : null}
            </div>
        </div>
    )
}

/**
 * The floating header only needs connection state. Keeping this deliberately
 * narrow means a streaming token/usage update cannot invalidate the memoized
 * header just because the chat body has new derived metadata.
 */
export type SessionHeaderStatus = Pick<
    StatusBarProps,
    'active' | 'thinking' | 'agentState' | 'backgroundTaskCount' | 'voiceStatus'
>

function getStatusDotClass(status?: SessionHeaderStatus): string {
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

function formatLimitDuration(window: CodexSubscriptionLimitWindow | null, t: Translator): string {
    const duration = window?.windowDurationMins
    if (!duration || duration <= 0) {
        return t('session.header.codexLimits.limit')
    }
    if (duration === 300) {
        return t('session.header.codexLimits.duration.fiveHours')
    }
    if (duration >= 7 * 24 * 60) {
        const days = Math.round(duration / (24 * 60))
        return t('session.header.codexLimits.duration.days', { value: days })
    }
    if (duration >= 60) {
        const hours = duration / 60
        return t('session.header.codexLimits.duration.hours', {
            value: Number.isInteger(hours) ? hours : hours.toFixed(1)
        })
    }
    return t('session.header.codexLimits.duration.minutes', { value: duration })
}

function formatLimitWindow(window: CodexSubscriptionLimitWindow | null, t: Translator): string | null {
    if (!window) {
        return null
    }
    return `${formatLimitDuration(window, t)} ${Math.round(100 - clampPercent(window.usedPercent))}%`
}

function formatLimitUpdatedAt(updatedAt: number | null | undefined, locale: string): string | null {
    if (!updatedAt) {
        return null
    }
    const timestamp = updatedAt > 1_000_000_000_000 ? updatedAt : updatedAt * 1000
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) {
        return null
    }
    return date.toLocaleTimeString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
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

function formatResetAt(resetsAt: number | null, locale: string): string | null {
    if (!resetsAt) {
        return null
    }
    const timestamp = resetsAt > 1_000_000_000_000 ? resetsAt : resetsAt * 1000
    const date = new Date(timestamp)
    if (Number.isNaN(date.getTime())) {
        return null
    }
    return date.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}


export function CodexSubscriptionLimitsBadge(props: {
    limits: CodexSubscriptionLimits | null
    isFetching: boolean
    error: string | null
    account?: CodexUsageAccount | null
    usage?: CodexTokenUsage | null
    onRefresh?: () => void
}) {
    const { t, locale } = useTranslation()
    const [open, setOpen] = useState(false)
    const toggleOpen = useCallback(() => {
        setOpen((value) => !value)
    }, [])
    const windows = getDisplayLimitWindows(props.limits)
    const text = windows.map((window) => formatLimitWindow(window, t)).filter(Boolean).join(' · ')
    const rows = windows.map((window) => ({
        label: formatLimitDuration(window, t),
        remaining: getRemainingPercent(window),
        resetAt: formatResetAt(window.resetsAt, locale)
    }))
    const resetDetails = windows
        .map((window) => {
            const resetAt = formatResetAt(window.resetsAt, locale)
            const used = Math.round(clampPercent(window.usedPercent))
            const remaining = getRemainingPercent(window)
            const summary = t('session.header.codexLimits.summary', {
                window: formatLimitDuration(window, t),
                remaining,
                used
            })
            return resetAt
                ? t('session.header.codexLimits.summaryWithReset', { summary, time: resetAt })
                : summary
        })
        .filter(Boolean)
        .join('\n')
    const title = props.error
        ? t('usage.refreshFailed')
        : resetDetails || t('session.header.codexLimits.title')
    const updatedAt = formatLimitUpdatedAt(props.limits?.updatedAt, locale)

    if (!props.limits || rows.length === 0) return null

    return (
        <div className="pointer-events-auto relative shrink-0">
            <button
                type="button"
                onClick={toggleOpen}
                className={[
                    'flex h-11 min-w-[50px] flex-col items-start justify-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-[11px] font-semibold leading-none tabular-nums text-[var(--app-hint)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]',
                    props.isFetching ? 'opacity-60' : ''
                ].filter(Boolean).join(' ')}
                title={title}
                aria-label={t('session.header.codexLimits.aria', { summary: text })}
                aria-haspopup="dialog"
                aria-expanded={open}
            >
                {rows.length === 0 ? <span>{t('session.header.codexLimits.title')}</span> : null}
                {rows.map((row) => (
                    <span key={row.label} className="grid grid-cols-[auto_auto] items-center gap-x-1.5">
                        <span className="text-[var(--app-fg)]">{row.label}</span>
                        <span className={getLimitPercentClass(row.remaining)}>
                            {row.remaining === null ? '--' : `${row.remaining}%`}
                        </span>
                    </span>
                ))}
            </button>

            <CodexUsageDrawer open={open} onOpenChange={setOpen} account={props.account} usage={props.usage}
                rows={rows} updatedAt={updatedAt} isFetching={props.isFetching} error={props.error}
                onRefresh={props.onRefresh} />
        </div>
    )
}

export const SessionHeader = memo(function SessionHeader(props: {
    session: Session
    onBack: () => void
    onRefresh?: () => void
    refreshPending?: boolean
    onToggleFiles?: () => void
    filesActive?: boolean
    onToggleOutline?: () => void
    outlineActive?: boolean
    api: ApiClient | null
    onSessionDeleted?: () => void
    onSessionReopened?: (newSessionId: string) => void
    onCreateSideSession?: () => void
    sideSessionPending?: boolean
    onCreateMonitor?: () => void
    status?: SessionHeaderStatus
    floating?: boolean
}) {
    const { t } = useTranslation()
    const { session, api, onSessionDeleted, onSessionReopened } = props
    const groupsQuery = useSessionGroups(api)
    const labelsQuery = useSessionLabels(api)
    const groupSource = useMemo(() => ({ type: 'managed' as const, sessionId: session.id }), [session.id])
    const nativeGroupAlias = useMemo(() => session.metadata?.machineId && session.metadata?.codexSessionId
        ? { type: 'native-codex' as const, machineId: session.metadata.machineId, codexSessionId: session.metadata.codexSessionId }
        : null, [session.metadata?.machineId, session.metadata?.codexSessionId])
    const sessionGroup = resolveSessionGroup(groupsQuery.data, groupSource, nativeGroupAlias)
    const sessionLabel = resolveSessionLabel(labelsQuery.data, groupSource, nativeGroupAlias)
    const [groupOpen, setGroupOpen] = useState(false)
    const [labelOpen, setLabelOpen] = useState(false)
    const openGroup = useCallback(() => setGroupOpen(true), [])
    const openLabel = useCallback(() => setLabelOpen(true), [])
    const title = useMemo(() => getSessionDisplayTitle(session), [session])
    const projectPath = useMemo(() => getSessionProjectPath(session), [session])
    // A worktree session must act on its actual checkout, while the title
    // details may still show the stable project base path.
    const gitProjectPath = session.metadata?.path ?? projectPath
    const machineId = session.metadata?.machineId ?? null
    const { isGitRepository } = useMachineGitBranch(
        api,
        machineId,
        gitProjectPath,
        true,
        { refetchInterval: false }
    )
    const sessionDetails = useMemo(() => buildSessionHeaderDetails({
        group: sessionGroup,
        onSetGroup: api ? openGroup : undefined,
        label: sessionLabel,
        onSetLabel: api ? openLabel : undefined,
        title,
        sessionId: session.id,
        codexSessionId: session.metadata?.codexSessionId,
        projectPath,
        lastActivityAt: session.updatedAt,
        agentFlavor: session.metadata?.flavor,
        model: session.model,
        reasoning: session.modelReasoningEffort,
        effort: session.effort,
        serviceTier: session.serviceTier,
        permissionMode: session.permissionMode,
        collaborationMode: session.collaborationMode
    }, t), [
        sessionGroup, sessionLabel, api, openGroup, openLabel,
        projectPath,
        session.collaborationMode,
        session.effort,
        session.id,
        session.metadata?.codexSessionId,
        session.metadata?.flavor,
        session.model,
        session.modelReasoningEffort,
        session.permissionMode,
        session.serviceTier,
        session.updatedAt,
        t,
        title
    ])
    // The parent must still react to normal session state for menus/status,
    // but the high-frequency `updatedAt` snapshot stays behind this stable
    // ref. SessionTitleDetails only renders when the person opens it or a
    // meaningful title/detail field changes.
    const sessionDetailsRef = useRef<readonly SessionHeaderDetail[]>(sessionDetails)
    sessionDetailsRef.current = sessionDetails
    const sessionDetailsRevision = [
        sessionGroup?.id ?? '', sessionGroup?.name ?? '', sessionGroup?.emoji ?? '', sessionLabel ?? '',
        session.id,
        session.metadata?.codexSessionId ?? '',
        projectPath ?? '',
        session.metadata?.flavor ?? '',
        session.model ?? '',
        session.modelReasoningEffort ?? '',
        session.effort ?? '',
        session.serviceTier ?? '',
        session.permissionMode ?? '',
        session.collaborationMode ?? ''
    ].join('\u0000')

    const [menuOpen, setMenuOpen] = useState(false)
    const [menuAnchorPoint, setMenuAnchorPoint] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
    const menuId = useId()
    const menuAnchorRef = useRef<HTMLButtonElement | null>(null)
    const [renameOpen, setRenameOpen] = useState(false)
    const [exportOpen, setExportOpen] = useState(false)
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [releaseControlOpen, setReleaseControlOpen] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [gitBranchesOpen, setGitBranchesOpen] = useState(false)

    const { archiveSession, releaseSessionControl, reopenSession, renameSession, deleteSession, isPending } = useSessionActions(
        api,
        session.id,
        session.metadata?.flavor ?? null
    )
    const codexLimitsState = useCodexSubscriptionLimits({
        api,
        sessionId: session.id,
        model: session.model ?? null,
        provider: session.metadata?.codexModelProvider,
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

    const canReleaseControl = session.active
        && session.metadata?.flavor === 'codex'
        && session.metadata.startedFromRunner === true
        && session.metadata.controlOwner !== 'external'
        && session.agentState?.controlledByUser !== true

    const handleMenuToggle = () => {
        if (!menuOpen && menuAnchorRef.current) {
            const rect = menuAnchorRef.current.getBoundingClientRect()
            setMenuAnchorPoint({ x: rect.right, y: rect.bottom })
        }
        setMenuOpen((open) => !open)
    }
    // Keep the normal-session Telegram behavior unchanged: Telegram provides
    // its own header and must not receive the normal action menu either.
    if (isTelegramApp()) {
        return null
    }

    return (
        <>
            <FloatingSessionHeader
                onBack={props.onBack}
                title={title}
                sessionId={session.id}
                detailsRef={sessionDetailsRef}
                detailsRevision={sessionDetailsRevision}
                onRename={() => setRenameOpen(true)}
                floating={props.floating}
                actions={(
                    <>
                        {session.metadata?.flavor === 'codex' ? (
                            <CodexSubscriptionLimitsBadge
                                limits={codexLimitsState.limits}
                                account={codexLimitsState.account}
                                usage={session.metadata?.codexTokenUsage}
                                onRefresh={() => { codexLimitsState.refresh(); props.onRefresh?.() }}
                                isFetching={codexLimitsState.isFetching}
                                error={codexLimitsState.error}
                            />
                        ) : null}

                        <button
                            type="button"
                            onClick={handleMenuToggle}
                            onPointerDown={(event) => event.stopPropagation()}
                            ref={menuAnchorRef}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-controls={menuOpen ? menuId : undefined}
                            aria-label={t('session.more')}
                            className="pointer-events-auto touch-manipulation flex h-11 w-11 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--app-fg)_14%,var(--app-bg))] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-[0_8px_24px_rgba(15,23,42,0.10)] transition-colors hover:border-[var(--app-hint)] hover:text-[var(--app-fg)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]"
                            title={t('session.more')}
                        >
                            <AgentFlavorStatusIcon
                                flavor={session.metadata?.flavor ?? 'claude'}
                                className="h-5 w-5 shrink-0"
                                showStatus={Boolean(props.status)}
                                statusClassName={getStatusDotClass(props.status)}
                            />
                        </button>
                    </>
                )}
            />

            <SessionGroupDrawer key={session.id} api={api} source={groupSource} nativeAlias={nativeGroupAlias} open={groupOpen} onOpenChange={setGroupOpen} />
            <SessionLabelDialog api={api} source={groupSource} nativeAlias={nativeGroupAlias} currentLabel={sessionLabel} open={labelOpen} onOpenChange={setLabelOpen} />
            <SessionActionMenu
                isOpen={menuOpen}
                onClose={() => setMenuOpen(false)}
                sessionActive={session.active}
                onGitBranches={isGitRepository ? () => setGitBranchesOpen(true) : undefined}
                onArchive={() => setArchiveOpen(true)}
                onReleaseControl={canReleaseControl ? () => setReleaseControlOpen(true) : undefined}
                onReopen={handleReopen}
                onDelete={() => setDeleteOpen(true)}
                onToggleFiles={props.onToggleFiles}
                filesActive={props.filesActive}
                onCreateSideSession={props.onCreateSideSession}
                sideSessionPending={props.sideSessionPending}
                onCreateMonitor={props.onCreateMonitor}
                anchorPoint={menuAnchorPoint}
                menuId={menuId}
            />

            <GitBranchesDrawer
                api={api}
                machineId={machineId}
                cwd={gitProjectPath}
                open={gitBranchesOpen}
                onOpenChange={setGitBranchesOpen}
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
                isOpen={releaseControlOpen}
                onClose={() => setReleaseControlOpen(false)}
                title={t('dialog.releaseControl.title')}
                description={t('dialog.releaseControl.description')}
                confirmLabel={t('dialog.releaseControl.confirm')}
                confirmingLabel={t('dialog.releaseControl.confirming')}
                onConfirm={releaseSessionControl}
                isPending={isPending}
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
})
