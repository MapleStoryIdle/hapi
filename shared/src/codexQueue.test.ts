import { expect, it } from 'bun:test'
import { CodexLocalSessionQueuedMessageSchema, CodexLocalSessionRealtimeStatusSchema } from './schemas'

it('preserves queue cancellation guards and review failures in full and realtime status', () => {
    const queued = { id: 'feedback', text: 'Review', queuedAt: 1, cancelBlocked: true,
        recoveryRequired: true, recoveryReason: 'review_guard_failed' }
    expect(CodexLocalSessionQueuedMessageSchema.parse(queued)).toEqual(queued)
    const status = { success: true, status: 'idle', lastErrorCode: 'review_guard_failed',
        queuedMessageRefs: [{ id: queued.id, recoveryRequired: true, recoveryReason: queued.recoveryReason, cancelBlocked: true }] }
    expect(CodexLocalSessionRealtimeStatusSchema.parse(status)).toEqual(status)
})

it('allows 50 local queue entries and one Desktop receipt, without unbounded realtime payloads', () => {
    const status = { success: true, status: 'processing',
        queuedMessageRefs: Array.from({ length: 51 }, (_, index) => ({ id: `queue-${index}` })) }
    expect(CodexLocalSessionRealtimeStatusSchema.safeParse(status).success).toBe(true)
    expect(CodexLocalSessionRealtimeStatusSchema.safeParse({ ...status,
        queuedMessageRefs: [...status.queuedMessageRefs, { id: 'overflow' }] }).success).toBe(false)
})
