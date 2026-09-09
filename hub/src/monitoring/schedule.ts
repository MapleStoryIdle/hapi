import { Cron } from 'croner'
import type { MonitorSchedule } from '@hapi/protocol/monitoring'

/** Parse only minute-resolution cron; no timers, shell, or dynamic code. */
export function nextMonitorRun(schedule: MonitorSchedule, after: number): number {
    new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).format(after)
    const [hour, minute] = schedule.time.split(':').map(Number)
    const expression = schedule.mode === 'cron' ? schedule.cron
        : `${minute} ${hour} * * ${schedule.mode === 'weekly' ? schedule.dayOfWeek : '*'}`
    if (expression.trim().split(/\s+/).length !== 5) throw new Error('Use a five-field cron expression (minute hour day month weekday)')
    const cron = new Cron(expression, { timezone: schedule.timeZone, paused: true })
    try {
        const next = cron.nextRun(new Date(after))?.getTime()
        if (!next || next <= after) throw new Error('Schedule has no future occurrence')
        return next
    } finally { cron.stop() }
}
