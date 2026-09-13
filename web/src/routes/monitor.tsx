import { useCallback, useMemo, useState } from 'react'
import { Activity, ArrowLeft, CircleAlert, ClipboardList, RefreshCw, Settings2, Waves } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { MonitorActivity, MonitorCallStats, MonitorConfig } from '@hapi/protocol/monitoring'
import { useAppContext } from '@/lib/app-context'
import { useMonitor } from '@/hooks/queries/useMonitors'
import { useMachines } from '@/hooks/queries/useMachines'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { MonitorWebhookAccess } from '@/monitoring/MonitorWebhookAccess'
import { MonitorForm } from '@/monitoring/MonitorForm'
import { MonitorIncidentCard } from '@/monitoring/MonitorIncidentCard'
import { MonitorActivityList } from '@/monitoring/MonitorActivityList'
import { MonitorStatusTimeline } from '@/monitoring/MonitorStatusTimeline'
import { getMonitorAggregate, getMonitorDisplayHealth } from '@/monitoring/presentation'
import { RelatedSessionLink } from './monitors'

type Tab = 'overview' | 'events' | 'configuration'

function formatPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—'
    return `${Math.round(value * 1000) / 10}%`
}

function formatNumber(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—'
    return String(Math.round(value))
}

function statusClass(status: ReturnType<typeof getMonitorDisplayHealth>): string {
    switch (status) {
        case 'up': return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
        case 'down': return 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200'
        case 'paused': return 'border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-200'
        case 'no-data': return 'border-slate-400/50 bg-slate-500/10 text-slate-700 dark:text-slate-200'
        default: return 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
    }
}

function OverviewMetric(props: { label: string; value: string; detail: string }) {
    return (
        <div className="min-w-0 px-3 py-3" title={props.detail}>
            <div className="text-xs font-medium text-[var(--app-hint)]">{props.label}</div>
            <div className="mt-1 break-words text-lg font-semibold tabular-nums text-[var(--app-fg)]">{props.value}</div>
            
        </div>
    )
}

