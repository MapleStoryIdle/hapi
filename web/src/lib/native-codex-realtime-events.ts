import type { CodexLocalSessionRealtimeSnapshot, SyncEvent } from '@/types/api'
import { isNativeSnapshotVersion } from '@/lib/native-snapshot-refresh-coordinator'

export type NativeCodexSessionUpdatedEvent = Extract<SyncEvent, { type: 'codex-session-updated' }>
export type NativeCodexSessionListUpdate = NonNullable<NativeCodexSessionUpdatedEvent['summary']>

type NativeCodexSessionUpdatedListener = (event: NativeCodexSessionUpdatedEvent) => void

const listeners = new Set<NativeCodexSessionUpdatedListener>()

/**
 * The SSE hook owns transport parsing. Native session surfaces subscribe here
 * so they can refresh their runner-local transcript without faking a SHAPI
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

/**
 * Current runners include a sanitized list row with an invalidation. Older
 * runners omit it, so callers can retain their one-shot HTTP fallback.
 */
export function getNativeCodexSessionListUpdate(
    event: NativeCodexSessionUpdatedEvent
): NativeCodexSessionListUpdate | null {
    return event.summary ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

/** Validate the compact version/status invalidation before it reaches a detail. */
export function getNativeCodexRealtimeSnapshot(
    event: NativeCodexSessionUpdatedEvent
): CodexLocalSessionRealtimeSnapshot | null {
    const value = asRecord(event.snapshot)
    const status = asRecord(value?.status)
    const timing = asRecord(value?.timing)
    const deliveryReceipts = status?.deliveryReceipts
    const validDeliveryReceipts = deliveryReceipts === undefined || (
        Array.isArray(deliveryReceipts) && deliveryReceipts.length <= 100
        && deliveryReceipts.every((entry) => {
            const receipt = asRecord(entry)
            return receipt !== null && typeof receipt.id === 'string'
                && receipt.id.length > 0 && receipt.id.length <= 160
                && (receipt.state === 'accepted' || receipt.state === 'delivered')
        })
    )
    const queuedMessageRefs = status?.queuedMessageRefs
    const validQueuedMessageRefs = queuedMessageRefs === undefined || (
        Array.isArray(queuedMessageRefs)
        && queuedMessageRefs.length <= 50
        && queuedMessageRefs.every((entry) => {
            const record = asRecord(entry)
            return record !== null
                && typeof record.id === 'string'
                && record.id.length > 0
                && record.id.length <= 160
                && (record.recoveryRequired === undefined || typeof record.recoveryRequired === 'boolean')
                && (record.recoveryReason === undefined || [
                    'codex_timeout',
                    'session_status_unknown',
                    'launch_failed',
                    'runner_restarted',
                    'external_writer_active'
                ].includes(record.recoveryReason as string))
        })
    )
    if (
        !value
        || !isNativeSnapshotVersion(value.version)
        || typeof value.revision !== 'number'
        || !Number.isInteger(value.revision)
        || value.revision < 1
        || value.revision !== value.version.revision
        || status?.success !== true
        || !['idle', 'processing', 'unknown'].includes(status.status as string)
        || (status.waitingForUserInput !== undefined && typeof status.waitingForUserInput !== 'boolean')
        || (status.controlledByCodexSsh !== undefined && typeof status.controlledByCodexSsh !== 'boolean')
        || 'queuedMessages' in (status ?? {})
        || !validQueuedMessageRefs
        || !validDeliveryReceipts
        || (timing?.cache !== 'hit' && timing?.cache !== 'miss')
        || typeof timing.durationMs !== 'number'
        || !Number.isFinite(timing.durationMs)
        || timing.durationMs < 0
    ) {
        return null
    }
    return value as unknown as CodexLocalSessionRealtimeSnapshot
}
