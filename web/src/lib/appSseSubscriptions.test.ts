import { describe, expect, it } from 'vitest'
import {
    getAppGlobalSseSubscription,
    getAppSessionSseSubscription,
    shouldUseGlobalMessageFallback
} from './appSseSubscriptions'

describe('app SSE subscriptions', () => {
    it('always uses a global all:true subscription for the session list', () => {
        expect(getAppGlobalSseSubscription()).toEqual({ all: true })
    })

    it('uses a session-scoped subscription only when a session is selected', () => {
        expect(getAppSessionSseSubscription(null)).toBeNull()
        expect(getAppSessionSseSubscription(undefined)).toBeNull()
        expect(getAppSessionSseSubscription('')).toBeNull()
        expect(getAppSessionSseSubscription('session-a')).toEqual({ sessionId: 'session-a' })
    })

    it('uses global message delivery only while the selected-session stream is unavailable', () => {
        expect(shouldUseGlobalMessageFallback({
            eventSessionId: 'session-a',
            selectedSessionId: 'session-a',
            sessionStreamConnected: false
        })).toBe(true)

        expect(shouldUseGlobalMessageFallback({
            eventSessionId: 'session-a',
            selectedSessionId: 'session-a',
            sessionStreamConnected: true
        })).toBe(false)

        expect(shouldUseGlobalMessageFallback({
            eventSessionId: 'session-b',
            selectedSessionId: 'session-a',
            sessionStreamConnected: false
        })).toBe(false)
    })
})
