const STORAGE_KEY = 'hapi:native-codex-direct-messages:v1'
const MAX_MESSAGES_PER_SESSION = 50
const MAX_SESSIONS = 50
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1_000

export type NativeCodexDirectMessageScope = {
    machineId: string
    sessionId: string
}

/**
 * A browser-side receipt for a native Codex prompt. Native transcripts have
 * no HAPI message id, so this stays visible until the matching transcript
 * row arrives from the runner.
 */
export type NativeCodexDirectMessageEcho = {
    id: string
    text: string
    createdAt: number
    status: 'sending' | 'queued' | 'failed'
    queueId: string | null
    observedTranscriptMessageIds: readonly string[]
    observedThroughPosition: number | null
}

type StoredMessages = Record<string, NativeCodexDirectMessageEcho[]>

function getStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

export function getNativeCodexDirectMessageScopeKey(scope: NativeCodexDirectMessageScope): string {
    return JSON.stringify([scope.machineId, scope.sessionId])
}

function isEchoStatus(value: unknown): value is NativeCodexDirectMessageEcho['status'] {
    return value === 'sending' || value === 'queued' || value === 'failed'
}

function parseEcho(value: unknown, now: number): NativeCodexDirectMessageEcho | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const text = typeof record.text === 'string' ? record.text : ''
    const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Number.NaN
    const queueId = typeof record.queueId === 'string' ? record.queueId : null
    const observedTranscriptMessageIds = Array.isArray(record.observedTranscriptMessageIds)
        ? record.observedTranscriptMessageIds.filter((item): item is string => typeof item === 'string')
        : []
    const observedThroughPosition = typeof record.observedThroughPosition === 'number'
        ? record.observedThroughPosition
        : null

    if (!id || !text.trim() || !Number.isFinite(createdAt) || createdAt < now - MAX_MESSAGE_AGE_MS) {
        return null
    }
    if (!isEchoStatus(record.status)) return null

    return {
        id,
        text,
        createdAt,
        status: record.status,
        queueId,
        observedTranscriptMessageIds,
        observedThroughPosition
    }
}

function readStore(now = Date.now()): StoredMessages {
    const storage = getStorage()
    if (!storage) return {}

    try {
        const raw = storage.getItem(STORAGE_KEY)
        if (!raw) return {}
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

        const store: StoredMessages = {}
        for (const [scope, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue
            const messages = value
                .map((message) => parseEcho(message, now))
                .filter((message): message is NativeCodexDirectMessageEcho => message !== null)
                .slice(-MAX_MESSAGES_PER_SESSION)
            if (messages.length > 0) {
                store[scope] = messages
            }
        }
        return store
    } catch {
        return {}
    }
}

function newestMessageAt(messages: readonly NativeCodexDirectMessageEcho[]): number {
    return messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0)
}

function writeStore(store: StoredMessages): void {
    const storage = getStorage()
    if (!storage) return

    try {
        const entries = Object.entries(store)
            .filter(([, messages]) => messages.length > 0)
            .sort(([, left], [, right]) => newestMessageAt(right) - newestMessageAt(left))
            .slice(0, MAX_SESSIONS)
        storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch {
        // Private mode and quota failures must not block a native send.
    }
}

function normalizeMessages(messages: readonly NativeCodexDirectMessageEcho[]): NativeCodexDirectMessageEcho[] {
    const now = Date.now()
    return messages
        .map((message) => parseEcho(message, now))
        .filter((message): message is NativeCodexDirectMessageEcho => message !== null)
        .slice(-MAX_MESSAGES_PER_SESSION)
}

export function readNativeCodexDirectMessageEchoes(
    scope: NativeCodexDirectMessageScope
): NativeCodexDirectMessageEcho[] {
    return [...(readStore()[getNativeCodexDirectMessageScopeKey(scope)] ?? [])]
}

/** Update one native thread's durable-in-tab optimistic receipts. */
export function updateNativeCodexDirectMessageEchoes(
    scope: NativeCodexDirectMessageScope,
    updater: (messages: NativeCodexDirectMessageEcho[]) => readonly NativeCodexDirectMessageEcho[]
): NativeCodexDirectMessageEcho[] {
    const store = readStore()
    const key = getNativeCodexDirectMessageScopeKey(scope)
    const next = normalizeMessages(updater([...(store[key] ?? [])]))
    if (next.length > 0) {
        store[key] = next
    } else {
        delete store[key]
    }
    writeStore(store)
    return next
}
