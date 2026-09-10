import { useCallback, useEffect, useState } from 'react'

export type SessionListViewMode = 'list' | 'kanban'

export const DEFAULT_SESSION_LIST_VIEW_MODE: SessionListViewMode = 'list'

const VIEW_MODE_STORAGE_KEY = 'hapi-session-list-view-mode'
const PINNED_SESSION_KEYS_STORAGE_KEY = 'hapi-session-list-pinned-session-keys'

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
        // Ignore storage errors; the preference still applies for this render.
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

function parseSessionListViewMode(raw: string | null): SessionListViewMode {
    return raw === 'kanban' || raw === 'list' ? raw : DEFAULT_SESSION_LIST_VIEW_MODE
}

function parsePinnedSessionKeys(raw: string | null): Set<string> {
    if (!raw) return new Set()
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Set()
        return new Set(
            parsed.filter((value): value is string => typeof value === 'string')
                .map((value) => value.trim())
                .filter(Boolean)
        )
    } catch {
        return new Set()
    }
}

export function getInitialSessionListViewMode(): SessionListViewMode {
    return parseSessionListViewMode(safeGetItem(VIEW_MODE_STORAGE_KEY))
}

export function getInitialPinnedSessionKeys(): Set<string> {
    return parsePinnedSessionKeys(safeGetItem(PINNED_SESSION_KEYS_STORAGE_KEY))
}

export function removeMigratedPinnedSessionKeys(keys: string[]): void {
    const remaining = getInitialPinnedSessionKeys()
    for (const key of keys) remaining.delete(key)
    if (remaining.size) safeSetItem(PINNED_SESSION_KEYS_STORAGE_KEY, JSON.stringify([...remaining]))
    else safeRemoveItem(PINNED_SESSION_KEYS_STORAGE_KEY)
}

export function useSessionListViewMode(): {
    sessionListViewMode: SessionListViewMode
    setSessionListViewMode: (mode: SessionListViewMode) => void
} {
    const [sessionListViewMode, setSessionListViewModeState] = useState<SessionListViewMode>(getInitialSessionListViewMode)

    useEffect(() => {
        if (!isBrowser()) return

        const onStorage = (event: StorageEvent) => {
            if (event.key === VIEW_MODE_STORAGE_KEY) {
                setSessionListViewModeState(parseSessionListViewMode(event.newValue))
            }
        }

        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setSessionListViewMode = useCallback((mode: SessionListViewMode) => {
        setSessionListViewModeState(mode)
        if (mode === DEFAULT_SESSION_LIST_VIEW_MODE) {
            safeRemoveItem(VIEW_MODE_STORAGE_KEY)
        } else {
            safeSetItem(VIEW_MODE_STORAGE_KEY, mode)
        }
    }, [])

    return {
        sessionListViewMode,
        setSessionListViewMode
    }
}
