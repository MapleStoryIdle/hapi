import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { pickMostRecentActiveSession } from './initialSessionSelection'

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('pickMostRecentActiveSession', () => {
    it('只在活跃会话里选择 updatedAt 最新的一条', () => {
        const result = pickMostRecentActiveSession([
            makeSession({ id: 'inactive-newer', active: false, updatedAt: 300 }),
            makeSession({ id: 'active-older', active: true, updatedAt: 100 }),
            makeSession({ id: 'active-newer', active: true, updatedAt: 200 }),
        ])

        expect(result?.id).toBe('active-newer')
    })

    it('没有活跃会话时返回 null', () => {
        const result = pickMostRecentActiveSession([
            makeSession({ id: 'inactive-a', active: false, updatedAt: 100 }),
            makeSession({ id: 'inactive-b', active: false, updatedAt: 200 }),
        ])

        expect(result).toBeNull()
    })

    it('updatedAt 相同时用 activeAt 和 id 做稳定兜底', () => {
        const result = pickMostRecentActiveSession([
            makeSession({ id: 'b', active: true, updatedAt: 100, activeAt: 10 }),
            makeSession({ id: 'a', active: true, updatedAt: 100, activeAt: 20 }),
            makeSession({ id: 'c', active: true, updatedAt: 100, activeAt: 20 }),
        ])

        expect(result?.id).toBe('c')
    })
})
