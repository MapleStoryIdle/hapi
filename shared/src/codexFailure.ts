const MAX_CODEX_FAILURE_MESSAGE_LENGTH = 4_000
const MAX_CODEX_FAILURE_DEPTH = 5

const GENERIC_CODEX_FAILURE_MESSAGES = new Set([
    'failed',
    'task failed',
    'codex task failed',
    'unknown error',
    'an unknown error occurred',
])

const GENERIC_CODEX_SYSTEM_ERRORS = new Set([
    'codex thread entered systemerror',
    'systemerror',
    'system error',
])

export type CodexFailureCode = 'system_error' | 'authentication' | 'http_forbidden' | 'network_error' | 'usage_limit' | 'model_capacity' | 'context_window' | 'unknown'

function boundedFailureText(value: string): string | null {
    const text = value.trim()
    if (!text) return null
    if (text.length <= MAX_CODEX_FAILURE_MESSAGE_LENGTH) return text
    return `${text.slice(0, MAX_CODEX_FAILURE_MESSAGE_LENGTH - 1)}…`
}

/** Lower values are generic transport fallbacks; higher values carry provider detail. */
export function getCodexFailureMessageSpecificity(value: string | null | undefined): number {
    const normalized = value?.trim().toLowerCase()
    if (!normalized || GENERIC_CODEX_FAILURE_MESSAGES.has(normalized)) return 0
    if (GENERIC_CODEX_SYSTEM_ERRORS.has(normalized)) return 1
    return 2
}

export function isGenericCodexFailureMessage(value: string | null | undefined): boolean {
    return getCodexFailureMessageSpecificity(value) < 2
}

export function selectPreferredCodexFailureMessage(
    previous: string | null | undefined,
    incoming: string | null | undefined
): string | null {
    const previousText = previous ? boundedFailureText(previous) : null
    const incomingText = incoming ? boundedFailureText(incoming) : null
    if (!previousText) return incomingText
    if (!incomingText) return previousText
    return getCodexFailureMessageSpecificity(incomingText) >= getCodexFailureMessageSpecificity(previousText)
        ? incomingText
        : previousText
}

/**
 * Extract a useful provider failure from old/new Codex payload shapes.
 * Recognized nested fields win; an otherwise unfamiliar object is preserved as
 * bounded JSON so the UI only falls back when the value truly cannot be read.
 */
export function extractCodexFailureMessage(value: unknown): string | null {
    const seen = new Set<object>()

    const visit = (candidate: unknown, depth: number): string | null => {
        if (typeof candidate === 'string') {
            const text = boundedFailureText(candidate)
            if (!text) return null
            if ((text.startsWith('{') || text.startsWith('[')) && depth < MAX_CODEX_FAILURE_DEPTH) {
                try {
                    return selectPreferredCodexFailureMessage(text, visit(JSON.parse(text), depth + 1))
                } catch {
                    // The provider returned ordinary text beginning with JSON punctuation.
                }
            }
            return text
        }
        if (!candidate || typeof candidate !== 'object' || depth >= MAX_CODEX_FAILURE_DEPTH) return null
        if (seen.has(candidate)) return null
        seen.add(candidate)

        if (Array.isArray(candidate)) {
            return candidate.reduce<string | null>(
                (best, item) => selectPreferredCodexFailureMessage(best, visit(item, depth + 1)),
                null
            )
        }

        const record = candidate as Record<string, unknown>
        const preferredKeys = [
            'error', 'cause', 'detail', 'message', 'reason', 'status',
            'output', 'result', 'finalMessage', 'final_message'
        ] as const
        let best: string | null = null
        for (const key of preferredKeys) {
            if (!(key in record)) continue
            best = selectPreferredCodexFailureMessage(best, visit(record[key], depth + 1))
        }
        if (best) return best

        try {
            return boundedFailureText(JSON.stringify(record))
        } catch {
            return null
        }
    }

    return visit(value, 0)
}

export function classifyCodexFailureMessage(message: string | null): CodexFailureCode {
    if (!message) return 'unknown'
    const normalized = message.toLowerCase()
    if (/\b(?:http\/\d(?:\.\d)?\s+)?403\s+forbidden\b/i.test(message)) return 'http_forbidden'
    if (
        normalized.includes('authentication required')
        || normalized.includes('not logged in')
        || normalized.includes('access token has expired')
        || normalized.includes('logged out')
        || /\b401\s+unauthorized\b/i.test(message)
    ) return 'authentication'
    if (
        normalized.includes('usage limit')
        || normalized.includes('purchase more credits')
        || normalized.includes('codex/settings/usage')
    ) return 'usage_limit'
    if (normalized.includes('model is at capacity')) return 'model_capacity'
    if (normalized.includes('context window') || normalized.includes('context length')) return 'context_window'
    if (
        normalized.includes('network error')
        || normalized.includes('failed to fetch')
        || normalized.includes('error sending request')
        || normalized.includes('stream disconnected before completion')
        || normalized.includes('connection reset')
        || normalized.includes('connection refused')
        || normalized.includes('connection timed out')
        || normalized.includes('network is unreachable')
        || normalized.includes('socket hang up')
        || normalized.includes('could not resolve host')
        || /\b(?:econnreset|econnrefused|etimedout|enotfound|eai_again)\b/i.test(message)
    ) return 'network_error'
    if (GENERIC_CODEX_SYSTEM_ERRORS.has(normalized.trim())) return 'system_error'
    return 'unknown'
}
