const STORAGE_KEY = 'hapi:native-codex-direct-messages:v1'
const MAX_MESSAGES_PER_SESSION = 50
const MAX_SESSIONS = 50
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1_000

export type NativeCodexDirectMessageScope = {
    machineId: string
    sessionId: string
}

export type NativeCodexDirectMessageDeliveryPhase =
    | 'launching'
    | 'matching'
    | 'connected'
    | 'retrying'
    | 'reasoning'
    | 'queued'

/**
 * A browser-side receipt for a native Codex prompt. Native transcripts have
 * no HAPI message id, so this stays visible until the matching transcript
 * row arrives from the runner.
 */
export type NativeCodexDirectMessageEcho = {
    id: string
    /** What the person typed; retained in the bubble and native queue. */
    text: string
    /** Expanded custom-prompt text expected to appear in the native transcript. */
    deliveryText?: string
    createdAt: number
    status: 'sending' | 'queued' | 'failed'
    /** More precise than the shared message-status icon. */
    deliveryPhase: NativeCodexDirectMessageDeliveryPhase
    /** The runner's timestamp for the current stage, or browser receipt time. */
    phaseStartedAt: number
    queueId: string | null
    observedTranscriptMessageIds: readonly string[]
    observedThroughPosition: number | null
}

type StoredMessages = Record<string, NativeCodexDirectMessageEcho[]>

function getLocalStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    try {
        return window.localStorage
    } catch {
        return null
    }
}

/** Previous builds used sessionStorage. Read it once so an upgrade does not hide an in-flight receipt. */
function getLegacySessionStorage(): Storage | null {
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

function isDeliveryPhase(value: unknown): value is NativeCodexDirectMessageDeliveryPhase {
    return value === 'launching'
        || value === 'matching'
        || value === 'connected'
        || value === 'retrying'
        || value === 'reasoning'
        || value === 'queued'
}

function parseDeliveryPhase(value: unknown, status: NativeCodexDirectMessageEcho['status']): NativeCodexDirectMessageDeliveryPhase {
    if (isDeliveryPhase(value)) return value
    // Receipts written by the first direct-send UI used these names. Preserve
    // their visible hand-off instead of dropping it at upgrade time.
    if (value === 'sending') return 'launching'
    if (value === 'resuming') return 'matching'
    return status === 'sending' ? 'launching' : 'queued'
}

function parseEcho(value: unknown, now: number): NativeCodexDirectMessageEcho | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const text = typeof record.text === 'string' ? record.text : ''
    const deliveryText = typeof record.deliveryText === 'string' && record.deliveryText.trim()
        ? record.deliveryText.trim()
        : undefined
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
    const deliveryPhase = parseDeliveryPhase(record.deliveryPhase, record.status)
    const phaseStartedAt = typeof record.phaseStartedAt === 'number' && Number.isFinite(record.phaseStartedAt)
        ? record.phaseStartedAt
        : createdAt

    return {
        id,
        text,
        ...(deliveryText && deliveryText !== text.trim() ? { deliveryText } : {}),
        createdAt,
        status: record.status,
        deliveryPhase,
        phaseStartedAt,
        queueId,
        observedTranscriptMessageIds,
        observedThroughPosition
    }
}

function parseStore(raw: string | null, now: number): StoredMessages {
    if (!raw) return {}

    try {
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

function readStore(now = Date.now()): StoredMessages {
    const localStorage = getLocalStorage()
    const local = parseStore(localStorage?.getItem(STORAGE_KEY) ?? null, now)
    const legacy = parseStore(getLegacySessionStorage()?.getItem(STORAGE_KEY) ?? null, now)
    const merged = { ...legacy, ...local }
    if (Object.keys(legacy).length > 0) {
        // Route changes should not be the boundary for a remote command. Move
        // the receipt to localStorage when it is available, then use the old
        // session store only as a compatibility fallback.
        writeStore(merged)
    }
    return merged
}

function newestMessageAt(messages: readonly NativeCodexDirectMessageEcho[]): number {
    return messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0)
}

function writeStore(store: StoredMessages): void {
    const storage = getLocalStorage() ?? getLegacySessionStorage()
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

/** Update one native thread's browser-durable optimistic receipts. */
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
