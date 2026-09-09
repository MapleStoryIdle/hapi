import { describe, expect, it } from 'vitest'
import type { MonitorConfig } from '@hapi/protocol/monitoring'
import {
    buildMonitorTimeline,
    createDefaultMonitorConfig,
    createExpiryDraft,
    describeMonitorBucket,
    getMonitorAggregate,
    getMonitorDisplayHealth,
    resolveExpiryAt
} from './presentation'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function httpConfig(): MonitorConfig {
    return {
        ...createDefaultMonitorConfig('machine-1', '/workspace/service'),
        name: 'Service API',
        kind: 'http',
        request: {
            ...createDefaultMonitorConfig().request!,
            url: 'https://service.example.test/health'
        }
    }
}

describe('monitor presentation', () => {
    it('does not present scheduled trigger counts as availability or latency', () => {
        const config = { ...httpConfig(), kind: 'scheduled' as const, request: null }
        const buckets = [{ at: 1, total: 2, ok: 2, failures: 0, latencyMs: 0 }]
        expect(getMonitorAggregate({ config, buckets })).toMatchObject({ sampleCount: 2, successRate: null, coverage: null, latencyMs: null })
        expect(buildMonitorTimeline(buckets, 'scheduled', 2).slots.some(slot => slot.state === 'up')).toBe(false)
    })
    it('keeps HTTP aggregates distinct from passive webhook counts and averages raw latency sums', () => {
        const active = getMonitorAggregate({
            config: httpConfig(),
            buckets: [
                { at: 1, total: 2, ok: 2, failures: 0, latencyMs: 100 },
                { at: 2, total: 2, ok: 1, failures: 1, latencyMs: 300 }
            ]
        })
        const passive = getMonitorAggregate({
            config: { ...httpConfig(), kind: 'webhook', request: null },
            buckets: [{ at: 1, total: 3, ok: 3, failures: 0, latencyMs: 0 }]
        })

        expect(active).toMatchObject({
            passive: false,
            sampleCount: 4,
            successRate: 0.75,
            latencyMs: 100
        })
        expect(passive).toEqual({
            passive: true,
            sampleCount: 3,
            successRate: null,
            coverage: null,
            expectedChecks: null,
            latencyMs: null
        })

        const passiveTimeline = buildMonitorTimeline(
            [{ at: 1, total: 3, ok: 3, failures: 0, latencyMs: 0 }],
            'webhook',
            2
        )
        expect(passiveTimeline.slots.some((slot) => slot.state === 'received')).toBe(true)
        expect(passiveTimeline.slots.some((slot) => slot.state === 'up')).toBe(false)
    })

    it('merges three-hour latency as raw sums before displaying its per-check average', () => {
        const now = Date.UTC(2026, 0, 8, 12, 0, 0)
        const timeline = buildMonitorTimeline([
            { at: now - 2 * HOUR_MS, total: 2, ok: 2, failures: 0, latencyMs: 100 },
            { at: now - HOUR_MS, total: 2, ok: 1, failures: 1, latencyMs: 300 }
        ], 'http', now)
        const merged = timeline.slots.find((slot) => slot.total === 4)

        expect(timeline.granularity).toBe('three-hours')
        expect(merged).toMatchObject({ total: 4, ok: 3, failures: 1, latencyMs: 400, state: 'mixed' })
        expect(describeMonitorBucket(merged!, 'http', 'en-US')).toContain('100 ms average')
    })

    it('shows no data rather than healthy when an enabled monitor has never produced a check', () => {
        expect(getMonitorDisplayHealth({
            config: httpConfig(),
            health: 'up',
            buckets: [],
            lastCheckedAt: null
        })).toBe('no-data')
    })

    it('preserves an existing absolute expiry until a person changes the edit selection', () => {
        const now = Date.UTC(2026, 0, 8, 12, 0, 0)
        const existingExpiry = now + 19 * DAY_MS

        expect(resolveExpiryAt(createExpiryDraft(existingExpiry, true), now)).toBe(existingExpiry)
        expect(resolveExpiryAt({ mode: 'one-day' }, now)).toBe(now + DAY_MS)
    })
})
