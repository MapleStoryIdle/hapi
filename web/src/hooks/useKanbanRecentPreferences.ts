import { useCallback, useEffect, useState } from 'react'

export const DEFAULT_KANBAN_RECENT_MINUTES = 15
export const MIN_KANBAN_RECENT_MINUTES = 1
export const MAX_KANBAN_RECENT_MINUTES = 3 * 24 * 60
export const DEFAULT_KANBAN_RECENT_AUTO_REMOVE = true

const MINUTES_STORAGE_KEY = 'hapi-kanban-recent-minutes'
const AUTO_REMOVE_STORAGE_KEY = 'hapi-kanban-recent-auto-remove'
const CHANGED_EVENT = 'hapi-kanban-recent-preferences-changed'

type KanbanRecentPreferences = {
    recentMinutes: number
    autoRemoveOnOpen: boolean
}

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(key: string): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSetItem(key: string, value: string): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(key, value)
    } catch {
        // Ignore storage errors.
    }
}

function safeRemoveItem(key: string): void {
    if (!isBrowser()) return
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors.
    }
}

export function normalizeKanbanRecentMinutes(value: number): number {
    if (!Number.isInteger(value)) return DEFAULT_KANBAN_RECENT_MINUTES
    return Math.min(MAX_KANBAN_RECENT_MINUTES, Math.max(MIN_KANBAN_RECENT_MINUTES, value))
}

function parseRecentMinutes(raw: string | null): number {
    if (raw === null || raw.trim() === '') return DEFAULT_KANBAN_RECENT_MINUTES
    return normalizeKanbanRecentMinutes(Number(raw))
}

function parseAutoRemove(raw: string | null): boolean {
    if (raw === 'false') return false
    return DEFAULT_KANBAN_RECENT_AUTO_REMOVE
}

export function getInitialKanbanRecentPreferences(): KanbanRecentPreferences {
    return {
        recentMinutes: parseRecentMinutes(safeGetItem(MINUTES_STORAGE_KEY)),
        autoRemoveOnOpen: parseAutoRemove(safeGetItem(AUTO_REMOVE_STORAGE_KEY))
    }
}

export function useKanbanRecentPreferences(): KanbanRecentPreferences & {
    setRecentMinutes: (minutes: number) => void
    setAutoRemoveOnOpen: (enabled: boolean) => void
} {
    const [preferences, setPreferences] = useState<KanbanRecentPreferences>(getInitialKanbanRecentPreferences)

    useEffect(() => {
        if (!isBrowser()) return

        const refresh = () => setPreferences(getInitialKanbanRecentPreferences())
        const onStorage = (event: StorageEvent) => {
            if (event.key === MINUTES_STORAGE_KEY || event.key === AUTO_REMOVE_STORAGE_KEY) refresh()
        }
        window.addEventListener('storage', onStorage)
        window.addEventListener(CHANGED_EVENT, refresh)
        return () => {
            window.removeEventListener('storage', onStorage)
            window.removeEventListener(CHANGED_EVENT, refresh)
        }
    }, [])

    const setRecentMinutes = useCallback((minutes: number) => {
        const normalized = normalizeKanbanRecentMinutes(minutes)
        if (normalized === DEFAULT_KANBAN_RECENT_MINUTES) safeRemoveItem(MINUTES_STORAGE_KEY)
        else safeSetItem(MINUTES_STORAGE_KEY, String(normalized))
        setPreferences(current => ({ ...current, recentMinutes: normalized }))
        if (isBrowser()) window.dispatchEvent(new Event(CHANGED_EVENT))
    }, [])

    const setAutoRemoveOnOpen = useCallback((enabled: boolean) => {
        if (enabled === DEFAULT_KANBAN_RECENT_AUTO_REMOVE) safeRemoveItem(AUTO_REMOVE_STORAGE_KEY)
        else safeSetItem(AUTO_REMOVE_STORAGE_KEY, String(enabled))
        setPreferences(current => ({ ...current, autoRemoveOnOpen: enabled }))
        if (isBrowser()) window.dispatchEvent(new Event(CHANGED_EVENT))
    }, [])

    return { ...preferences, setRecentMinutes, setAutoRemoveOnOpen }
}
