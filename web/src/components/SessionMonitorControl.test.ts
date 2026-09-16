import { describe, expect, it } from 'vitest'
import type { Monitor } from '@hapi/protocol/monitoring'
import { isMonitorRelatedToSession } from './SessionMonitorControl'

function monitor(overrides: Partial<Monitor> = {}): Monitor {
    return {
        id: 'monitor-1',
        config: {
            name: 'API',
            kind: 'webhook',
            machineId: 'machine-1',
            directory: '/work',
            agent: 'codex',
            model: '',
            reasoningEffort: '',
            permissionMode: 'default',
            prompt: 'Investigate',
            webhookIgnoreKeywords: '',
            deliveryMode: 'current-session',
            expiresAt: null,
            enabled: true,
            request: null
        },
        createdAt: 1,
        updatedAt: 1,
        health: 'unknown',
        lastCheckedAt: null,
        lastLatencyMs: null,
        lastError: null,
        nextCheckAt: 0,
        buckets: [],
        incident: null,
        lastActivity: null,
        lastDelivery: null,
        callStats: { total: 0, ok: 0, failed: 0, dispatched: 0, deferred: 0, duplicate: 0, ignored: 0 },
        ...overrides
    }
}

describe('session monitor association', () => {
    it('matches a monitor bound directly to a managed session', () => {
        const value = monitor({ config: { ...monitor().config, targetSession: { type: 'managed', sessionId: 'session-1' } } })
        expect(isMonitorRelatedToSession(value, [{ type: 'managed', sessionId: 'session-1' }])).toBe(true)
    })

    it('requires the native thread and machine to match', () => {
        const value = monitor({ config: { ...monitor().config, targetSession: { type: 'native-codex', sessionId: 'thread-1' } } })
        expect(isMonitorRelatedToSession(value, [{ type: 'native-codex', sessionId: 'thread-1', machineId: 'machine-1' }])).toBe(true)
        expect(isMonitorRelatedToSession(value, [{ type: 'native-codex', sessionId: 'thread-1', machineId: 'machine-2' }])).toBe(false)
    })

    it('also recognizes the most recent delivery session', () => {
        const value = monitor({ relatedSession: { type: 'managed', sessionId: 'delivery-1' } })
        expect(isMonitorRelatedToSession(value, [{ type: 'managed', sessionId: 'delivery-1' }])).toBe(true)
    })

    it('recognizes a durable monitor origin after a newer delivery replaces the related session', () => {
        const value = monitor({ relatedSession: { type: 'managed', sessionId: 'newer-delivery' } })
        expect(isMonitorRelatedToSession(value, [{ type: 'managed', sessionId: 'older-delivery' }], ['monitor-1'])).toBe(true)
    })
})
