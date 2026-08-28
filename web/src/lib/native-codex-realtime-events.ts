import type { CodexLocalSessionRealtimeSnapshot, SyncEvent } from '@/types/api'

export type NativeCodexSessionUpdatedEvent = Extract<SyncEvent, { type: 'codex-session-updated' }>

type NativeCodexSessionUpdatedListener = (event: NativeCodexSessionUpdatedEvent) => void

const listeners = new Set<NativeCodexSessionUpdatedListener>()

/**
 * The SSE hook owns transport parsing. Native session surfaces subscribe here
 * so they can refresh their runner-local transcript without faking a HAPI
 * session id or putting transcript bodies into the global event stream.
 */
export function publishNativeCodexSessionUpdated(event: NativeCodexSessionUpdatedEvent): void {
    for (const listener of listeners) {
        listener(event)
    }
}

export function subscribeNativeCodexSessionUpdated(listener: NativeCodexSessionUpdatedListener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

/**
 * The hub accepts older runners which only emit invalidations, so validate the
 * optional fast-path payload at this boundary before putting it in React
 * Query's cache.
 */
export function getNativeCodexRealtimeSnapshot(
    event: NativeCodexSessionUpdatedEvent
): CodexLocalSessionRealtimeSnapshot | null {
    const value = asRecord(event.snapshot)
    const status = asRecord(value?.status)
    const timing = asRecord(value?.timing)
    if (
        !value
        || typeof value.revision !== 'number'
        || !Number.isInteger(value.revision)
        || value.revision < 1
        || status?.success !== true
        || !['idle', 'processing', 'unknown'].includes(status.status as string)
        || (timing?.cache !== 'hit' && timing?.cache !== 'miss')
        || typeof timing.durationMs !== 'number'
        || !Number.isFinite(timing.durationMs)
        || timing.durationMs < 0
    ) {
        return null
    }

    const hasTranscript = value.session !== undefined
        || value.importedMessages !== undefined
        || value.startIndex !== undefined
        || value.page !== undefined
    if (!hasTranscript) {
        return value as unknown as CodexLocalSessionRealtimeSnapshot
    }
    const session = asRecord(value.session)
    const page = asRecord(value.page)
    const startIndex = value.startIndex
    const pageLimit = page?.limit
    const pageNextBefore = page?.nextBefore
    if (
        !session
        || typeof session.id !== 'string'
        || typeof session.title !== 'string'
        || typeof session.modifiedAt !== 'number'
        || !Number.isFinite(session.modifiedAt)
        || !Array.isArray(value.importedMessages)
        || typeof startIndex !== 'number'
        || !Number.isInteger(startIndex)
        || startIndex < 0
        || !page
        || typeof pageLimit !== 'number'
        || !Number.isInteger(pageLimit)
        || pageLimit < 1
        || (pageNextBefore !== null && (typeof pageNextBefore !== 'number' || !Number.isInteger(pageNextBefore) || pageNextBefore < 0))
        || typeof page.hasMore !== 'boolean'
    ) {
        return null
    }
    return value as unknown as CodexLocalSessionRealtimeSnapshot
}
