import { QueuedMessageEditSchema } from '@hapi/protocol/schemas'
import { useCallback, useSyncExternalStore } from 'react'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'

export type QueuedMessageEdit = { id: string; text: string; pendingSchedule: PendingSchedule | null }
const cache = new Map<string, QueuedMessageEdit[]>()
const listeners = new Map<string, Set<() => void>>()
const storageKey = (sessionId: string) => `hapi:queued-message-edits:${sessionId}`

function read(sessionId: string): QueuedMessageEdit[] {
    const cached = cache.get(sessionId)
    if (cached) return cached
    let edits: QueuedMessageEdit[] = []
    try {
        const parsed = QueuedMessageEditSchema.array().safeParse(JSON.parse(sessionStorage.getItem(storageKey(sessionId)) ?? '[]'))
        if (parsed.success) edits = parsed.data
    } catch { /* Memory fallback when browser storage is unavailable. */ }
    cache.set(sessionId, edits)
    return edits
}

function write(sessionId: string, edits: QueuedMessageEdit[]) {
    cache.set(sessionId, edits)
    try {
        if (edits.length) sessionStorage.setItem(storageKey(sessionId), JSON.stringify(edits))
        else sessionStorage.removeItem(storageKey(sessionId))
    } catch { /* Keep the in-memory handoff even if storage is full. */ }
    listeners.get(sessionId)?.forEach((listener) => listener())
}

/** Ownership survives removal of the last queue row, route changes and reloads. */
export function enqueueQueuedMessageEdit(sessionId: string, edit: QueuedMessageEdit) {
    write(sessionId, [...read(sessionId).filter((item) => item.id !== edit.id), edit])
}

export function getQueuedMessageEdit(sessionId: string): QueuedMessageEdit | null {
    return read(sessionId)[0] ?? null
}

export function consumeQueuedMessageEdit(sessionId: string, id: string) {
    write(sessionId, read(sessionId).filter((item) => item.id !== id))
}

export function useQueuedMessageEdit(sessionId: string | undefined): QueuedMessageEdit | null {
    return useSyncExternalStore(useCallback((listener) => {
        if (!sessionId) return () => {}
        const group = listeners.get(sessionId) ?? new Set<() => void>()
        group.add(listener)
        listeners.set(sessionId, group)
        return () => { group.delete(listener); if (!group.size) listeners.delete(sessionId) }
    }, [sessionId]), useCallback(() => sessionId ? getQueuedMessageEdit(sessionId) : null, [sessionId]), () => null)
}
