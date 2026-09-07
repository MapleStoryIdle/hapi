import { describe, expect, it } from 'vitest'
import { getNativeCodexRealtimeSnapshot, type NativeCodexSessionUpdatedEvent } from './native-codex-realtime-events'

describe('native control realtime snapshot', () => {
    const event: NativeCodexSessionUpdatedEvent = {
        type: 'codex-session-updated', machineId: 'machine', codexSessionId: 'session',
        snapshot: {
            version: { runnerEpoch: 'runner', revision: 1 }, revision: 1,
            timing: { cache: 'hit', durationMs: 0 },
            status: { success: true, status: 'processing', activeTurnId: 'turn', controls: {
                canStop: false, canConfigure: true, queuePaused: true, stoppingTurnId: 'turn',
                configuration: { model: 'model', modelReasoningEffort: 'high', serviceTier: 'fast' }
            } }
        }
    }

    it('retains control state without transcript payloads or another request', () => {
        expect(getNativeCodexRealtimeSnapshot(event)?.status.controls).toEqual(event.snapshot?.status.controls)
    })

    it('rejects malformed control capability data', () => {
        const malformed = { ...event, snapshot: { ...event.snapshot, status: {
            ...event.snapshot?.status, controls: { ...event.snapshot?.status.controls, canStop: 'true' }
        } } } as unknown as NativeCodexSessionUpdatedEvent
        expect(getNativeCodexRealtimeSnapshot(malformed)).toBeNull()
    })
})
