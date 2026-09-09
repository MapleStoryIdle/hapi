import { describe, expect, it } from 'bun:test'
import { MonitorConfigSchema, MonitorScheduleSchema } from '@hapi/protocol/monitoring'
import { Store } from '../store'
import { nextMonitorRun } from './schedule'

describe('monitor schedule', () => {
    it('evaluates daily, weekly and cron in the configured timezone', () => {
        const now = Date.parse('2026-09-08T00:00:00Z')
        const daily = MonitorScheduleSchema.parse({ mode: 'daily', time: '09:30', timeZone: 'Asia/Shanghai' })
        expect(nextMonitorRun(daily, now)).toBe(Date.parse('2026-09-08T01:30:00Z'))
        expect(nextMonitorRun({ ...daily, mode: 'weekly', dayOfWeek: 1 }, now)).toBe(Date.parse('2026-09-14T01:30:00Z'))
        expect(nextMonitorRun({ ...daily, mode: 'cron', cron: '*/15 * * * *' }, now)).toBe(now + 15 * 60000)
        expect(() => nextMonitorRun({ ...daily, mode: 'cron', cron: '* * * * * *' }, now)).toThrow()
        expect(() => nextMonitorRun({ ...daily, timeZone: 'unknown/nope' }, now)).toThrow()
    })
    it('atomically claims one run, skips downtime backlog, retains one pending incident', () => {
        const store = new Store(':memory:')
        try {
            const now = Date.parse('2026-09-08T00:00:00Z')
            const config = MonitorConfigSchema.parse({ name: 'task', kind: 'scheduled', directory: '/work', machineId: 'm', prompt: 'Inspect', schedule: { mode: 'cron', cron: '* * * * *', timeZone: 'UTC' } })
            const { id, token } = store.monitors.create('a', config, now)
            expect(token).toBeNull()
            const monitor = store.monitors.get(id)!
            expect(monitor.nextCheckAt).toBe(now + 60000)
            expect(store.monitors.claimScheduled(monitor, now + 3600000)?.created).toBe(true)
            expect(store.monitors.claimScheduled(monitor, now + 3600000)).toBeNull()
            expect(store.monitors.get(id)?.nextCheckAt).toBe(now + 3660000)
            expect(store.monitors.claimScheduled(store.monitors.get(id)!, now + 3660000)?.created).toBe(false)
            expect(store.monitors.detail(id, 'a', now + 3660000)?.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(2)
        } finally { store.close() }
    })
})
