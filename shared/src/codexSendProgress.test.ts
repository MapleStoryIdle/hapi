import { describe, expect, it } from 'bun:test'
import { CodexLocalSessionDirectSendProgressSchema } from './schemas'

describe('native send progress history', () => {
    const progress = {
        phase: 'connected', startedAt: 1, phaseStartedAt: 3, transport: 'app-server',
        history: [
            { phase: 'launching', startedAt: 1 },
            { phase: 'matching', startedAt: 2 },
            { phase: 'connected', startedAt: 3 }
        ]
    }

    it('preserves ordered phases through realtime schema validation', () => {
        expect(CodexLocalSessionDirectSendProgressSchema.parse(progress)).toEqual(progress)
    })

    it('bounds history size and rejects invalid phases and timestamps', () => {
        for (const history of [
            Array.from({ length: 33 }, () => progress.history[0]),
            [{ phase: 'invalid', startedAt: 1 }],
            [{ phase: 'launching', startedAt: Infinity }]
        ]) {
            expect(CodexLocalSessionDirectSendProgressSchema.safeParse({ ...progress, history }).success).toBe(false)
        }
    })
})
