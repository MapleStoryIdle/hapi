import { useState } from 'react'
import { CheckCircle2, ClipboardCheck, ExternalLink, FileText, XCircle } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { MonitorApprovalContext, MonitorIncident } from '@hapi/protocol/monitoring'
import type { ApiClient } from '@/api/client'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

type Translate = (key: string, params?: Record<string, string | number>) => string

function formatIncidentTime(timestamp: number, locale: string): string {
    return new Intl.DateTimeFormat(locale, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(timestamp))
}

/**
 * This is copied from the incident's server-bound, hash-bound approval
 * context, never from the current monitor configuration. A later
 * configuration edit must not make a reviewed repair look as though it
 * targets somewhere else.
 */
function ApprovalTargetContext(props: { context: MonitorApprovalContext; t: Translate }) {
    const target = props.context
    const defaultValue = props.t('monitors.incident.approvalTargetDefault')

    return (
        <section className="mt-3 rounded-xl border border-amber-400/50 bg-amber-500/10 p-3 text-sm leading-5 text-[var(--app-fg)]" data-testid="monitor-approval-context">
            <h4 className="font-semibold text-amber-900 dark:text-amber-100">{props.t('monitors.incident.approvalTarget')}</h4>
            <p className="mt-0.5 text-xs leading-5 text-amber-800 dark:text-amber-200">{props.t('monitors.incident.approvalTargetHint')}</p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                <div className="min-w-0"><dt className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.incident.targetMachine')}</dt><dd className="mt-0.5 break-words font-mono text-xs [overflow-wrap:anywhere]">{target.machineId}</dd></div>
                <div className="min-w-0"><dt className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.incident.targetAgent')}</dt><dd className="mt-0.5 text-xs">{target.agent === 'codex' ? 'Codex' : 'Claude'}</dd></div>
                <div className="col-span-2 min-w-0"><dt className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.incident.targetDirectory')}</dt><dd className="mt-0.5 break-words font-mono text-xs [overflow-wrap:anywhere]">{target.directory}</dd></div>
                <div className="min-w-0"><dt className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.incident.targetModel')}</dt><dd className="mt-0.5 break-words text-xs [overflow-wrap:anywhere]">{target.model || defaultValue}</dd></div>
                <div className="min-w-0"><dt className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.incident.targetReasoning')}</dt><dd className="mt-0.5 text-xs">{target.reasoningEffort || defaultValue}</dd></div>
                <div className="col-span-2 min-w-0"><dt className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.incident.targetPermission')}</dt><dd className="mt-0.5 text-xs">{target.permissionMode}</dd></div>
            </dl>
        </section>
    )
}

