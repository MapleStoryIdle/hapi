import type { SyncEvent } from '@/types/api'

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
