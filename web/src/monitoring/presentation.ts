import type { Monitor, MonitorBucket, MonitorConfig } from '@hapi/protocol/monitoring'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export type MonitorBucketState = 'up' | 'mixed' | 'down' | 'received' | 'no-data'

export type MonitorTimelineSlot = MonitorBucket & {
    state: MonitorBucketState
}

export type MonitorTimeline = {
    granularity: 'hour' | 'three-hours'
    slots: MonitorTimelineSlot[]
}

export type MonitorAggregate = {
    sampleCount: number
    successRate: number | null
    coverage: number | null
    expectedChecks: number | null
    latencyMs: number | null
    passive: boolean
}

export type MonitorExpiryDraft =
    | { mode: 'preserve'; expiresAt: number | null }
    | { mode: 'one-day' }
    | { mode: 'seven-days' }
    | { mode: 'custom-days'; days: string }
    | { mode: 'permanent' }

function nonNegative(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0
}

function asBucket(bucket: Partial<MonitorBucket>, at: number): MonitorBucket {
    return {
        at,
        total: nonNegative(bucket.total ?? 0),
        ok: nonNegative(bucket.ok ?? 0),
        failures: nonNegative(bucket.failures ?? 0),
        latencyMs: Number.isFinite(bucket.latencyMs ?? NaN) ? Math.max(0, bucket.latencyMs ?? 0) : 0
    }
}

/** A received webhook is an event sample, never proof of service uptime. */
export function getMonitorBucketState(
    bucket: Pick<MonitorBucket, 'total' | 'ok' | 'failures'>,
    kind: MonitorConfig['kind'] = 'http'
): MonitorBucketState {
    const total = nonNegative(bucket.total)
    if (kind !== 'http') return total > 0 ? 'received' : 'no-data'
    const ok = nonNegative(bucket.ok)
    const failures = nonNegative(bucket.failures)
    if (total === 0) return 'no-data'
    if (failures > 0 && ok > 0) return 'mixed'
    if (failures > 0) return 'down'
    if (ok > 0) return 'up'
    return 'no-data'
}

export function getMonitorDisplayHealth(monitor: Pick<Monitor, 'config' | 'health' | 'buckets' | 'lastCheckedAt'>):
    | 'up'
    | 'down'
    | 'unknown'
    | 'paused'
    | 'no-data' {
    if (!monitor.config.enabled) return 'paused'
    const hasData = monitor.buckets.some((bucket) => nonNegative(bucket.total) > 0)
    if (!hasData && !monitor.lastCheckedAt) return 'no-data'
    return monitor.health
}

export function getMonitorAggregate(monitor: Pick<Monitor, 'config' | 'buckets'>): MonitorAggregate {
    const buckets = monitor.buckets.map((bucket) => asBucket(bucket, bucket.at))
    const sampleCount = buckets.reduce((total, bucket) => total + bucket.total, 0)
    const passive = monitor.config.kind !== 'http'

    if (passive) {
        return {
            sampleCount,
            successRate: null,
            coverage: null,
            expectedChecks: null,
            latencyMs: null,
            passive: true
        }
    }

    const ok = buckets.reduce((total, bucket) => total + bucket.ok, 0)
    const latencySum = buckets.reduce((total, bucket) => total + bucket.latencyMs, 0)
    const expectedChecks = Math.max(1, Math.floor(WEEK_MS / Math.max(60, monitor.config.request?.intervalSeconds ?? 60)))

    return {
        sampleCount,
        successRate: sampleCount > 0 ? ok / sampleCount : null,
        coverage: sampleCount / expectedChecks,
        expectedChecks,
        latencyMs: sampleCount > 0 ? latencySum / sampleCount : null,
        passive: false
    }
}

/**
 * Render one concise seven-day timeline. Sparse/three-hour backend buckets get
 * 56 cells; hour-level buckets get 168. Empty time is intentionally gray.
 */
