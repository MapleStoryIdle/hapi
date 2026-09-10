import { describe, expect, it } from 'bun:test'
import { readCodexTokenUsage, selectCodexTokenUsage } from './codexUsage'
import { appendCodexTranscriptImportLines, createCodexTranscriptImportAccumulator } from './codexTranscript'

describe('Codex usage snapshots', () => {
    it('replaces cumulative counters and does not count cached/reasoning subsets twice', () => {
        const first = readCodexTokenUsage({ total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 15 } }, 1)
        const latest = readCodexTokenUsage({ total: { inputTokens: 200, cachedInputTokens: 150, outputTokens: 40, reasoningOutputTokens: 25, totalTokens: 240 } }, 2)
        expect(first?.total).toBe(120)
        expect(selectCodexTokenUsage(first, latest)).toEqual(latest)
        expect(latest?.total).toBe(240)
        expect(selectCodexTokenUsage(latest, readCodexTokenUsage({ last: { inputTokens: 3, outputTokens: 1 } }, 3))).toEqual(latest)
    })
    it('preserves missing fields and treats a last-turn counter as partial', () => {
        expect(readCodexTokenUsage({ last_token_usage: { input_tokens: 0 } }, 1)).toMatchObject({ input: 0, output: null, cachedInput: null, total: null, scope: 'lastTurn' })
        expect(readCodexTokenUsage({ total: { inputTokens: -1 } }, 1)).toBeNull()
        expect(readCodexTokenUsage({ total: { inputTokens: 5, cachedInputTokens: 8 } }, 1)?.cachedInput).toBeNull()
    })
    it('uses reported history totals and flags restarted counters as partial', () => {
        const info = { total: { inputTokens: 500, outputTokens: 50 }, last: { inputTokens: 5, outputTokens: 2 } }
        expect(readCodexTokenUsage(info, 1)).toMatchObject({ total: 550, scope: 'session' })
        expect(selectCodexTokenUsage(readCodexTokenUsage(info, 1), readCodexTokenUsage({ total: { inputTokens: 10, outputTokens: 2 } }, 2))?.scope).toBe('partial')
    })
    it('keeps native usage outside message pagination and appends incrementally', () => {
        const accumulator = createCodexTranscriptImportAccumulator()
        const event = (input: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-09-10T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 20 } } } })
        appendCodexTranscriptImportLines(accumulator, [event(100), event(100)])
        expect(accumulator.tokenUsage?.total).toBe(120)
        appendCodexTranscriptImportLines(accumulator, [event(200)])
        expect(accumulator.tokenUsage?.total).toBe(220)
    })
    it('retains all observed counter segments across resets without adding repeated snapshots', () => {
        const snapshot = (input: number, output: number, time: number) => readCodexTokenUsage({ total: { inputTokens: input, outputTokens: output, cachedInputTokens: input / 2 } }, time)
        let usage = selectCodexTokenUsage(snapshot(100, 20, 1), snapshot(10, 2, 2))
        expect(usage).toMatchObject({ input: 110, output: 22, total: 132, cachedInput: 55 })
        usage = selectCodexTokenUsage(usage, snapshot(10, 2, 3))
        expect(usage?.total).toBe(132)
        usage = selectCodexTokenUsage(usage, snapshot(30, 6, 4))
        expect(usage).toMatchObject({ input: 130, output: 26, total: 156, cachedInput: 65 })
        usage = selectCodexTokenUsage(usage, snapshot(5, 1, 5))
        expect(usage?.total).toBe(162)
        expect(selectCodexTokenUsage(usage, snapshot(30, 6, 4))).toEqual(usage)
    })
    it('keeps available fork history and earlier segments when importing the complete transcript', () => {
        const accumulator = createCodexTranscriptImportAccumulator()
        const event = (input: number, second: number) => JSON.stringify({ type: 'event_msg', timestamp: `2026-09-10T00:00:0${second}Z`, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 10 } } } })
        appendCodexTranscriptImportLines(accumulator, [
            JSON.stringify({ type: 'session_meta', payload: { id: 'fork', forked_from_id: 'parent' } }),
            event(100, 1), event(200, 2), event(20, 3), event(20, 3), event(40, 4)
        ])
        expect(accumulator.tokenUsage).toMatchObject({ input: 240, output: 20, total: 260 })
    })
})
