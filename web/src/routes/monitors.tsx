import { useCallback, useEffect, useState } from 'react'
import { Activity, ArrowLeft, CalendarClock, ChevronRight, MessageCircle, Plus, Radio, RefreshCw, Server } from 'lucide-react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { Monitor, MonitorConfig, MonitorDetail } from '@hapi/protocol/monitoring'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useMonitors } from '@/hooks/queries/useMonitors'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { getMonitorAggregate, getMonitorDisplayHealth } from '@/monitoring/presentation'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { MonitorEnabledSwitch } from '@/monitoring/MonitorEnabledSwitch'
import { MonitorSwipeRow } from '@/monitoring/MonitorSwipeRow'
import { MonitorForm } from '@/monitoring/MonitorForm'
import { MonitorTokenReveal } from '@/monitoring/MonitorTokenReveal'

type SessionTargetSearch = {
    type?: 'managed' | 'native-codex'
    sessionId?: string
    machineId?: string
}

function monitorHealthClass(status: ReturnType<typeof getMonitorDisplayHealth>): string {
    switch (status) {
        case 'up': return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
        case 'down': return 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200'
        case 'paused': return 'border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-200'
        case 'no-data': return 'border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-200'
        default: return 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
    }
}

function formatPercent(value: number | null): string | null {
    if (value === null || !Number.isFinite(value)) return null
    return `${Math.round(value * 1000) / 10}%`
}

function formatRelativeTime(timestamp: number | null, locale: string): string {
    if (!timestamp) return '—'
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
}

export function RelatedSessionLink(props: {
    monitor: Monitor
    t: (key: string, params?: Record<string, string | number>) => string
}) {
    const related = props.monitor.relatedSession
    if (!related) return null
    const className = 'inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl px-2 text-sm font-medium text-[var(--app-link)] transition-colors hover:bg-[var(--app-secondary-bg)] active:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
    if (related.type === 'native-codex') {
        if (!related.machineId) return null
        return <Link to="/sessions/codex/$codexSessionId" params={{ codexSessionId: related.sessionId }} search={{ machineId: related.machineId }} className={className}><MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" />{props.t('monitors.card.openRelatedSession')}</Link>
    }
    return <Link to="/sessions/$sessionId" params={{ sessionId: related.sessionId }} className={className}><MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" />{props.t('monitors.card.openRelatedSession')}</Link>
}

export function MonitorCard(props: { onToggle: (monitor: Monitor) => void; onDelete: (monitor: Monitor) => void; busy: boolean; monitor: Monitor; t: (key: string, params?: Record<string, string | number>) => string; locale: string }) {
    const aggregate = getMonitorAggregate(props.monitor)
    const status = getMonitorDisplayHealth(props.monitor)
    const isWebhook = props.monitor.config.kind !== 'http'
    const healthLabel = status === 'paused' ? props.t('monitors.status.paused') : isWebhook ? props.t(props.monitor.config.kind === 'scheduled' ? 'monitors.status.scheduled' : 'monitors.status.passive') : props.t(`monitors.status.${status}`)
    const healthClass = isWebhook && status !== 'paused' ? 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200' : monitorHealthClass(status)
    const metric = aggregate.passive
        ? props.t('monitors.card.events', { count: aggregate.sampleCount })
        : aggregate.successRate === null
            ? props.t('monitors.card.noKnownChecks')
            : props.t('monitors.card.successRate', { value: formatPercent(aggregate.successRate) ?? '—' })
    const Icon = props.monitor.config.kind === 'http' ? Activity : props.monitor.config.kind === 'scheduled' ? CalendarClock : Radio

    return <MonitorSwipeRow disabled={props.busy} onDelete={() => props.onDelete(props.monitor)} deleteLabel={props.t('monitors.delete')}><article className="overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
        <Link to="/monitors/$monitorId" params={{ monitorId: props.monitor.id }} className="group block p-4 transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
            <div className="flex min-w-0 items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${props.monitor.config.kind === 'http' ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : props.monitor.config.kind === 'scheduled' ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'}`} aria-hidden="true"><Icon className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center justify-between gap-2"><span className="break-words text-base font-semibold text-[var(--app-fg)]">{props.monitor.config.name}</span><span className={`shrink-0 rounded-full border px-2 py-1 text-xs font-semibold ${healthClass}`}>{healthLabel}</span></span><span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--app-hint)]"><span>{props.t(`monitors.kind.${props.monitor.config.kind}`)}</span><span aria-hidden="true">·</span><span>{metric}</span></span><span className="mt-2 flex min-w-0 items-center justify-between gap-2 text-xs text-[var(--app-hint)]"><span className="truncate">{isWebhook ? props.t('monitors.card.lastTriggered') : props.monitor.lastLatencyMs === null ? props.t('monitors.card.noLatency') : props.t('monitors.card.latency', { value: Math.round(props.monitor.lastLatencyMs) })}</span><span className="shrink-0 tabular-nums">{formatRelativeTime(props.monitor.lastCheckedAt, props.locale)}</span></span></span>
                <ChevronRight className="mt-2 h-5 w-5 shrink-0 text-[var(--app-hint)] transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </div>
        </Link>
        <div className="flex items-center justify-between gap-4 border-t border-[var(--app-border)] px-4 py-1.5"><div className="min-w-0"><RelatedSessionLink monitor={props.monitor} t={props.t} /></div><MonitorEnabledSwitch enabled={props.monitor.config.enabled} disabled={props.busy} label={props.t('monitors.form.enabled')} onChange={() => props.onToggle(props.monitor)} /></div>
    </article></MonitorSwipeRow>
}

