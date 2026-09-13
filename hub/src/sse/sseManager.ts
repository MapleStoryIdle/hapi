import { randomUUID } from 'node:crypto'
import type { SyncEvent } from '../sync/syncEngine'
import type { VisibilityState } from '../visibility/visibilityTracker'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

export type SSESubscription = {
    id: string
    namespace: string
    all: boolean
    sessionId: string | null
    machineId: string | null
}

type SSEConnection = SSESubscription & {
    replayThroughId: number
    replayStarted: boolean
    releaseReplay: (() => void) | null
    // Live writes wait behind the replay gate and are serialized so an event
    // cannot overtake an older replayed event on a slow connection.
    sendQueue: Promise<void>
    replayQueue: Promise<void>
    send: (event: SyncEvent, eventId?: number) => void | Promise<void>
    sendHeartbeat: () => void | Promise<void>
}

type SSEHistoryEntry = {
    id: number
    event: SyncEvent
}

// Keep a short in-memory window. A reconnect also performs an HTTP
// reconciliation, so this is a fast-path for brief gaps rather than durable
// storage (and avoids retaining an unbounded stream of tool payloads).
const MAX_REPLAY_EVENTS = 512

export class SSEManager {
    private readonly connections: Map<string, SSEConnection> = new Map()
    private heartbeatTimer: NodeJS.Timeout | null = null
    private readonly heartbeatMs: number
    private readonly visibilityTracker: VisibilityTracker
    private nextEventId = 0
    private readonly history: SSEHistoryEntry[] = []
    private readonly streamEpoch = randomUUID()

    constructor(heartbeatMs = 30_000, visibilityTracker: VisibilityTracker) {
        this.heartbeatMs = heartbeatMs
        this.visibilityTracker = visibilityTracker
    }

    getStreamEpoch(): string {
        return this.streamEpoch
    }

    subscribe(options: {
        id: string
        namespace: string
        all?: boolean
        sessionId?: string | null
        machineId?: string | null
        visibility?: VisibilityState
        replay?: boolean
        send: (event: SyncEvent, eventId?: number) => void | Promise<void>
        sendHeartbeat: () => void | Promise<void>
    }): SSESubscription {
        const replayThroughId = this.nextEventId
        let releaseReplay: (() => void) | null = null
        const replayGate = options.replay
            ? new Promise<void>((resolve) => {
                releaseReplay = resolve
            })
            : Promise.resolve()
        const subscription: SSEConnection = {
            id: options.id,
            namespace: options.namespace,
            all: Boolean(options.all),
            sessionId: options.sessionId ?? null,
            machineId: options.machineId ?? null,
            replayThroughId,
            replayStarted: false,
            releaseReplay,
            sendQueue: replayGate,
            replayQueue: Promise.resolve(),
            send: options.send,
            sendHeartbeat: options.sendHeartbeat
        }

        this.connections.set(subscription.id, subscription)
        this.visibilityTracker.registerConnection(
            subscription.id,
            subscription.namespace,
            options.visibility ?? 'hidden'
        )
        this.ensureHeartbeat()
        return {
            id: subscription.id,
            namespace: subscription.namespace,
            all: subscription.all,
            sessionId: subscription.sessionId,
            machineId: subscription.machineId
        }
    }

    async replay(id: string, lastEventId: number | null | undefined): Promise<void> {
        const connection = this.connections.get(id)
        if (!connection) {
            return
        }
        if (connection.replayStarted) {
            return
        }
        connection.replayStarted = true

        if (lastEventId === null || lastEventId === undefined || !Number.isFinite(lastEventId)) {
            await this.finishReplay(connection)
            return
        }

        const entries = this.history.filter((entry) => (
            entry.id > lastEventId
            && entry.id <= connection.replayThroughId
            && this.shouldSend(connection, entry.event)
        ))

        for (const entry of entries) {
            try {
                const delivery = this.enqueueReplay(connection, () => connection.send(entry.event, entry.id))
                await delivery
            } catch {
                this.unsubscribe(connection.id)
                break
            }
        }

        await this.finishReplay(connection)
    }

    unsubscribe(id: string): void {
        this.connections.delete(id)
        this.visibilityTracker.removeConnection(id)
        if (this.connections.size === 0) {
            this.stopHeartbeat()
        }
    }

