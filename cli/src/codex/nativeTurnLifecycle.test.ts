import { describe, expect, it, vi } from 'vitest'
import type { CodexLocalSessionSummary, CodexTranscriptLifecycleEvent } from '@hapi/protocol/codexTranscript'
import {
    NATIVE_CODEX_PROCESSING_STALE_AFTER_MS,
    NativeCodexTurnLifecycleTracker,
    normalizeNativeCodexSessionForDisplay
} from './nativeTurnLifecycle'

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

    it('does not let an orphaned transcript start survive a newer completed turn', () => {
        const tracker = new NativeCodexTurnLifecycleTracker()
        const lifecycle = [
            { type: 'task_started' as const, turnId: 'turn-orphaned' },
            { type: 'task_started' as const, turnId: 'turn-latest' },
            { type: 'task_complete' as const, turnId: 'turn-latest' }
        ]

        try {
            tracker.observeTranscriptEvents(sessionId, lifecycle)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')

            // Cached transcript lifecycle tails are replayed on later status
            // reads. The replay must remain idle and must also reject a late
            // UserPromptSubmit hook for the superseded turn.
            tracker.observeTranscriptEvents(sessionId, lifecycle)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')
            expect(tracker.observeHookStart({
                codexSessionId: sessionId,
                turnId: 'turn-orphaned',
                event: 'turn_started',
                observedAt: 1
            })).toBe(false)
        } finally {
            tracker.dispose()
        }
    })

    it('does not resurrect an orphan when a replay exceeds the terminal tombstone limit', () => {
        const tracker = new NativeCodexTurnLifecycleTracker()
        const lifecycle: CodexTranscriptLifecycleEvent[] = [
            { type: 'task_started', turnId: 'turn-orphaned' }
        ]
        for (let index = 0; index < 20; index += 1) {
            lifecycle.push({ type: 'task_started', turnId: `turn-${index}` })
            lifecycle.push({ type: 'task_complete', turnId: `turn-${index}` })
        }

        try {
            tracker.observeTranscriptEvents(sessionId, lifecycle)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')

            tracker.observeTranscriptEvents(sessionId, lifecycle)
            expect(tracker.applyToSummary(summary('idle')).runState).toBe('idle')
        } finally {
            tracker.dispose()
        }
    })

    it('presents an abandoned processing transcript as unknown without refreshing its timestamp', () => {
        const now = NATIVE_CODEX_PROCESSING_STALE_AFTER_MS + 1_000
        const tracker = new NativeCodexTurnLifecycleTracker({ now: () => now })
        const abandoned = { ...summary('processing'), modifiedAt: 999 }

        try {
            tracker.observeTranscriptEvents(sessionId, [{ type: 'task_started', turnId: 'turn-a' }])
            const tracked = tracker.applyToSummary(abandoned)
            expect(tracked).toMatchObject({ runState: 'processing', modifiedAt: 999 })
            expect(normalizeNativeCodexSessionForDisplay(tracked, now)).toMatchObject({
                runState: 'unknown',
                modifiedAt: 999
            })

            const advanced = { ...tracked, modifiedAt: now - 1 }
            expect(normalizeNativeCodexSessionForDisplay(advanced, now).runState).toBe('processing')
        } finally {
            tracker.dispose()
        }
    })

    it('notifies when a fresh processing transcript crosses the stale boundary', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_000)
        const onProcessingStale = vi.fn()
        const tracker = new NativeCodexTurnLifecycleTracker({
            now: Date.now,
            processingStaleAfterMs: 100,
            onProcessingStale
        })
        const processing = { ...summary('processing'), modifiedAt: 950 }

        try {
            tracker.applyToSummary(processing)
            vi.advanceTimersByTime(49)
            expect(onProcessingStale).not.toHaveBeenCalled()

            vi.advanceTimersByTime(1)
            expect(onProcessingStale).toHaveBeenCalledOnce()
            expect(onProcessingStale).toHaveBeenCalledWith(sessionId)

            tracker.applyToSummary(processing)
            vi.advanceTimersByTime(100)
            expect(onProcessingStale).toHaveBeenCalledOnce()

            tracker.applyToSummary({ ...processing, modifiedAt: 1_100 })
            vi.advanceTimersByTime(100)
            expect(onProcessingStale).toHaveBeenCalledTimes(2)
        } finally {
            tracker.dispose()
            vi.useRealTimers()
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