export function MonitorIncidentCard(props: {
    api: ApiClient
    monitorId: string
    incident: MonitorIncident
    locale: string
    t: Translate
    onChanged: () => Promise<void>
    compact?: boolean
}) {
    const [showPlan, setShowPlan] = useState(false)
    const [repairTarget, setRepairTarget] = useState<MonitorIncident | null>(null)
    const [closeTarget, setCloseTarget] = useState<MonitorIncident | null>(null)
    const [pendingAction, setPendingAction] = useState<'repair' | 'close' | null>(null)
    const canApprove = props.incident.state === 'review' && Boolean(
        props.incident.plan && props.incident.planHash && props.incident.approvalContext
    )
    const isRunning = ['starting', 'investigating', 'repair_starting', 'repairing'].includes(props.incident.state)
    const canClose = !isRunning && props.incident.state !== 'closed'
    const isCompleted = props.incident.state === 'completed'

    const approveRepair = async () => {
        const target = repairTarget
        if (!target?.planHash) throw new Error(props.t('monitors.incident.planChanged'))
        setPendingAction('repair')
        try {
            // Capture exactly the hash reviewed when the dialog opened. The Hub
            // rejects it if a refreshed plan has replaced that immutable plan.
            await props.api.approveMonitorIncident(props.monitorId, target.id, target.planHash)
            await props.onChanged()
        } finally {
            setPendingAction(null)
        }
    }

    const closeIncident = async () => {
        const target = closeTarget
        if (!target) return
        setPendingAction('close')
        try {
            await props.api.closeMonitorIncident(props.monitorId, target.id)
            await props.onChanged()
        } finally {
            setPendingAction(null)
        }
    }

    return (
        <>
            <article className={`rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] ${props.compact ? 'p-3' : 'p-4'} shadow-[0_1px_4px_rgba(0,0,0,0.03)]`} data-testid="monitor-incident-card">
                <div className="flex min-w-0 items-start gap-3">
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${props.incident.state === 'completed' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : props.incident.state === 'needs_attention' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`} aria-hidden="true">
                        {props.incident.state === 'completed' ? <CheckCircle2 className="h-5 w-5" /> : <ClipboardCheck className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="min-w-0 break-words text-sm font-semibold text-[var(--app-fg)]">{props.incident.summary}</h3>
                            <span className="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-xs font-semibold text-[var(--app-hint)]">{props.t(`monitors.incident.state.${props.incident.state}`)}</span>
                        </div>
                        <p className="mt-1 text-xs text-[var(--app-hint)]">{formatIncidentTime(props.incident.updatedAt, props.locale)}</p>
                        {props.incident.error ? <p role="alert" className="mt-2 rounded-xl bg-red-500/10 px-2.5 py-2 text-xs leading-5 text-red-800 dark:text-red-200">{props.incident.error}</p> : null}
                    </div>
                </div>

                {props.incident.plan ? <div className="mt-3">
                    <button type="button" onClick={() => setShowPlan((visible) => !visible)} aria-expanded={showPlan} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[var(--app-border)] px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><FileText className="h-4 w-4" aria-hidden="true" />{showPlan ? props.t('monitors.incident.hidePlan') : props.t('monitors.incident.viewPlan')}</button>
                    {showPlan ? <div className="mt-2 min-w-0 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3"><MarkdownRenderer content={props.incident.plan} standalone className="text-sm leading-6 text-[var(--app-fg)]" />{props.incident.approvalContext ? <ApprovalTargetContext context={props.incident.approvalContext} t={props.t} /> : props.incident.state === 'review' ? <p role="alert" className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">{props.t('monitors.incident.approvalTargetMissing')}</p> : null}</div> : null}
                </div> : null}

                <div className="mt-3 grid grid-cols-2 gap-2 empty:hidden [&>*]:min-h-11 [&>*]:h-auto [&>*]:justify-center [&>*]:py-2 [&>*]:text-center [&_svg]:shrink-0">
                    {!props.compact && canApprove && showPlan ? <button type="button" onClick={() => setRepairTarget(props.incident)} disabled={pendingAction !== null} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[var(--app-button)] px-3 text-sm font-semibold text-[var(--app-button-text)] transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" data-testid="monitor-confirm-repair"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{props.t('monitors.incident.confirmRepair')}</button> : null}
                    {!props.compact && canClose ? <button type="button" onClick={() => setCloseTarget(props.incident)} disabled={pendingAction !== null} className={`inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${isCompleted ? 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-85' : 'border border-red-400/50 text-red-700 hover:bg-red-500/10 dark:text-red-300'}`}><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{props.t(isCompleted ? 'monitors.incident.acknowledge' : 'monitors.incident.close')}</button> : null}
                    {props.incident.sessionId ? <Link to="/sessions/$sessionId" params={{ sessionId: props.incident.sessionId }} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[var(--app-border)] px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ExternalLink className="h-4 w-4" aria-hidden="true" />{props.t('monitors.incident.investigationSession')}</Link> : null}
                    {props.incident.repairSessionId ? <Link to="/sessions/$sessionId" params={{ sessionId: props.incident.repairSessionId }} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[var(--app-border)] px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ExternalLink className="h-4 w-4" aria-hidden="true" />{props.t('monitors.incident.repairSession')}</Link> : null}
                </div>
                {!props.compact && isRunning ? <p className="mt-3 rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-xs leading-5 text-[var(--app-hint)]">{props.t('monitors.incident.closeRunningHint')}</p> : null}
            </article>

            <ConfirmDialog
                isOpen={repairTarget !== null}
                onClose={() => setRepairTarget(null)}
                title={props.t('monitors.incident.repairConfirm.title')}
                description={repairTarget?.approvalContext ? <><p className="whitespace-pre-line">{props.t('monitors.incident.repairConfirm.description')}</p><ApprovalTargetContext context={repairTarget.approvalContext} t={props.t} /></> : props.t('monitors.incident.repairConfirm.description')}
                confirmLabel={props.t('monitors.incident.repairConfirm.confirm')}
                confirmingLabel={props.t('monitors.incident.repairConfirm.confirming')}
                onConfirm={approveRepair}
                isPending={pendingAction === 'repair'}
                contentClassName="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain"
            />
            <ConfirmDialog
                isOpen={closeTarget !== null}
                onClose={() => setCloseTarget(null)}
                title={props.t(isCompleted ? 'monitors.incident.acknowledgeConfirm.title' : 'monitors.incident.closeConfirm.title')}
                description={props.t(isCompleted ? 'monitors.incident.acknowledgeConfirm.description' : 'monitors.incident.closeConfirm.description')}
                confirmLabel={props.t(isCompleted ? 'monitors.incident.acknowledgeConfirm.confirm' : 'monitors.incident.closeConfirm.confirm')}
                confirmingLabel={props.t(isCompleted ? 'monitors.incident.acknowledgeConfirm.confirming' : 'monitors.incident.closeConfirm.confirming')}
                onConfirm={closeIncident}
                isPending={pendingAction === 'close'}
                destructive={!isCompleted}
            />
        </>
    )
}
