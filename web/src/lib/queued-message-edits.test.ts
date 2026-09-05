import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { sessionStorage.clear(); vi.resetModules() })
describe('durable queued edit handoff', () => {
    it('survives a reload and is isolated by source session', async () => {
        let store = await import('./queued-message-edits')
        store.enqueueQueuedMessageEdit('session-a', { id: 'row-a', text: '$review old message', pendingSchedule: { type: 'absolute', ms: 12345 } })
        expect(store.getQueuedMessageEdit('session-b')).toBeNull()
        vi.resetModules()
        store = await import('./queued-message-edits')
        expect(store.getQueuedMessageEdit('session-a')).toEqual({ id: 'row-a', text: '$review old message', pendingSchedule: { type: 'absolute', ms: 12345 } })
        store.consumeQueuedMessageEdit('session-a', 'row-a')
        expect(sessionStorage.getItem('hapi:queued-message-edits:session-a')).toBeNull()
    })
    it('retains both edits rather than replacing the first pending handoff', async () => {
        const store = await import('./queued-message-edits')
        store.enqueueQueuedMessageEdit('two', { id: 'first', text: 'one', pendingSchedule: null })
        store.enqueueQueuedMessageEdit('two', { id: 'second', text: 'two', pendingSchedule: null })
        store.consumeQueuedMessageEdit('two', 'first')
        expect(store.getQueuedMessageEdit('two')?.text).toBe('two')
    })
    it('ignores malformed persisted input', async () => {
        sessionStorage.setItem('hapi:queued-message-edits:bad', JSON.stringify([{ text: 'no ID', pendingSchedule: 'invalid' }]))
        const store = await import('./queued-message-edits')
        expect(store.getQueuedMessageEdit('bad')).toBeNull()
    })
})
