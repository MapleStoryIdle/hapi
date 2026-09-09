import { useEffect, useId, useMemo, useState } from 'react'
import type { Monitor } from '@hapi/protocol/monitoring'
import { buildMonitorTimeline, describeMonitorBucket, type MonitorBucketState } from './presentation'

type Translate = (key: string, params?: Record<string, string | number>) => string

const STATE_CLASS: Record<MonitorBucketState, string> = {
    up: 'bg-emerald-500 dark:bg-emerald-400',
    mixed: 'bg-amber-500 dark:bg-amber-400',
    down: 'bg-red-500 dark:bg-red-400',
    received: 'bg-sky-500 dark:bg-sky-400',
    'no-data': 'bg-slate-300 dark:bg-slate-600'
}

function stateLabel(state: MonitorBucketState, t: Translate): string {
    return t(`monitors.timeline.${state}`)
}

export function MonitorStatusTimeline(props: {
    monitor: Pick<Monitor, 'config' | 'buckets'>
    locale: string
    t: Translate
}) {
    const timeline = useMemo(
        () => buildMonitorTimeline(props.monitor.buckets, props.monitor.config.kind),
        [props.monitor.buckets, props.monitor.config.kind]
    )
    const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, timeline.slots.length - 1))
    const selectId = useId()
    const selected = timeline.slots[selectedIndex] ?? timeline.slots.at(-1)

    useEffect(() => {
        setSelectedIndex((current) => Math.min(current, Math.max(0, timeline.slots.length - 1)))
    }, [timeline.slots.length])

    if (!selected) return null

    const description = describeMonitorBucket(selected, props.monitor.config.kind, props.locale)
    const statusBarsLabel = props.monitor.config.kind !== 'http'
        ? props.t(props.monitor.config.kind === 'scheduled' ? 'monitors.timeline.scheduledLabel' : 'monitors.timeline.webhookLabel')
        : props.t('monitors.timeline.httpLabel')

    return (
        <section aria-labelledby={`${selectId}-title`} className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 id={`${selectId}-title`} className="text-sm font-semibold text-[var(--app-fg)]">
                        {props.t('monitors.timeline.title')}
                    </h2>
                    <p className="mt-0.5 text-xs leading-5 text-[var(--app-hint)]">
                        {timeline.granularity === 'hour'
                            ? props.t('monitors.timeline.hourly')
                            : props.t('monitors.timeline.threeHourly')}
                        {' · '}
                        {statusBarsLabel}
                    </p>
                </div>
                <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-[11px] font-medium text-[var(--app-hint)]">
                    {props.t('monitors.timeline.sevenDays')}
                </span>
            </div>

            <div
                role="group"
                aria-label={props.t('monitors.timeline.selectPeriod')}
                className="mt-3 grid h-10 overflow-hidden rounded-lg bg-[var(--app-subtle-bg)] p-1"
                style={{ gridTemplateColumns: `repeat(${timeline.slots.length}, minmax(0, 1fr))`, gap: '1px' }}
                data-testid="monitor-status-bars"
                data-monitor-kind={props.monitor.config.kind}
            >
                {timeline.slots.map((slot, index) => {
                    const label = `${stateLabel(slot.state, props.t)}. ${describeMonitorBucket(slot, props.monitor.config.kind, props.locale)}`
                    const isSelected = selectedIndex === index
                    return (
                        <button
                            key={slot.at}
                            type="button"
                            onClick={() => setSelectedIndex(index)}
                            aria-label={label}
                            aria-pressed={isSelected}
                            title={label}
                            className={`min-w-0 rounded-sm ${STATE_CLASS[slot.state]} transition-opacity hover:opacity-75 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-offset-1 ${isSelected ? 'ring-1 ring-[var(--app-fg)] ring-offset-1 ring-offset-[var(--app-bg)]' : ''}`}
                        />
                    )
                })}
            </div>

            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-[var(--app-hint)]" aria-label={props.t('monitors.timeline.legend')}>
                {(props.monitor.config.kind !== 'http'
                    ? ['received', 'no-data'] as const
                    : ['up', 'mixed', 'down', 'no-data'] as const
                ).map((state) => (
                    <span key={state} className="inline-flex items-center gap-1.5">
                        <span className={`h-2.5 w-2.5 rounded-sm ${STATE_CLASS[state]}`} aria-hidden="true" />
                        {stateLabel(state, props.t)}
                    </span>
                ))}
            </div>

            {props.monitor.config.kind !== 'http' ? (
                <p className="mt-2 rounded-xl bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-800 dark:text-amber-200">
                    {props.t(props.monitor.config.kind === 'scheduled' ? 'monitors.timeline.scheduledNote' : 'monitors.timeline.webhookNote')}
                </p>
            ) : null}

            <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                <p className="text-xs leading-5 text-[var(--app-fg)]" aria-live="polite">
                    <span className="font-semibold">{stateLabel(selected.state, props.t)}.</span> {description}
                </p>
                <label htmlFor={selectId} className="mt-2 block text-[11px] font-medium text-[var(--app-hint)]">
                    {props.t('monitors.timeline.selectPeriod')}
                </label>
                <select
                    id={selectId}
                    value={selectedIndex}
                    onChange={(event) => setSelectedIndex(Number(event.target.value))}
                    className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    {timeline.slots.map((slot, index) => (
                        <option key={slot.at} value={index}>
                            {describeMonitorBucket(slot, props.monitor.config.kind, props.locale)}
                        </option>
                    ))}
                </select>
            </div>
        </section>
    )
}