    async sendToast(namespace: string, event: Extract<SyncEvent, { type: 'toast' }>): Promise<number> {
        const deliveries: Array<Promise<{ id: string; ok: boolean }>> = []
        for (const connection of this.connections.values()) {
            if (connection.namespace !== namespace) {
                continue
            }
            if (!this.visibilityTracker.isVisibleConnection(connection.id)) {
                continue
            }

            deliveries.push(
                this.enqueueLive(connection, () => connection.send(event))
                    .then(() => ({ id: connection.id, ok: true }))
                    .catch(() => ({ id: connection.id, ok: false }))
            )
        }

        if (deliveries.length === 0) {
            return 0
        }

        const results = await Promise.all(deliveries)
        let successCount = 0
        for (const result of results) {
            if (result.ok) {
                successCount += 1
                continue
            }
            this.unsubscribe(result.id)
        }

        return successCount
    }

    broadcast(event: SyncEvent): void {
        const eventId = ++this.nextEventId
        this.history.push({ id: eventId, event })
        if (this.history.length > MAX_REPLAY_EVENTS) {
            this.history.splice(0, this.history.length - MAX_REPLAY_EVENTS)
        }

        for (const connection of this.connections.values()) {
            if (!this.shouldSend(connection, event)) {
                continue
            }

            void this.enqueueLive(connection, () => connection.send(event, eventId)).catch(() => {
                this.unsubscribe(connection.id)
            })
        }
    }

    stop(): void {
        this.stopHeartbeat()
        for (const connection of this.connections.values()) {
            connection.releaseReplay?.()
            connection.releaseReplay = null
            this.visibilityTracker.removeConnection(connection.id)
        }
        this.connections.clear()
        this.history.length = 0
        this.nextEventId = 0
    }

    private ensureHeartbeat(): void {
        if (this.heartbeatTimer || this.heartbeatMs <= 0) {
            return
        }

        this.heartbeatTimer = setInterval(() => {
            for (const connection of this.connections.values()) {
                void this.enqueueLive(connection, () => connection.sendHeartbeat()).catch(() => {
                    this.unsubscribe(connection.id)
                })
            }
        }, this.heartbeatMs)
    }

    private enqueueLive(connection: SSEConnection, send: () => void | Promise<void>): Promise<void> {
        const delivery = connection.sendQueue.then(() => {
            if (this.connections.get(connection.id) !== connection) {
                return
            }
            return send()
        })
        // Keep the queue usable after one disconnected stream rejects. The
        // caller still receives the original rejection and removes the stream.
        connection.sendQueue = delivery.catch(() => {})
        return delivery
    }

    private enqueueReplay(connection: SSEConnection, send: () => void | Promise<void>): Promise<void> {
        const delivery = connection.replayQueue.then(() => {
            if (this.connections.get(connection.id) !== connection) {
                return
            }
            return send()
        })
        connection.replayQueue = delivery.catch(() => {})
        return delivery
    }

    private async finishReplay(connection: SSEConnection): Promise<void> {
        const releaseReplay = connection.releaseReplay
        connection.releaseReplay = null
        releaseReplay?.()
        // Wait for live events that arrived while the replay gate was closed.
        // This keeps the caller's completion point after the stream is back in
        // normal chronological delivery order.
        await connection.sendQueue.catch(() => {})
    }

    private stopHeartbeat(): void {
        if (!this.heartbeatTimer) {
            return
        }

        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
    }

    private shouldSend(connection: SSEConnection, event: SyncEvent): boolean {
        if (event.type !== 'connection-changed') {
            const eventNamespace = event.namespace
            if (!eventNamespace || eventNamespace !== connection.namespace) {
                return false
            }
        }

        if (event.type === 'message-received' || event.type === 'scheduled-matured') {
            return connection.all || connection.sessionId === event.sessionId
        }

        if (event.type === 'connection-changed') {
            return true
        }

        if (event.type === 'session-groups-updated' || event.type === 'session-labels-updated' || event.type === 'session-pins-updated' || event.type === 'kanban-order-updated') {
            return true
        }

        if (connection.all) {
            return true
        }

        if ('sessionId' in event && connection.sessionId === event.sessionId) {
            return true
        }

        if ('machineId' in event && connection.machineId === event.machineId) {
            return true
        }

        return false
    }
}
