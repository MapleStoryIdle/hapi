import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { GeneratedImageStore } from '../../../generatedImages/store'
import { Store, type StoredSession } from '../../../store'
import type { SyncEvent } from '../../../sync/syncEngine'
import type { CliSocketWithData } from '../../socketTypes'
import { registerSessionHandlers } from './sessionHandlers'

class FakeSocket {
    readonly roomEvents: Array<{ room: string; event: string; data: unknown }> = []
    private readonly handlers = new Map<string, (data: unknown, ack?: (response: unknown) => void) => void>()

    on(event: string, handler: (data: unknown, ack?: (response: unknown) => void) => void): this {
        this.handlers.set(event, handler)
        return this
    }

    to(room: string): { emit: (event: string, data: unknown) => void } {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEvents.push({ room, event, data })
            }
        }
    }

    trigger(event: string, data: unknown, ack?: (response: unknown) => void): void {
        this.handlers.get(event)?.(data, ack)
    }
}

function redundantGoalStatusContent(message: string): unknown {
    return {
        role: 'agent',
        content: {
            id: `event-${message}`,
            type: 'event',
            data: { type: 'message', message }
        }
    }
}

describe('cli session handlers', () => {
    it('does not turn unconsumed immediate or scheduled input into sent messages on session end', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('unsent-session-end', {}, null, 'default')
        const socket = new FakeSocket()
        const events: SyncEvent[] = []
        const now = Date.now()
        for (const [localId, scheduledAt] of [['immediate', null], ['mature', now - 1_000], ['future', now + 60_000]] as const) {
            store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: localId } }, localId, scheduledAt)
        }
        let ended = false
        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => { throw new Error('unexpected access error') },
            onWebappEvent: event => { events.push(event) },
            onSessionEnd: () => { ended = true }
        })

        socket.trigger('session-end', { sid: session.id, time: now })

        expect(ended).toBe(true)
        expect(store.messages.getUninvokedLocalMessages(session.id)).toHaveLength(3)
        expect(store.messages.getMatureScheduledMessages(now).map(row => row.localId)).toEqual(['mature'])
        expect(events.some(event => event.type === 'messages-consumed')).toBe(false)
    })

    it('persists generated-image bytes before the agent process exits', async () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('generated-image-store-session', {}, null, 'default')
        const socket = new FakeSocket()
        const rootDir = await mkdtemp(join(tmpdir(), 'hapi-generated-image-handler-'))
        const images = new GeneratedImageStore(rootDir)
        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            generatedImageStore: images
        })

        try {
            const response = await new Promise<unknown>((resolve) => {
                socket.trigger('generated-image:store', {
                    sid: session.id,
                    imageId: 'image-1',
                    fileName: 'preview.png',
                    mimeType: 'image/png',
                    bytes: pngBytes
                }, resolve)
            })

            expect(response).toEqual({ success: true })
            await expect(images.read('default', 'image-1')).resolves.toEqual({
                bytes: Buffer.from(pngBytes),
                mimeType: 'image/png',
                fileName: 'preview.png'
            })
        } finally {
            await rm(rootDir, { recursive: true, force: true })
        }
    })

    it('drops redundant goal status events before persistence and broadcast', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('goal-status-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: redundantGoalStatusContent('Goal active · 8016 tokens')
        })

        expect(store.messages.getMessages(session.id)).toHaveLength(0)
        expect(socket.roomEvents).toHaveLength(0)
        expect(webEvents).toHaveLength(0)
    })

    it('persists and broadcasts automation heartbeats for formatted web rendering', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('heartbeat-filter-session', {}, null, 'default')
        const socket = new FakeSocket()
        const webEvents: SyncEvent[] = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onWebappEvent: (event) => {
                webEvents.push(event)
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: {
                role: 'user',
                content: {
                    type: 'text',
                    text: '<heartbeat> <automation_id>bug</automation_id> <decision>DONT_NOTIFY</decision> <message>Nothing to report.</message> </heartbeat>'
                }
            }
        })

        expect(store.messages.getMessages(session.id)).toHaveLength(1)
        expect(socket.roomEvents).toHaveLength(1)
        expect(webEvents).toHaveLength(1)
    })


    it('records generated-image messages as session activity', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession('generated-image-session', {}, null, 'default')
        const socket = new FakeSocket()
        const activities: Array<{ sessionId: string; updatedAt: number }> = []

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            },
            onSessionActivity: (sessionId, updatedAt) => {
                activities.push({ sessionId, updatedAt })
            }
        })

        socket.trigger('message', {
            sid: session.id,
            message: {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'generated-image',
                        imageId: 'image-1',
                        fileName: 'preview.png',
                        mimeType: 'image/png'
                    }
                }
            }
        })

        // display_image / image generation produces a standalone visible message.
        // It must touch the session so the web list/cache refreshes immediately,
        // without waiting for a later text message.
        expect(activities).toHaveLength(1)
        expect(activities[0]?.sessionId).toBe(session.id)
        expect(store.messages.getMessages(session.id)).toHaveLength(1)
    })

    it('update-metadata broadcasts the merged value, not the pre-merge payload', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'broadcast-merged',
            {
                path: '/tmp/project',
                host: 'example',
                cursorSessionId: 'broadcast-survives'
            },
            null,
            'default'
        )
        const socket = new FakeSocket()

        registerSessionHandlers(socket as unknown as CliSocketWithData, {
            store,
            resolveSessionAccess: () => ({ ok: true, value: session as StoredSession }),
            emitAccessError: () => {
                throw new Error('unexpected access error')
            }
        })

        let ackResponse: unknown = null
        socket.trigger(
            'update-metadata',
            {
                sid: session.id,
                expectedVersion: session.metadataVersion,
                metadata: {
                    lifecycleState: 'archived',
                    archivedBy: 'cli',
                    archiveReason: 'Session crashed'
                }
            },
            (response) => {
                ackResponse = response
            }
        )

        // Ack: success and the version bumps; the persisted value carries the
        // merged metadata so other CLIs can update their cache to the truth.
        const ack = ackResponse as { result: string; version: number; metadata: unknown }
        expect(ack.result).toBe('success')
        const ackMetadata = ack.metadata as Record<string, unknown>
        expect(ackMetadata.cursorSessionId).toBe('broadcast-survives')
        expect(ackMetadata.path).toBe('/tmp/project')

        // Broadcast: the room event must carry the same merged value.
        const broadcast = socket.roomEvents.find((event) => event.event === 'update')
        expect(broadcast).toBeDefined()
        const broadcastBody = (broadcast?.data as { body: { metadata: { value: Record<string, unknown> } } }).body
        expect(broadcastBody.metadata.value.cursorSessionId).toBe('broadcast-survives')
        expect(broadcastBody.metadata.value.path).toBe('/tmp/project')
        expect(broadcastBody.metadata.value.lifecycleState).toBe('archived')
    })
})
