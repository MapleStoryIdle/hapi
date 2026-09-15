import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from '@/lib/messages'

function userMessage(partial: Partial<DecryptedMessage> & { id: string }): DecryptedMessage {
    return {
        id: partial.id,
        localId: partial.localId ?? partial.id,
        seq: partial.seq ?? 1,
        createdAt: partial.createdAt ?? 1_000,
        invokedAt: partial.invokedAt ?? null,
        status: partial.status,
        content: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }
}

describe('mergeMessages', () => {
    it('deduplicates repeated incoming rows before an initial window exists', () => {
        const merged = mergeMessages([], [
            userMessage({ id: 'server-1', localId: 'local-1', createdAt: 1_000 }),
            userMessage({ id: 'server-1', localId: 'local-1', createdAt: 1_001 }),
        ])

        expect(merged).toHaveLength(1)
        expect(merged[0]?.createdAt).toBe(1_001)
    })

    it('preserves invokedAt when a stale snapshot omits the ack timestamp', () => {
        const invokedAt = 2_000
        const existing = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt })]
        const incoming = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt: null })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(invokedAt)
    })

    it('keeps persisted history in sequence order when acknowledgement timestamps disagree', () => {
        const merged = mergeMessages([], [
            userMessage({ id: 'later', seq: 2, createdAt: 2_000, invokedAt: 1_000 }),
            userMessage({ id: 'earlier', seq: 1, createdAt: 1_000, invokedAt: 3_000 })
        ])

        expect(merged.map((message) => message.id)).toEqual(['earlier', 'later'])
    })
})
