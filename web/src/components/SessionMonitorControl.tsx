import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Activity, Play, Radar, RotateCcw, Send, XCircle } from 'lucide-react'
import type { Monitor, MonitorTargetSession } from '@hapi/protocol/monitoring'
import type { ApiClient } from '@/api/client'
import { useMonitors } from '@/hooks/queries/useMonitors'
import { useTranslation } from '@/lib/use-translation'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

type MonitorTarget = MonitorTargetSession & { machineId?: string }
type PendingConfirmation = { type: 'close' | 'continue'; monitor: Monitor } | null
type MonitorActivityTab = 'delivery' | 'trigger'
const EMPTY_MONITOR_IDS: readonly string[] = []

function sameTarget(left: MonitorTarget, right: MonitorTarget): boolean {
    return left.type === right.type
        && left.sessionId === right.sessionId
        && (left.type !== 'native-codex' || !left.machineId || !right.machineId || left.machineId === right.machineId)
}

export function isMonitorRelatedToSession(
    monitor: Monitor,
    targets: readonly MonitorTarget[],
    monitorIds: readonly string[] = EMPTY_MONITOR_IDS
): boolean {
    if (monitorIds.includes(monitor.id)) return true
    const configured = monitor.config.targetSession
        ? [{ ...monitor.config.targetSession, machineId: monitor.config.machineId }]
        : []
    const related = monitor.relatedSession ? [monitor.relatedSession] : []
    return [...configured, ...related].some((candidate) => targets.some((target) => sameTarget(candidate, target)))
}

export function useRelatedSessionMonitors(
    api: ApiClient,
    targets: readonly MonitorTarget[],
    monitorIds: readonly string[] = EMPTY_MONITOR_IDS
) {
    const { monitors, refetch } = useMonitors(api, { poll: false })
    const relatedMonitors = useMemo(
        () => monitors.filter((monitor) => isMonitorRelatedToSession(monitor, targets, monitorIds)),
        [monitorIds, monitors, targets]
    )
    return { relatedMonitors, refetch }
}

function formatTime(value: number | null | undefined, locale: string): string {
    if (!value) return '—'
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(new Date(value))
}

