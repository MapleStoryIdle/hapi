import { useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi.sessionLastSeen.v1'
const SESSION_LAST_SEEN_CHANGE_EVENT = 'hapi:session-last-seen-changed'

type LastSeenStore = Record<string, number>
type CodexKanbanInitializedScopes = Record<string, true>

type SessionLastSeenState = {
    lastSeenAtBySession: LastSeenStore
    codexKanbanInitializedScopes: CodexKanbanInitializedScopes
}

export type SessionLastSeenSnapshot = Readonly<LastSeenStore>

export type SessionLastSeenStateSnapshot = {
    lastSeenAtBySession: SessionLastSeenSnapshot
    codexKanbanInitializedScopes: Readonly<CodexKanbanInitializedScopes>
}

export type SessionLastSeenBootstrapEntry = {
    id: string
    updatedAt: number
}

function getLocalStorage(): Storage | null {
    if (typeof window === 'undefined') {
        return null
    }
    try {
        return window.localStorage
    } catch {
        return null
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function emptyState(): SessionLastSeenState {
    return {
        lastSeenAtBySession: {},
        codexKanbanInitializedScopes: {}
    }
}

function parseLastSeenStore(value: unknown): LastSeenStore {
    if (!isRecord(value)) {
        return {}
    }

    const store: LastSeenStore = {}
    for (const [sessionId, seenAt] of Object.entries(value)) {
        const timestamp = asTimestamp(seenAt)
        if (sessionId && timestamp !== null) {
            store[sessionId] = timestamp
        }
    }
    return store
}

function parseCodexKanbanInitializedScopes(value: unknown): CodexKanbanInitializedScopes {
    if (!isRecord(value)) {
        return {}
    }

    const scopes: CodexKanbanInitializedScopes = {}
    for (const [scope, initialized] of Object.entries(value)) {
        if (scope && initialized === true) {
            scopes[scope] = true
        }
    }
    return scopes
}

/**
 * Old browser state was a flat session-id map. It is safe to retain its
 * watermarks, while treating every Codex Kanban scope as uninitialized once.
 */
function parseState(value: unknown): SessionLastSeenState {
    if (!isRecord(value)) {
        return emptyState()
    }

    if ('lastSeenAtBySession' in value) {
        return {
            lastSeenAtBySession: parseLastSeenStore(value.lastSeenAtBySession),
            codexKanbanInitializedScopes: parseCodexKanbanInitializedScopes(value.codexKanbanInitializedScopes)
        }
    }

    return {
        lastSeenAtBySession: parseLastSeenStore(value),
        codexKanbanInitializedScopes: {}
    }
}

function readState(storage = getLocalStorage()): SessionLastSeenState {
    if (!storage) {
        return emptyState()
    }

    try {
        const raw = storage.getItem(STORAGE_KEY)
        return raw ? parseState(JSON.parse(raw) as unknown) : emptyState()
    } catch {
        return emptyState()
    }
}

function snapshotState(state: SessionLastSeenState): SessionLastSeenStateSnapshot {
    return {
        lastSeenAtBySession: { ...state.lastSeenAtBySession },
        codexKanbanInitializedScopes: { ...state.codexKanbanInitializedScopes }
    }
}

function writeState(state: SessionLastSeenState, storage = getLocalStorage()): boolean {
    if (!storage) {
        return false
    }
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshotState(state)))
        return true
    } catch {
        return false
    }
}

function emitStateChange(state: SessionLastSeenState): void {
    if (typeof window === 'undefined') {
        return
    }

    try {
        window.dispatchEvent(new CustomEvent<SessionLastSeenStateSnapshot>(SESSION_LAST_SEEN_CHANGE_EVENT, {
            detail: snapshotState(state)
        }))
    } catch {
        // Ignore browser event errors just like storage errors.
    }
}

function isStateSnapshot(value: unknown): value is SessionLastSeenStateSnapshot {
    return isRecord(value)
        && isRecord(value.lastSeenAtBySession)
        && isRecord(value.codexKanbanInitializedScopes)
}

/** Read the browser-local seen state for a reactive UI surface. */
export function useSessionLastSeenState(): SessionLastSeenStateSnapshot {
    const [snapshot, setSnapshot] = useState<SessionLastSeenStateSnapshot>(() => snapshotState(readState()))

    useEffect(() => {
        const syncFromStorage = () => setSnapshot(snapshotState(readState()))
        const onChange = (event: Event) => {
            const detail = (event as CustomEvent<unknown>).detail
            setSnapshot(isStateSnapshot(detail) ? detail : snapshotState(readState()))
        }
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) {
                syncFromStorage()
            }
        }

        syncFromStorage()
        window.addEventListener(SESSION_LAST_SEEN_CHANGE_EVENT, onChange)
        window.addEventListener('storage', onStorage)
        return () => {
            window.removeEventListener(SESSION_LAST_SEEN_CHANGE_EVENT, onChange)
            window.removeEventListener('storage', onStorage)
        }
    }, [])

    return snapshot
}

/**
 * First sight of a scoped Kanban board seeds its already-completed rows as
 * seen. The scope flag and watermarks are written atomically, so a later
 * storage event cannot observe a marker without its matching map.
 */
export function initializeCodexKanbanLastSeen(
    entries: readonly SessionLastSeenBootstrapEntry[],
    scope: string
): boolean {
    const storage = getLocalStorage()
    if (!storage) {
        return false
    }

    const state = readState(storage)
    if (state.codexKanbanInitializedScopes[scope] === true) {
        return true
    }

    for (const entry of entries) {
        const updatedAt = asTimestamp(entry.updatedAt)
        if (!entry.id || updatedAt === null) {
            continue
        }
        state.lastSeenAtBySession[entry.id] = Math.max(state.lastSeenAtBySession[entry.id] ?? 0, updatedAt)
    }
    state.codexKanbanInitializedScopes[scope] = true

    if (!writeState(state, storage)) {
        return false
    }
    emitStateChange(state)
    return true
}

export function getSessionLastSeenAt(sessionId: string): number {
    return readState().lastSeenAtBySession[sessionId] ?? 0
}

export function markSessionSeen(sessionId: string, seenAt: number): void {
    const timestamp = asTimestamp(seenAt)
    if (!sessionId || timestamp === null) {
        return
    }

    const storage = getLocalStorage()
    if (!storage) {
        return
    }
    const state = readState(storage)
    state.lastSeenAtBySession[sessionId] = Math.max(state.lastSeenAtBySession[sessionId] ?? 0, timestamp)
    if (writeState(state, storage)) {
        emitStateChange(state)
    }
}
