import { safeStringify } from '@hapi/protocol'
import type { LocalPreviewProtocol } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'

const LOCAL_PREVIEW_MESSAGE_LIMIT = 80
const LOCAL_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[^\s<>"'`]*)?/gi

export type DetectedLocalPreview = {
    id: string
    protocol: LocalPreviewProtocol
    port: number
    path: string
    sourceUrl: string
    detectedAt: number
}

function trimUrlPunctuation(value: string): string {
    return value.replace(/[),.;\]]+$/g, '')
}

function getPort(url: URL): number | null {
    if (url.port) {
        const port = Number(url.port)
        return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null
    }
    return url.protocol === 'https:' ? 443 : 80
}

function normalizeLocalUrl(rawUrl: string, detectedAt: number): DetectedLocalPreview | null {
    try {
        const parsed = new URL(trimUrlPunctuation(rawUrl))
        const protocol = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : null
        if (!protocol) return null
        if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(parsed.hostname)) return null
        const port = getPort(parsed)
        if (port === null) return null

        const path = `${parsed.pathname || '/'}${parsed.search}`
        return {
            id: `${protocol}:${port}`,
            protocol,
            port,
            path,
            sourceUrl: parsed.toString(),
            detectedAt
        }
    } catch {
        return null
    }
}

function collectMessageText(message: NormalizedMessage): string {
    if (message.role === 'user') {
        return message.content.text
    }
    if (message.role === 'event') {
        const content = message.content
        if ('message' in content && typeof content.message === 'string') {
            return content.message
        }
        return safeStringify(content)
    }

    const parts: string[] = []
    for (const item of message.content) {
        switch (item.type) {
            case 'text':
            case 'reasoning':
                parts.push(item.text)
                break
            case 'tool-result':
                parts.push(safeStringify(item.content))
                break
            case 'tool-call':
                parts.push(item.description ?? '', safeStringify(item.input))
                break
            case 'summary':
                parts.push(item.summary)
                break
            case 'sidechain':
                parts.push(item.prompt)
                break
            default:
                parts.push(safeStringify(item))
                break
        }
    }
    return parts.join('\n')
}

export function extractLocalPreviews(messages: readonly NormalizedMessage[]): DetectedLocalPreview[] {
    const candidates = new Map<string, DetectedLocalPreview>()
    const recentMessages = messages.slice(-LOCAL_PREVIEW_MESSAGE_LIMIT)

    for (const message of recentMessages) {
        const text = collectMessageText(message)
        const matches = text.matchAll(LOCAL_URL_RE)
        for (const match of matches) {
            const detected = normalizeLocalUrl(match[0], message.createdAt)
            if (!detected) continue
            const existing = candidates.get(detected.id)
            if (!existing || detected.detectedAt >= existing.detectedAt) {
                candidates.set(detected.id, detected)
            }
        }
    }

    return Array.from(candidates.values())
        .sort((a, b) => b.detectedAt - a.detectedAt)
}