export default function MonitorsPage() {
    const { api } = useAppContext()
    const { t, locale } = useTranslation()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const { monitors, isLoading, error, refetch } = useMonitors(api)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [deleting, setDeleting] = useState<Monitor | null>(null)
    const { addToast } = useToast()
    const toggle = async (monitor: Monitor) => {
        if (busyId) return
        setBusyId(monitor.id)
        try {
            await api.updateMonitor(monitor.id, { ...monitor.config, enabled: !monitor.config.enabled })
            await refetch()
        } catch { addToast({ title: t('monitors.action.failed'), kind: 'error' }) }
        finally { setBusyId(null) }
    }
    const remove = async () => {
        if (!deleting || busyId) return
        setBusyId(deleting.id)
        try {
            await api.deleteMonitor(deleting.id)
            setDeleting(null)
            await refetch()
        } finally { setBusyId(null) }
    }

    const refresh = useCallback(async () => {
        setIsRefreshing(true)
        try {
            await refetch()
        } finally {
            setIsRefreshing(false)
        }
    }, [refetch])

    return <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
        <header className="border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]"><div className="mx-auto flex max-w-[760px] items-center gap-3"><button type="button" onClick={goBack} aria-label={t('monitors.back')} title={t('monitors.back')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></button><div className="min-w-0 flex-1"><h1 className="text-base font-semibold leading-5 text-[var(--app-fg)]">{t('monitors.title')}</h1></div><button type="button" onClick={() => void refresh()} disabled={isRefreshing} aria-label={t('monitors.refresh')} title={t('monitors.refresh')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" /></button><button type="button" onClick={() => navigate({ to: '/monitors/new' })} aria-label={t('monitors.create.action')} title={t('monitors.create.action')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--app-button)] text-[var(--app-button-text)] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><Plus className="h-5 w-5" aria-hidden="true" /></button></div></header>
        <main className="app-scroll-y flex-1 px-3 pb-[calc(1rem+var(--app-safe-area-bottom))] pt-3"><div className="mx-auto max-w-[760px] space-y-4">{error ? <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error.message}</div> : null}{isLoading ? <div className="rounded-2xl border border-[var(--app-border)] p-5 text-sm text-[var(--app-hint)]">{t('monitors.loading')}</div> : null}{!isLoading && !error && monitors.length === 0 ? <section className="rounded-[22px] border border-dashed border-[var(--app-border)] p-6 text-center"><Server className="mx-auto h-7 w-7 text-[var(--app-hint)]" aria-hidden="true" /><h2 className="mt-3 text-sm font-semibold text-[var(--app-fg)]">{t('monitors.empty.title')}</h2><p className="mt-1 text-sm leading-6 text-[var(--app-hint)]">{t('monitors.empty.body')}</p><button type="button" onClick={() => navigate({ to: '/monitors/new' })} className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-[var(--app-button)] px-4 text-sm font-semibold text-[var(--app-button-text)] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><Plus className="h-4 w-4" aria-hidden="true" />{t('monitors.create.action')}</button></section> : null}<div className="space-y-3">{monitors.map((monitor) => <MonitorCard key={monitor.id} onToggle={monitor => void toggle(monitor)} onDelete={setDeleting} busy={busyId !== null} monitor={monitor} t={t} locale={locale === 'zh-CN' ? 'zh-CN' : 'en-US'} />)}</div></div></main>
        <ConfirmDialog isOpen={Boolean(deleting)} onClose={() => setDeleting(null)} title={t('monitors.delete')} description={t('monitors.delete.confirm', { name: deleting?.config.name ?? '' })} confirmLabel={t('monitors.delete')} confirmingLabel={t('monitors.deleting')} isPending={busyId !== null} onConfirm={remove} destructive />
    </div>
}

export function MonitorCreatePage() {
    const { api, baseUrl } = useAppContext()
    const { t, locale } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const search = useSearch({ from: '/monitors/new' }) as SessionTargetSearch
    const [resolvedConfig, setResolvedConfig] = useState<MonitorConfig | null>(null)
    const [targetError, setTargetError] = useState<string | null>(null)
    const [loadingTarget, setLoadingTarget] = useState(false)
    const [created, setCreated] = useState<{ monitor: MonitorDetail; token: string | null } | null>(null)
    const target = search.type && search.sessionId && (search.type === 'managed' || search.machineId)
        ? { type: search.type, sessionId: search.sessionId, ...(search.machineId ? { machineId: search.machineId } : {}) }
        : null
    const targetKey = target ? `${target.type}:${target.sessionId}:${target.machineId ?? ''}` : 'unbound'

    useEffect(() => {
        let cancelled = false
        if (!target) {
            setResolvedConfig(null)
            setTargetError(null)
            setLoadingTarget(false)
            return () => { cancelled = true }
        }
        setLoadingTarget(true)
        setTargetError(null)
        void api.getMonitorSessionTarget(target).then((result) => {
            if (!cancelled) setResolvedConfig(result.config)
        }).catch((cause) => {
            if (!cancelled) setTargetError(cause instanceof Error ? cause.message : t('monitors.create.targetFailed'))
        }).finally(() => {
            if (!cancelled) setLoadingTarget(false)
        })
        return () => { cancelled = true }
    }, [api, targetKey, t])

    const createMonitor = useCallback(async (config: MonitorConfig) => {
        const result = await api.createMonitor(config)
        await queryClient.invalidateQueries({ queryKey: queryKeys.monitors })
        setCreated(result)
        addToast({ title: t('monitors.toast.created'), kind: 'success' })
    }, [addToast, api, queryClient, t])

    return <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
        <header className="border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]"><div className="mx-auto flex max-w-[760px] items-center gap-3"><button type="button" onClick={() => navigate({ to: '/monitors' })} aria-label={t('monitors.back')} title={t('monitors.back')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></button><div className="min-w-0 flex-1"><h1 className="text-base font-semibold leading-5 text-[var(--app-fg)]">{t('monitors.create.title')}</h1></div></div></header>
        <main className="app-scroll-y flex-1 px-3 pb-[calc(1rem+var(--app-safe-area-bottom))] pt-3"><div className="mx-auto max-w-[760px] space-y-4">{loadingTarget ? <div className="rounded-2xl border border-[var(--app-border)] p-5 text-sm text-[var(--app-hint)]">{t('monitors.create.loadingTarget')}</div> : null}{targetError ? <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{targetError}</div> : null}{created ? <div className="space-y-4">{created.token ? <MonitorTokenReveal token={created.token} baseUrl={baseUrl} t={t} /> : null}<section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><h2 className="text-sm font-semibold text-[var(--app-fg)]">{t('monitors.create.savedTitle')}</h2><Link to="/monitors/$monitorId" params={{ monitorId: created.monitor.id }} className="mt-3 inline-flex h-11 items-center rounded-xl bg-[var(--app-button)] px-4 text-sm font-semibold text-[var(--app-button-text)] transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">{t('monitors.create.open')}</Link></section></div> : !loadingTarget && !targetError ? <MonitorForm key={targetKey} api={api} baseUrl={baseUrl} initialConfig={resolvedConfig ?? undefined} lockedBinding={Boolean(target)} isEditing={false} submitLabel={t('monitors.create.action')} savingLabel={t('monitors.create.saving')} onSubmit={createMonitor} onCancel={() => navigate({ to: '/monitors' })} t={t} locale={locale} /> : null}</div></main>
    </div>
}