function CallResultStats(props: { stats: MonitorCallStats; kind: MonitorConfig['kind']; t: (key: string) => string }) {
    const values = props.kind === 'webhook'
            ? [['total', props.stats.total], ['dispatched', props.stats.dispatched], ['deferred', props.stats.deferred], ['duplicate', props.stats.duplicate]] as const
            : [['total', props.stats.total], ['dispatched', props.stats.dispatched], ['deferred', props.stats.deferred]] as const
    return <section aria-labelledby="monitor-result-stats" className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3.5">
        <h2 id="monitor-result-stats" className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.results.title')}</h2>
        <div className={`mt-3 grid ${values.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}>
            {values.map(([key, value]) => <div key={key} className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2"><div className="text-[11px] font-medium text-[var(--app-hint)]">{props.t(`monitors.results.${key}`)}</div><div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--app-fg)]">{value}</div></div>)}
        </div>
    </section>
}

export default function MonitorDetailPage() {
    const { api, baseUrl } = useAppContext()
    const { t, locale } = useTranslation()
    const { addToast } = useToast()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { monitorId } = useParams({ from: '/monitors/$monitorId' })
    const { monitor, isLoading, error, refetch } = useMonitor(api, monitorId)
    const { machines } = useMachines(api, Boolean(monitor))
    const [tab, setTab] = useState<Tab>('overview')
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [isChecking, setIsChecking] = useState(false)
    const [isRotating, setIsRotating] = useState(false)
    const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false)
    const [rotatedToken, setRotatedToken] = useState<string | null>(null)
    const [retryingActivityId, setRetryingActivityId] = useState<string | null>(null)

    const refreshMonitor = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.monitor(monitorId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.monitors })
        ])
        await refetch()
    }, [monitorId, queryClient, refetch])

    const refresh = useCallback(async () => {
        setIsRefreshing(true)
        try {
            await refreshMonitor()
        } finally {
            setIsRefreshing(false)
        }
    }, [refreshMonitor])

    const runCheck = useCallback(async () => {
        if (isChecking) return
        setIsChecking(true)
        try {
            const result = await api.checkMonitor(monitorId)
            addToast({ title: t(result.deferred ? 'monitors.toast.testDeferred' : 'monitors.toast.testQueued'), kind: result.deferred ? 'info' : 'success' })
            await refreshMonitor()
        } catch (cause) {
            addToast({ title: t('monitors.toast.checkFailed'), body: cause instanceof Error ? cause.message : '', kind: 'error' })
        } finally {
            setIsChecking(false)
        }
    }, [addToast, api, isChecking, monitorId, refreshMonitor, t])

    const retriggerActivity = useCallback(async (activity: MonitorActivity) => {
        if (retryingActivityId) return
        setRetryingActivityId(activity.id)
        try {
            await api.retriggerMonitorActivity(monitorId, activity.id)
            await refreshMonitor()
            addToast({ title: t('monitors.toast.retriggered'), kind: 'success' })
        } catch (cause) {
            addToast({ title: t('monitors.toast.retriggerFailed'), body: cause instanceof Error ? cause.message : '', kind: 'error' })
        } finally {
            setRetryingActivityId(null)
        }
    }, [addToast, api, monitorId, refreshMonitor, retryingActivityId, t])

    const saveConfig = useCallback(async (config: MonitorConfig) => {
        await api.updateMonitor(monitorId, config)
        await refreshMonitor()
        addToast({ title: t('monitors.toast.saved'), kind: 'success' })
    }, [addToast, api, monitorId, refreshMonitor, t])

    const rotateToken = useCallback(async () => {
        setIsRotating(true)
        try {
            const result = await api.rotateMonitorToken(monitorId)
            setRotatedToken(result.token)
            await refreshMonitor()
            addToast({ title: t('monitors.toast.tokenRotated'), kind: 'success' })
        } finally {
            setIsRotating(false)
        }
    }, [addToast, api, monitorId, refreshMonitor, t])

    const selectTab = (nextTab: Tab) => {
        if (nextTab !== 'configuration') setRotatedToken(null)
        setTab(nextTab)
    }

    const incidents = useMemo(
        () => monitor ? [...monitor.incidents].sort((left, right) => right.updatedAt - left.updatedAt) : [],
        [monitor]
    )

    if (isLoading) {
        return <div className="flex h-full items-center justify-center bg-[var(--app-bg)] px-4 text-sm text-[var(--app-hint)]">{t('monitors.loading')}</div>
    }

    if (!monitor) {
        return (
            <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
                <header className="border-b border-[var(--app-border)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]"><button type="button" onClick={() => navigate({ to: '/monitors' })} className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" aria-label={t('monitors.back')}><ArrowLeft className="h-5 w-5" aria-hidden="true" /></button></header>
                <main className="p-4"><div role="alert" className="mx-auto max-w-[760px] rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error?.message ?? t('monitors.notFound')}</div></main>
            </div>
        )
    }

    const aggregate = getMonitorAggregate(monitor)
    const health = getMonitorDisplayHealth(monitor)
    const isWebhook = monitor.config.kind !== 'http'
    const machine = machines.find((item) => item.id === monitor.config.machineId)
    const machineOffline = machine?.active === false
    const displayLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
    const healthLabel = health === 'paused' ? t('monitors.status.paused') : isWebhook ? t(monitor.config.kind === 'scheduled' ? 'monitors.status.scheduled' : 'monitors.status.passive') : t(`monitors.status.${health}`)
    const healthTone = isWebhook && health !== 'paused' ? 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-200' : statusClass(health)

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]">
                <div className="mx-auto flex max-w-[760px] items-center gap-3">
                    <button type="button" onClick={() => navigate({ to: '/monitors' })} aria-label={t('monitors.back')} title={t('monitors.back')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ArrowLeft className="h-5 w-5" aria-hidden="true" /></button>
                    <div className="min-w-0 flex-1"><h1 className="truncate text-base font-semibold leading-5 text-[var(--app-fg)]">{monitor.config.name}</h1><p className="mt-0.5 text-xs text-[var(--app-hint)]">{t(`monitors.kind.${monitor.config.kind}`)}</p></div>
                    <button type="button" onClick={() => void refresh()} disabled={isRefreshing} aria-label={t('monitors.refresh')} title={t('monitors.refresh')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" /></button>
                </div>
            </header>

            <main className="app-scroll-y flex-1 px-3 pb-[calc(1rem+var(--app-safe-area-bottom))] pt-3">
                <div className="mx-auto max-w-[760px] space-y-4">
                    <div role="tablist" aria-label={t('monitors.tabs.label')} className="grid grid-cols-3 gap-1 rounded-2xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1">
                        {(['overview', 'events', 'configuration'] as const).map((item) => {
                            const selected = tab === item
                            const Icon = item === 'overview' ? Activity : item === 'events' ? ClipboardList : Settings2
                            return <button key={item} type="button" role="tab" aria-selected={selected} aria-controls={`monitor-${item}`} onClick={() => selectTab(item)} className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${selected ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'}`}><Icon className="h-4 w-4" aria-hidden="true" />{t(`monitors.tabs.${item}`)}</button>
                        })}
                    </div>

                    {tab === 'overview' ? <section id="monitor-overview" role="tabpanel" className="space-y-4">
                        <section className="px-1">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className={`rounded-full border px-2.5 py-1.5 text-xs font-semibold ${healthTone}`}>{healthLabel}</span>
                                <div className="flex flex-wrap items-center justify-end gap-1"><RelatedSessionLink monitor={monitor} t={t} /><button type="button" onClick={() => void runCheck()} disabled={isChecking} className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] active:bg-[var(--app-subtle-bg)] disabled:cursor-wait disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><Waves className="h-4 w-4" aria-hidden="true" />{isChecking ? t('monitors.overview.checking') : t('monitors.overview.testNow')}</button></div>
                            </div>
                        </section>

                        {machineOffline ? <div className="rounded-xl border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-800 dark:text-amber-200"><CircleAlert className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden="true" />{t('monitors.status.runnerOfflineHint')}</div> : null}

                        {!isWebhook ? <div className="grid grid-cols-3 divide-x divide-[var(--app-border)] overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)]">
                                <OverviewMetric label={t('monitors.aggregate.success')} value={formatPercent(aggregate.successRate)} detail={aggregate.successRate === null ? t('monitors.aggregate.noKnownChecks') : t('monitors.aggregate.knownChecks', { count: aggregate.sampleCount })} />
                                <OverviewMetric label={t('monitors.aggregate.coverage')} value={aggregate.coverage === null ? '—' : `${Math.round(aggregate.coverage * 100)}%`} detail={aggregate.expectedChecks === null ? t('monitors.aggregate.noKnownChecks') : t('monitors.aggregate.sampleCoverage', { samples: aggregate.sampleCount, expected: aggregate.expectedChecks })} />
                                <OverviewMetric label={t('monitors.aggregate.latency')} value={aggregate.latencyMs === null ? '—' : `${formatNumber(aggregate.latencyMs)} ms`} detail={aggregate.latencyMs === null ? t('monitors.aggregate.noLatency') : t('monitors.aggregate.averageLatency')} />
                        </div> : null}

                        <MonitorStatusTimeline monitor={monitor} locale={displayLocale} t={t} />

                        {isWebhook ? <CallResultStats stats={monitor.callStats} kind={monitor.config.kind} t={t} /> : null}

                        {monitor.lastError ? <div role="alert" className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm leading-6 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"><span className="font-semibold">{t('monitors.overview.lastError')}.</span> {monitor.lastError}</div> : null}
                        {monitor.incident ? <section aria-labelledby="monitor-current-incident"><h2 id="monitor-current-incident" className="mb-2 text-sm font-semibold text-[var(--app-fg)]">{t('monitors.incident.current')}</h2><MonitorIncidentCard api={api} monitorId={monitor.id} incident={monitor.incident} locale={displayLocale} t={t} onChanged={refreshMonitor} /></section> : null}
                        <section aria-labelledby="monitor-recent-activity"><div className="mb-2 flex items-center justify-between gap-3 px-1"><h2 id="monitor-recent-activity" className="text-sm font-semibold text-[var(--app-fg)]">{t('monitors.activity.recent')}</h2><button type="button" onClick={() => selectTab('events')} className="min-h-11 px-2 text-sm font-medium text-[var(--app-link)]">{t('monitors.activity.viewAll')}</button></div><MonitorActivityList activities={monitor.activities} limit={3} locale={displayLocale} t={t} /></section>
                    </section> : null}

                    {tab === 'events' ? <section id="monitor-events" role="tabpanel" className="space-y-4"><section><h2 className="mb-2 px-1 text-sm font-semibold text-[var(--app-fg)]">{t('monitors.activity.title')}</h2><MonitorActivityList activities={monitor.activities} locale={displayLocale} t={t} retryingId={retryingActivityId} onRetrigger={(activity) => void retriggerActivity(activity)} /></section><section><h2 className="mb-2 px-1 text-sm font-semibold text-[var(--app-fg)]">{t('monitors.events.history')}</h2>{incidents.filter((incident) => incident.id !== monitor.incident?.id).length === 0 ? <div className="rounded-2xl border border-dashed border-[var(--app-border)] p-6 text-center text-sm text-[var(--app-hint)]">{t('monitors.events.empty')}</div> : incidents.filter((incident) => incident.id !== monitor.incident?.id).map((incident) => <MonitorIncidentCard key={incident.id} api={api} monitorId={monitor.id} incident={incident} locale={displayLocale} t={t} onChanged={refreshMonitor} compact />)}</section></section> : null}

                    {tab === 'configuration' ? <section id="monitor-configuration" role="tabpanel" className="space-y-4">
                        {monitor.config.kind === 'webhook' ? <MonitorWebhookAccess key={rotatedToken ?? monitor.id} api={api} monitorId={monitor.id} baseUrl={baseUrl} t={t} onRotate={() => setRotateConfirmOpen(true)} isRotating={isRotating} /> : null}
                        <MonitorForm key={monitor.id} api={api} baseUrl={baseUrl} initialConfig={monitor.config} lockedBinding={Boolean(monitor.config.targetSession)} isEditing submitLabel={t('monitors.form.save')} savingLabel={t('monitors.form.saving')} onSubmit={saveConfig} t={t} locale={displayLocale} />
                    </section> : null}
                </div>
            </main>

            <ConfirmDialog isOpen={rotateConfirmOpen} onClose={() => setRotateConfirmOpen(false)} title={t('monitors.token.rotateConfirm.title')} description={t('monitors.token.rotateConfirm.description')} confirmLabel={t('monitors.token.rotateConfirm.confirm')} confirmingLabel={t('monitors.token.rotateConfirm.confirming')} onConfirm={rotateToken} isPending={isRotating} destructive />
        </div>
    )
}
