export function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

export function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null
}

export function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Match an HTTP failure, not an incidental number inside an HTML error page. */
export function isHttpForbiddenError(message: unknown): boolean {
    if (typeof message !== 'string') return false
    const summary = message.slice(0, 1024).split('<', 1)[0]
    return /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)\s*[:=]?\s*403\b|\b403\s+Forbidden\b/i.test(summary)
}

export function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value
    try {
        const stringified = JSON.stringify(value, null, 2)
        return typeof stringified === 'string' ? stringified : String(value)
    } catch {
        return String(value)
    }
}
