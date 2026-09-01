import { describe, expect, it } from 'vitest'
import type { CodexLocalSessionSummary } from '@hapi/protocol/codexTranscript'
import { NativeCodexTurnLifecycleTracker } from './nativeTurnLifecycle'

const sessionId = '12345678-1234-4234-8234-123456789012'

function summary(runState: CodexLocalSessionSummary['runState'] = 'idle'): CodexLocalSessionSummary {
    return {
        id: sessionId,
        title: 'Native task',
        cwd: '/workspace/project',
        file: '/tmp/rollout.jsonl',
        modifiedAt: 1,
        runState
    }
}

describe('NativeCodexTurnLifecycleTracker', () => {
    it('starts processing immediately and does not extend a duplicate unconfirmed lease', () => {
        let now = 1_000
        const tracker = new NativeCodexTurnLifecycleTracker({ now: () => now, unconfirmedLeaseMs: 100 })

        try {
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-a',
                event: 'turn_started',
                observedAt: now
            })).toBe(true)
            expect(tracker.applyToSummary(summary()).runState).toBe('processing')

            now += 50
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-a',
                event: 'turn_started',
                observedAt: now
            })).toBe(false)

            now += 51
            expect(tracker.applyToSummary(summary()).runState).toBe('unknown')
        } finally {
            tracker.dispose()
        }
    })

    it('does not renew an already-expired hook start when startup replays it', () => {
        const tracker = new NativeCodexTurnLifecycleTracker({ now: () => 1_000, unconfirmedLeaseMs: 100 })
        try {
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-a',
                event: 'turn_started',
                observedAt: 800
            })).toBe(true)
            expect(tracker.applyToSummary(summary()).runState).toBe('unknown')
        } finally {
            tracker.dispose()
        }
    })

    it('uses task_started as confirmation and task_complete as the matching terminal authority', () => {
        let now = 1_000
        const tracker = new NativeCodexTurnLifecycleTracker({ now: () => now, unconfirmedLeaseMs: 100 })

        try {
            tracker.observeHookStart({ codexSessionId: sessionId, turnId: 'turn-a', event: 'turn_started', observedAt: now })
            expect(tracker.observeTranscriptEvents(sessionId, [{ type: 'task_started', turnId: 'turn-a' }])).toBe(true)

            now += 10_000
            expect(tracker.applyToSummary(summary()).runState).toBe('processing')

            expect(tracker.observeTranscriptEvents(sessionId, [{ type: 'task_complete', turnId: 'turn-a' }])).toBe(true)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')
        } finally {
            tracker.dispose()
        }
    })

    it('uses turn_aborted as a matching terminal authority', () => {
        const tracker = new NativeCodexTurnLifecycleTracker()
        try {
            tracker.observeHookStart({ codexSessionId: sessionId, turnId: 'turn-a', event: 'turn_started', observedAt: 1 })
            expect(tracker.observeTranscriptEvents(sessionId, [{ type: 'turn_aborted', turnId: 'turn-a' }])).toBe(true)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')
        } finally {
            tracker.dispose()
        }
    })

    it('does not let a terminal before a delayed hook start restore processing', () => {
        const tracker = new NativeCodexTurnLifecycleTracker()
        try {
            expect(tracker.observeTranscriptEvents(sessionId, [{ type: 'task_complete', turnId: 'turn-a' }])).toBe(false)
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-a',
                event: 'turn_started',
                observedAt: 1
            })).toBe(false)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')
        } finally {
            tracker.dispose()
        }
    })

    it('does not let an old turn terminal clear a newer active turn', () => {
        const tracker = new NativeCodexTurnLifecycleTracker({ now: () => 1_000 })
        try {
            tracker.observeHookStart({ codexSessionId: sessionId, turnId: 'turn-a', event: 'turn_started', observedAt: 1_000 })
            tracker.observeHookStart({ codexSessionId: sessionId, turnId: 'turn-b', event: 'turn_started', observedAt: 1_000 })

            expect(tracker.observeTranscriptEvents(sessionId, [{ type: 'task_complete', turnId: 'turn-a' }])).toBe(false)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('processing')
        } finally {
            tracker.dispose()
        }
    })

    it('ignores an older hook start that arrives after a newer turn', () => {
        const tracker = new NativeCodexTurnLifecycleTracker({ now: () => 1_000 })
        try {
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-new',
                event: 'turn_started',
                observedAt: 900
            })).toBe(true)
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-old',
                event: 'turn_started',
                observedAt: 800
            })).toBe(false)

            expect(tracker.observeTranscriptEvents(sessionId, [
                { type: 'task_complete', turnId: 'turn-old' }
            ])).toBe(false)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('processing')
        } finally {
            tracker.dispose()
        }
    })
})