export function buildMonitorTimeline(
    buckets: MonitorBucket[],
    kind: MonitorConfig['kind'] = 'http',
    now = Date.now()
): MonitorTimeline {
    const granularity = buckets.length > 56 ? 'hour' : 'three-hours'
    const slotDuration = granularity === 'hour' ? HOUR_MS : 3 * HOUR_MS
    const slotCount = granularity === 'hour' ? 168 : 56
    const latestSlotStart = Math.floor(now / slotDuration) * slotDuration
    const earliestSlotStart = latestSlotStart - (slotCount - 1) * slotDuration
    const slots = Array.from({ length: slotCount }, (_, index) => asBucket({}, earliestSlotStart + index * slotDuration))

    for (const source of buckets) {
        if (!Number.isFinite(source.at)) continue
        const index = Math.floor((source.at - earliestSlotStart) / slotDuration)
        if (index < 0 || index >= slotCount) continue
        const target = slots[index]
        target.total += nonNegative(source.total)
        target.ok += nonNegative(source.ok)
        target.failures += nonNegative(source.failures)
        target.latencyMs += Number.isFinite(source.latencyMs) ? Math.max(0, source.latencyMs) : 0
    }

    return {
        granularity,
        slots: slots.map((slot) => ({ ...slot, state: getMonitorBucketState(slot, kind) }))
    }
}

export function describeMonitorBucket(
    bucket: MonitorTimelineSlot,
    kind: MonitorConfig['kind'],
    locale: string
): string {
    const time = new Intl.DateTimeFormat(locale, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(bucket.at))
    if (bucket.state === 'no-data') return `${time}: no data`
    if (kind !== 'http') {
        return kind === 'scheduled'
            ? `${time}: ${bucket.total} scheduled trigger${bucket.total === 1 ? '' : 's'}; not uptime`
            : `${time}: ${bucket.total} received event${bucket.total === 1 ? '' : 's'}; passive signal, not uptime`
    }
    const latency = bucket.latencyMs > 0 && bucket.total > 0
        ? `, ${Math.round(bucket.latencyMs / bucket.total)} ms average`
        : ''
    return `${time}: ${bucket.ok} successful check${bucket.ok === 1 ? '' : 's'}, ${bucket.failures} failed${latency}`
}

export function createExpiryDraft(expiresAt: number | null, editing: boolean): MonitorExpiryDraft {
    if (editing) return { mode: 'preserve', expiresAt }
    return { mode: 'seven-days' }
}

/** Preserve absolute expiry during edits until a human deliberately changes it. */
export function resolveExpiryAt(draft: MonitorExpiryDraft, now = Date.now()): number | null {
    switch (draft.mode) {
        case 'preserve':
            return draft.expiresAt
        case 'one-day':
            return now + DAY_MS
        case 'seven-days':
            return now + WEEK_MS
        case 'permanent':
            return null
        case 'custom-days': {
            const days = Number(draft.days)
            if (!Number.isInteger(days) || days < 1) {
                throw new Error('Custom expiry must be at least one day.')
            }
            return now + days * DAY_MS
        }
    }
}

export function formatMonitorExpiry(expiresAt: number | null, locale: string): string {
    if (expiresAt === null) return 'Permanent'
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(expiresAt))
}

export function createDefaultMonitorConfig(machineId = '', directory = ''): MonitorConfig {
    return {
        name: '',
        kind: 'http',
        machineId,
        directory,
        agent: 'codex',
        model: '',
        reasoningEffort: '',
        permissionMode: 'read-only',
        prompt: 'Investigate the monitor safely. Diagnose the issue and provide a repair plan. Do not make changes until repair is explicitly approved.',
        expiresAt: null,
        enabled: true,
        request: {
            url: '',
            method: 'GET',
            headers: {},
            body: '',
            intervalSeconds: 300,
            timeoutSeconds: 10,
            expectedStatus: 200,
            bodyIncludes: '',
            allowPrivateNetwork: false,
            allowPost: false
        }
    }
}
