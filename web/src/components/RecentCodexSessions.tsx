import { useCallback, useEffect, useMemo, useState } from 'react'
import { Folder, History, LoaderCircle, RefreshCw } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary } from '@/types/api'
import { formatRelativeTime } from '@/lib/relativeTime'
import { useTranslation } from '@/lib/use-translation'

function formatTimestamp(value: number): string {
    if (!Number.isFinite(value)) return ''
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(milliseconds).toLocaleString()
}

export type RecentCodexDirectoryGroup = {
    directory: string | null
    sessions: CodexLocalSessionSummary[]
    latestModifiedAt: number
}

function getDirectoryDisplayName(directory: string): string {
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    return parts.at(-1) ?? directory
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

/**
 * Local Codex transcripts stay separate from HAPI sessions until the operator
 * opens a read-only detail page and explicitly chooses to fork one.
 */
export function RecentCodexSessions(props: {
    api: ApiClient
    machineId: string | null
    onOpen: (session: CodexLocalSessionSummary) => void
}) {
    const { t } = useTranslation()
    const [sessions, setSessions] = useState<CodexLocalSessionSummary[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
    const directoryGroups = useMemo(() => groupRecentCodexSessionsByDirectory(sessions), [sessions])

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
            const response = await props.api.getCodexSessions({
                machineId,
                limit: 10,
                excludeHapiInitiated: true
            })
            setSessions(response.sessions)
            setLastUpdatedAt(Date.now())
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error))
        } finally {
            setIsLoading(false)
        }
    }, [props.api, props.machineId])

    useEffect(() => {
        void refresh()
    }, [refresh])

    return (
        <section
            className="flex min-h-0 w-full flex-1 flex-col px-4 pb-4 pt-3"
            aria-label={t('recentCodex.title')}
            aria-busy={isLoading || undefined}
            data-testid="recent-codex-sessions"
        >
            <div className="flex items-center justify-between gap-3 pr-10">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold leading-5 text-[var(--app-fg)]">{t('recentCodex.title')}</h2>
                        <p className="truncate text-[11px] text-[var(--app-hint)]">{t('recentCodex.description')}</p>
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
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-45"
                        aria-label={t('recentCodex.refresh')}
                        title={t('recentCodex.refresh')}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                    </button>
                </div>
            </div>

            {loadError ? (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-xs text-red-600" role="status">
                    <span className="min-w-0 break-words">{loadError}</span>
                    <button
                        type="button"
                        onClick={() => void refresh()}
                        className="shrink-0 font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
                    >
                        {t('recentCodex.retry')}
                    </button>
                </div>
            ) : null}

            {isLoading && sessions.length === 0 ? (
                <div className="mt-3 px-1 text-sm text-[var(--app-hint)]">{t('loading')}</div>
            ) : !props.machineId ? (
                <div className="mt-3 rounded-lg bg-[var(--app-subtle-bg)] px-2.5 py-2 text-xs leading-5 text-[var(--app-hint)]">
                    {t('recentCodex.runnerRequired')}
                </div>
            ) : sessions.length === 0 ? (
                <div className="mt-3 rounded-lg bg-[var(--app-subtle-bg)] px-2.5 py-2 text-xs leading-5 text-[var(--app-hint)]">{t('recentCodex.empty')}</div>
            ) : (
                <div className="mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
                    {directoryGroups.map((group) => {
                        const directoryLabel = group.directory
                            ? getDirectoryDisplayName(group.directory)
                            : t('recentCodex.noDirectory')
                        return (
                            <section key={group.directory ?? '__no-directory__'} className="min-w-0">
                                <div
                                    className="group/project flex min-w-0 select-none items-center gap-2 rounded-lg py-1 text-left"
                                    title={group.directory ?? undefined}
                                >
                                    <Folder className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
                                    <span className="min-w-0 truncate text-sm font-semibold leading-5 text-[var(--app-fg)]">
                                        {directoryLabel}
                                    </span>
                                </div>

                                <ul className="flex flex-col py-1 pl-3">
                                    {group.sessions.map((session) => {
                                        const lastActiveLabel = formatRelativeTime(session.modifiedAt, t) ?? formatTimestamp(session.modifiedAt)
                                        return (
                                            <li key={session.id} className="min-w-0">
                                                <button
                                                    type="button"
                                                    onClick={() => props.onOpen(session)}
                                                    className="session-list-item flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                                    aria-label={t('recentCodex.open', { title: session.title })}
                                                >
                                                    <span className="min-w-0 flex-1 truncate text-sm font-normal leading-5 tracking-normal text-[var(--app-fg)]" title={session.title}>
                                                        {session.title}
                                                    </span>
                                                    <span className="flex shrink-0 items-center gap-1.5">
                                                        {session.runState === 'processing' ? (
                                                            <span
                                                                className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-600 dark:text-sky-400"
                                                                title={t('recentCodex.status.processing')}
                                                            >
                                                                <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                                                                {t('recentCodex.status.processing.short')}
                                                            </span>
                                                        ) : null}
                                                        <time
                                                            className="text-[11px] tabular-nums text-[var(--app-hint)]"
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
                            </section>
                        )
                    })}
                </div>
            )}
        </section>
    )
}
