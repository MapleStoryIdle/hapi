import { z } from 'zod'

const count = z.number().finite().nonnegative().nullable()
const counters = z.object({
    input: count,
    output: count,
    cachedInput: count,
    reasoningOutput: count,
    total: count
})
export const CodexTokenUsageSchema = counters.extend({
    /** Latest completed/request turn, kept separately from session totals. */
    lastTurn: counters.optional(),
    /** Tokens currently occupying the model context, when Codex reports it. */
    contextTokens: count.optional(),
    /** Model context capacity reported by Codex. */
    contextWindow: count.optional(),
    /** Latest raw counter after a reset; totals above retain earlier segments. */
    lastCumulative: counters.optional(),
    scope: z.enum(['session', 'lastTurn', 'partial']),
    updatedAt: z.number().finite()
})
export type CodexTokenUsage = z.infer<typeof CodexTokenUsageSchema>
export type CodexUsageAccount = {
    mode: 'oauth' | 'api' | 'unknown'
    label: string | null
    plan: string | null
    /** Subscription expiry reported by Codex account/read, if available. */
    expiresAt?: number | null
    source: 'currentConnection'
}

/** Matches Codex TUI: cached input is reported separately from effective usage. */
export function getCodexNonCachedInput(usage: CodexTokenUsage): number | null {
    if (usage.input === null || usage.cachedInput === null) return null
    return Math.max(0, usage.input - usage.cachedInput)
}

/** Matches Codex TUI `blended_total`: non-cached input plus output. */
export function getCodexBlendedTotal(usage: CodexTokenUsage): number | null {
    const input = getCodexNonCachedInput(usage)
    if (input === null || usage.output === null) return null
    return input + Math.max(0, usage.output)
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Cumulative snapshots replace each other; never add them or cached/reasoning subsets. */
export function readCodexTokenUsage(info: unknown, updatedAt: number): CodexTokenUsage | null {
    const root = record(info)
    if (!root) return null
    const cumulative = record(root.total_token_usage ?? root.totalTokenUsage ?? root.total)
    const latest = record(root.last_token_usage ?? root.lastTokenUsage ?? root.last)
    const data = cumulative ?? latest
    if (!data) return null
    const numberFrom = (source: Record<string, unknown>, ...keys: string[]) => {
        const value = keys.map(key => source[key]).find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        return typeof value === 'number' ? value : null
    }
    const readCounters = (source: Record<string, unknown>) => {
        const input = numberFrom(source, 'input_tokens', 'inputTokens')
        const output = numberFrom(source, 'output_tokens', 'outputTokens')
        const cachedInput = numberFrom(source, 'cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens')
        const reasoningOutput = numberFrom(source, 'reasoning_output_tokens', 'reasoningOutputTokens')
        const total = numberFrom(source, 'total_tokens', 'totalTokens') ?? (input !== null && output !== null ? input + output : null)
        return {
            input,
            output,
            cachedInput: cachedInput !== null && input !== null && cachedInput > input ? null : cachedInput,
            reasoningOutput,
            total
        }
    }
    const selected = readCounters(data)
    const latestCounters = latest ? readCounters(latest) : undefined
    const contextTokens = numberFrom(root, 'context_tokens', 'contextTokens')
        ?? (latest ? numberFrom(latest, 'context_tokens', 'contextTokens') : null)
        ?? latestCounters?.input
        ?? null
    const contextWindow = numberFrom(root, 'model_context_window', 'modelContextWindow', 'context_window', 'contextWindow')
    const { input, output, cachedInput, reasoningOutput, total } = selected
    if (input === null && output === null && total === null) return null
    return {
        input,
        output,
        cachedInput,
        reasoningOutput,
        total,
        ...(latestCounters ? { lastTurn: latestCounters } : {}),
        contextTokens,
        contextWindow,
        scope: cumulative ? 'session' : 'lastTurn',
        updatedAt
    }
}

export function selectCodexTokenUsage(previous: CodexTokenUsage | null, next: CodexTokenUsage | null): CodexTokenUsage | null {
    if (previous && next && next.updatedAt < previous.updatedAt) return previous
    if (!next || (previous && previous.scope !== 'lastTurn' && next.scope === 'lastTurn')) return previous
    if (next.scope === 'session' && previous && previous.scope !== 'lastTurn') {
        const raw = previous.lastCumulative ?? previous
        const reset = raw.total !== null && next.total !== null && next.total < raw.total
        if (reset || previous.lastCumulative) {
            const accumulated = { ...next }
            for (const key of ['input', 'output', 'cachedInput', 'reasoningOutput', 'total'] as const) {
                const current = next[key]
                const old = previous[key]
                const baseline = raw[key]
                accumulated[key] = current === null || old === null || (!reset && baseline === null)
                    ? null : old + (reset ? current : Math.max(0, current - (baseline ?? 0)))
            }
            return { ...accumulated, scope: 'partial', lastCumulative: {
                input: next.input, output: next.output, cachedInput: next.cachedInput,
                reasoningOutput: next.reasoningOutput, total: next.total
            } }
        }
        if (previous.scope === 'partial') return { ...next, scope: 'partial' }
    }
    return next
}
