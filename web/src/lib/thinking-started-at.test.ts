import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@/chat/types'
import { getThinkingStartedAt } from './thinking-started-at'

function prompt(invokedAt?: number | null, status?: NormalizedMessage['status']): NormalizedMessage {
    return { id: 'user', localId: null, role: 'user', createdAt: 1, isSidechain: false,
        content: { type: 'text', text: 'hello' }, invokedAt, status }
}
describe('persisted thinking time', () => {
    it('uses invocation time rather than message creation time', () => {
        expect(getThinkingStartedAt([prompt(100)])).toBe(100)
    })
    it('does not restart the current turn for queued or failed drafts', () => {
        expect(getThinkingStartedAt([prompt(100), prompt(null, 'queued'), prompt(null, 'failed')])).toBe(100)
    })
    it('never borrows the previous turn timestamp when the current one is missing', () => {
        expect(getThinkingStartedAt([prompt(100), prompt(null)])).toBeNull()
        expect(getThinkingStartedAt([])).toBeNull()
    })
})
