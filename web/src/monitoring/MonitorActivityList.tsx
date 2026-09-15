import { useState } from 'react'
import { Activity, CalendarClock, FileJson, Play, Radio, RotateCcw } from 'lucide-react'
import type { MonitorActivity } from '@hapi/protocol/monitoring'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Translate = (key: string, params?: Record<string, string | number>) => string

function formatTime(value: number, locale: string): string {
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(value)
}

function detailsForDisplay(details: string): string {
    try {
        return JSON.stringify(JSON.parse(details), null, 2)
    } catch {
        return details
    }
}

function outcomeClass(outcome: MonitorActivity['outcome']): string {
    if (outcome === 'deferred') return 'bg-amber-500/10 text-amber-800 dark:text-amber-200'
    if (outcome === 'failed') return 'bg-red-500/10 text-red-700 dark:text-red-300'
    if (outcome === 'ok') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    if (outcome === 'duplicate') return 'bg-slate-500/10 text-slate-700 dark:text-slate-200'
    if (outcome === 'ignored') return 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
    return 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
}

function sourceClass(source: MonitorActivity['source']): string {
    if (source === 'probe') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    if (source === 'webhook') return 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
    if (source === 'scheduled') return 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
    return 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
}

function ActivityDetailDialog(props: { activity: MonitorActivity | null; locale: string; t: Translate; onOpenChange: (open: boolean) => void }) {
    const activity = props.activity
    return (
        <Dialog open={activity !== null} onOpenChange={props.onOpenChange}>
            <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{props.t('monitors.activity.detail.title')}</DialogTitle>
                    <DialogDescription>{activity ? `${props.t(`monitors.activity.source.${activity.source}`)} · ${formatTime(activity.createdAt, props.locale)}` : ''}</DialogDescription>
                </DialogHeader>
                {activity ? (
                    <div className="mt-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="break-words text-sm font-semibold text-[var(--app-fg)]">{activity.summary}</h3>
                            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${outcomeClass(activity.outcome)}`}>{props.t(`monitors.activity.outcome.${activity.outcome}`)}</span>
                        </div>
                        {activity.details ? <pre className="max-h-[50dvh] overflow-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-xs leading-5 text-[var(--app-fg)] [overflow-wrap:anywhere] whitespace-pre-wrap">{detailsForDisplay(activity.details)}</pre> : <p className="text-sm text-[var(--app-hint)]">{props.t('monitors.activity.detail.empty')}</p>}
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    )
}

export function MonitorActivityList(props: { activities: MonitorActivity[]; locale: string; t: Translate; limit?: number; retryingId?: string | null; onRetrigger?: (activity: MonitorActivity) => void }) {
    const [detail, setDetail] = useState<MonitorActivity | null>(null)
    const activities = typeof props.limit === 'number' ? props.activities.slice(0, props.limit) : props.activities
    if (activities.length === 0) return <div className="rounded-[22px] border border-dashed border-[var(--app-border)] bg-[var(--app-bg)] px-6 py-10 text-center"><span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-hint)]" aria-hidden="true"><Activity className="h-5 w-5" /></span><p className="mt-3 text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.activity.empty')}</p><p className="mt-1 text-xs leading-5 text-[var(--app-hint)]">{props.t('monitors.activity.emptyHint')}</p></div>

    return (
        <>
            <div className="overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
                {activities.map((activity, index) => {
                    const Icon = activity.source === 'probe' ? Activity : activity.source === 'webhook' ? Radio : activity.source === 'scheduled' ? CalendarClock : Play
                    const deferred = activity.outcome === 'deferred'
                    return (
                        <article key={activity.id} className={`flex min-w-0 gap-3 px-3.5 py-4 ${index > 0 ? 'border-t border-[var(--app-border)]' : ''}`}>
                            <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] ${sourceClass(activity.source)}`} aria-hidden="true">
                                <Icon className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-start justify-between gap-2">
                                    <p className="min-w-0 break-words text-[15px] font-semibold leading-5 text-[var(--app-fg)]">{activity.summary}</p>
                                    <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${outcomeClass(activity.outcome)}`}>{props.t(`monitors.activity.outcome.${activity.outcome}`)}</span>
                                </div>
                                <p className="mt-1.5 text-xs leading-4 text-[var(--app-hint)]">
                                    {props.t(`monitors.activity.source.${activity.source}`)} · <time dateTime={new Date(activity.createdAt).toISOString()}>{formatTime(activity.createdAt, props.locale)}</time>
                                </p>
                                {activity.details || (deferred && props.onRetrigger) ? <div className="mt-3 flex flex-wrap gap-2">
                                    {activity.details ? (
                                        <button type="button" onClick={() => setDetail(activity)} className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[var(--app-subtle-bg)] px-3 text-sm font-semibold text-[var(--app-fg)] transition-[background-color,opacity] hover:bg-[var(--app-secondary-bg)] active:opacity-65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] sm:flex-none">
                                            <FileJson className="h-4 w-4" aria-hidden="true" />
                                            {props.t('monitors.activity.viewDetails')}
                                        </button>
                                    ) : null}
                                    {deferred && props.onRetrigger ? (
                                        <button type="button" onClick={() => props.onRetrigger?.(activity)} disabled={Boolean(props.retryingId)} className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[var(--app-button)] px-3 text-sm font-semibold text-[var(--app-button-text)] transition-opacity hover:opacity-85 active:opacity-65 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] sm:flex-none">
                                            <RotateCcw className={`h-4 w-4 ${props.retryingId === activity.id ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
                                            {props.t('monitors.activity.retrigger')}
                                        </button>
                                    ) : null}
                                </div> : null}
                            </div>
                        </article>
                    )
                })}
            </div>
            <ActivityDetailDialog
                activity={detail}
                locale={props.locale}
                t={props.t}
                onOpenChange={(open) => {
                    if (!open) setDetail(null)
                }}
            />
        </>
    )
}