export function SessionMonitorControl(props: {
    api: ApiClient
    monitors: readonly Monitor[]
    refetch: () => Promise<unknown>
}) {
    const { t, locale } = useTranslation()
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const [busyId, setBusyId] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const [confirmation, setConfirmation] = useState<PendingConfirmation>(null)
    const [activityTabs, setActivityTabs] = useState<Record<string, MonitorActivityTab>>({})
    const displayLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US'
    const relatedMonitors = props.monitors

    if (relatedMonitors.length === 0) return null

    const run = async (monitor: Monitor, action: () => Promise<unknown>) => {
        if (busyId) return
        setBusyId(monitor.id)
        setActionError(null)
        try {
            await action()
            await props.refetch()
        } catch {
            setActionError(t('sessionMonitors.actionFailed'))
        } finally {
            setBusyId(null)
        }
    }

    const confirmAction = async () => {
        const target = confirmation
        if (!target) return
        await run(target.monitor, async () => {
            const incident = target.monitor.incident
            if (!incident) return
            if (target.type === 'continue') {
                if (!incident.planHash) return
                await props.api.approveMonitorIncident(target.monitor.id, incident.id, incident.planHash)
            } else {
                await props.api.closeMonitorIncident(target.monitor.id, incident.id)
            }
            setConfirmation(null)
        })
    }

    return (
        <>
            <div className="pointer-events-auto self-start pl-3" data-testid="session-monitor-control">
                <button
                    type="button"
                    className="flex h-8 items-center gap-1.5 rounded-full border border-emerald-400/45 bg-[var(--app-bg)]/95 px-2.5 text-xs font-semibold text-[var(--app-fg)] shadow-[0_10px_28px_rgba(16,185,129,0.16)] backdrop-blur-xl transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={t('sessionMonitors.badge', { count: relatedMonitors.length })}
                    aria-expanded={open}
                    onClick={() => setOpen(true)}
                >
                    <Radar className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                    <span>{relatedMonitors.length}</span>
                </button>
            </div>

            <BottomDrawer
                open={open}
                onOpenChange={setOpen}
                title={t('sessionMonitors.title')}
                subtitle={t('sessionMonitors.subtitle', { count: relatedMonitors.length })}
                fixedHeight
                desktopDialog
                density="compact"
                bodyClassName="space-y-3 px-3 pb-4"
            >
                {actionError ? <div role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{actionError}</div> : null}
                {relatedMonitors.map((monitor) => {
                    const incident = monitor.incident
                    const isRunning = incident ? ['starting', 'investigating', 'repair_starting', 'repairing'].includes(incident.state) : false
                    const canClose = Boolean(incident && !isRunning && incident.state !== 'closed')
                    const canContinue = Boolean(incident?.state === 'review' && incident.plan && incident.planHash && incident.approvalContext)
                    const canRetry = monitor.lastActivity?.outcome === 'deferred' && !incident
                    const busy = busyId === monitor.id
                    const activityTab = activityTabs[monitor.id] ?? 'delivery'
                    const openDetails = () => {
                        setOpen(false)
                        void navigate({ to: '/monitors/$monitorId', params: { monitorId: monitor.id } })
                    }
                    return (
                        <article key={monitor.id} className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.04)]" data-testid="session-monitor-card">
                            <div className="flex min-w-0 items-start gap-3">
                                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] ${monitor.config.enabled ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'}`} aria-hidden="true">
                                    <Radar className="h-5 w-5" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-2">
                                        <h3 className="min-w-0 text-sm font-semibold">
                                            <button type="button" disabled={Boolean(busyId)} onClick={openDetails} className="min-h-6 break-words text-left text-[var(--app-link)] underline-offset-4 hover:underline disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                                                {monitor.config.name}
                                            </button>
                                        </h3>
                                        <span className="shrink-0 rounded-full bg-[var(--app-subtle-bg)] px-2 py-1 text-[11px] font-semibold text-[var(--app-hint)]">{t(monitor.config.enabled ? 'sessionMonitors.enabled' : 'sessionMonitors.paused')}</span>
                                    </div>
                                    <p className="mt-1 text-xs text-[var(--app-hint)]">{t(`monitors.kind.${monitor.config.kind}`)}</p>
                                </div>
                            </div>

                            <div className="mt-3">
                                <div role="tablist" aria-label={monitor.config.name} className="grid grid-cols-2 rounded-xl bg-[var(--app-subtle-bg)] p-1">
                                    <button type="button" role="tab" aria-selected={activityTab === 'delivery'} onClick={() => setActivityTabs((current) => ({ ...current, [monitor.id]: 'delivery' }))} className={`flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold ${activityTab === 'delivery' ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)]'}`}><Send className="h-3.5 w-3.5" aria-hidden="true" />{t('sessionMonitors.lastDelivery')}</button>
                                    <button type="button" role="tab" aria-selected={activityTab === 'trigger'} onClick={() => setActivityTabs((current) => ({ ...current, [monitor.id]: 'trigger' }))} className={`flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold ${activityTab === 'trigger' ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)]'}`}><Activity className="h-3.5 w-3.5" aria-hidden="true" />{t('sessionMonitors.lastTrigger')}</button>
                                </div>
                                <div role="tabpanel" className="mt-2 rounded-xl bg-[var(--app-subtle-bg)] p-3">
                                    {activityTab === 'delivery' ? <>
                                        <p className="line-clamp-2 text-sm font-medium text-[var(--app-fg)]">{monitor.lastDelivery?.summary ?? t('sessionMonitors.none')}</p>
                                        <p className="mt-1 text-[11px] text-[var(--app-hint)]">{monitor.lastDelivery ? `${t(`monitors.incident.state.${monitor.lastDelivery.state}`)} · ${formatTime(monitor.lastDelivery.deliveredAt ?? monitor.lastDelivery.updatedAt, displayLocale)}` : '—'}</p>
                                    </> : <>
                                        <p className="line-clamp-2 text-sm font-medium text-[var(--app-fg)]">{monitor.lastActivity?.summary ?? t('sessionMonitors.none')}</p>
                                        <p className="mt-1 text-[11px] text-[var(--app-hint)]">{monitor.lastActivity ? `${t(`monitors.activity.outcome.${monitor.lastActivity.outcome}`)} · ${formatTime(monitor.lastActivity.createdAt, displayLocale)}` : '—'}</p>
                                    </>}
                                </div>
                            </div>

                            {canContinue || canRetry || canClose ? <div className="mt-3 flex flex-wrap gap-2 [&>button]:min-h-10 [&>button]:rounded-xl [&>button]:px-3 [&>button]:text-sm [&>button]:font-semibold">
                                {canContinue ? <button type="button" disabled={Boolean(busyId)} onClick={() => setConfirmation({ type: 'continue', monitor })} className="inline-flex items-center gap-1.5 bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-50"><Play className="h-4 w-4" aria-hidden="true" />{t('sessionMonitors.continueIncident')}</button> : null}
                                {canRetry && monitor.lastActivity ? <button type="button" disabled={Boolean(busyId)} onClick={() => void run(monitor, () => props.api.retriggerMonitorActivity(monitor.id, monitor.lastActivity!.id))} className="inline-flex items-center gap-1.5 bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-50"><RotateCcw className={`h-4 w-4 ${busy ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />{t('sessionMonitors.retry')}</button> : null}
                                {canClose ? <button type="button" disabled={Boolean(busyId)} onClick={() => setConfirmation({ type: 'close', monitor })} className="inline-flex items-center gap-1.5 bg-red-500/10 text-red-700 disabled:opacity-50 dark:text-red-300"><XCircle className="h-4 w-4" aria-hidden="true" />{t('sessionMonitors.closeIncident')}</button> : null}
                            </div> : null}
                        </article>
                    )
                })}
            </BottomDrawer>

            <ConfirmDialog
                isOpen={confirmation !== null}
                onClose={() => setConfirmation(null)}
                title={t(confirmation?.type === 'continue' ? 'monitors.incident.repairConfirm.title' : 'monitors.incident.closeConfirm.title')}
                description={t(confirmation?.type === 'continue' ? 'monitors.incident.repairConfirm.description' : 'monitors.incident.closeConfirm.description')}
                confirmLabel={t(confirmation?.type === 'continue' ? 'monitors.incident.repairConfirm.confirm' : 'monitors.incident.closeConfirm.confirm')}
                confirmingLabel={t(confirmation?.type === 'continue' ? 'monitors.incident.repairConfirm.confirming' : 'monitors.incident.closeConfirm.confirming')}
                onConfirm={confirmAction}
                isPending={Boolean(confirmation && busyId === confirmation.monitor.id)}
                destructive={confirmation?.type === 'close'}
            />
        </>
    )
}
