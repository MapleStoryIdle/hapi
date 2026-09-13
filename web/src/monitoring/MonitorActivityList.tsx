import { Activity, CalendarClock, Play, Radio, RotateCcw } from 'lucide-react'
import type { MonitorActivity } from '@hapi/protocol/monitoring'

type Translate = (key: string, params?: Record<string, string | number>) => string

function formatTime(value: number, locale: string): string {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value)
}

export function MonitorActivityList(props: {
    activities: MonitorActivity[]
    locale: string
    t: Translate
    limit?: number
    retryingId?: string | null
    onRetrigger?: (activity: MonitorActivity) => void
}) {
    const activities = typeof props.limit === 'number' ? props.activities.slice(0, props.limit) : props.activities
    if (activities.length === 0) return <div className="rounded-2xl border border-dashed border-[var(--app-border)] p-6 text-center text-sm text-[var(--app-hint)]">{props.t('monitors.activity.empty')}</div>

    return <div className="overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3">
        {activities.map((activity, index) => {
            const Icon = activity.source === 'probe' ? Activity : activity.source === 'webhook' ? Radio : activity.source === 'scheduled' ? CalendarClock : Play
            const deferred = activity.outcome === 'deferred'
            return <article key={activity.id} className={`flex min-w-0 gap-3 py-3 ${index > 0 ? 'border-t border-[var(--app-border)]' : ''}`}>
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-[var(--app-hint)]" aria-hidden="true"><Icon className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                        <p className="min-w-0 break-words text-sm font-medium text-[var(--app-fg)]">{activity.summary}</p>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${deferred ? 'bg-amber-500/10 text-amber-800 dark:text-amber-200' : activity.outcome === 'failed' ? 'bg-red-500/10 text-red-700 dark:text-red-300' : activity.outcome === 'ok' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-sky-500/10 text-sky-700 dark:text-sky-300'}`}>{props.t(`monitors.activity.outcome.${activity.outcome}`)}</span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--app-hint)]">{props.t(`monitors.activity.source.${activity.source}`)} · {formatTime(activity.createdAt, props.locale)}</p>
                    {activity.details ? <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-[var(--app-hint)]">{activity.details}</p> : null}
                    {deferred && props.onRetrigger ? <button type="button" onClick={() => props.onRetrigger?.(activity)} disabled={Boolean(props.retryingId)} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><RotateCcw className={`h-4 w-4 ${props.retryingId === activity.id ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />{props.t('monitors.activity.retrigger')}</button> : null}
                </div>
            </article>
        })}
    </div>
}
