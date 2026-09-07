import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import {
    LOCAL_SERVICE_CHUNK_BYTES, LOCAL_SERVICE_FRAME_TIMEOUT_MS,
    LOCAL_SERVICE_MAX_CONNECTIONS, LOCAL_SERVICE_MAX_PER_MACHINE,
    type LocalServiceFrame, type LocalServiceFrameHandler
} from './localServices'

const id = z.string().regex(/^[a-f0-9]{32}$/)
const seq = z.number().int().nonnegative()
const FrameSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('open'), id, leaseId: id }).strict(),
    z.object({ type: z.literal('data'), id, seq, bytes: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= LOCAL_SERVICE_CHUNK_BYTES) }).strict(),
    z.object({ type: z.literal('end'), id, seq }).strict(),
    z.object({ type: z.literal('close'), id }).strict(),
    z.object({ type: z.literal('release'), leaseId: id }).strict()
])

export type LocalServiceWire = {
    connected: () => boolean
    send: (frame: LocalServiceFrame, ack: (accepted: boolean) => void) => void
    listen: (handler: LocalServiceFrameHandler, disconnect: () => void) => () => void
}

/** Adapter uses the existing authenticated machine Socket.IO connection, never a new listener. */
export function localServiceSocketWire(socket: {
    connected: boolean
    on(event: 'local-service:frame', handler: LocalServiceFrameHandler): unknown
    on(event: 'disconnect', handler: () => void): unknown
    off(event: 'local-service:frame', handler: LocalServiceFrameHandler): unknown
    off(event: 'disconnect', handler: () => void): unknown
    timeout(ms: number): { emit(event: 'local-service:frame', frame: LocalServiceFrame, ack: (error: Error | null, accepted?: boolean) => void): unknown }
}): LocalServiceWire {
    return {
        connected: () => socket.connected,
        send(frame, ack) {
            if (!socket.connected) { ack(false); return }
            socket.timeout(LOCAL_SERVICE_FRAME_TIMEOUT_MS).emit('local-service:frame', frame, (error, accepted) => ack(!error && accepted === true))
        },
        listen(handler, disconnect) {
            socket.on('local-service:frame', handler)
            socket.on('disconnect', disconnect)
            return () => { socket.off('local-service:frame', handler); socket.off('disconnect', disconnect) }
        }
    }
}

type Channel = {
    id: string
    leaseId: string
    abort: AbortController
    stream?: Duplex
    active: boolean
    sending: boolean
    receiving: boolean
    sentEnd: boolean
    receivedEnd: boolean
    tx: number
    rx: number
}

/** One 64 KiB frame in flight per direction/channel. No offline replay or whole-body buffering. */
export class LocalServicePeer {
    private readonly channels = new Map<string, Channel>()
    private readonly unlisten: () => void
    private disposed = false

    constructor(private readonly wire: LocalServiceWire, private readonly options: {
        open?: (leaseId: string, signal: AbortSignal) => Promise<Duplex>
        release: (leaseId: string) => void
        disconnect: () => void
        activity?: (leaseId: string) => void
    }) {
        this.unlisten = wire.listen((frame, ack) => { void this.receive(frame, ack) }, () => this.dispose())
    }

    get connected(): boolean { return !this.disposed && this.wire.connected() }

    private reserve(channelId: string, leaseId: string): Channel | null {
        if (!this.connected || this.channels.has(channelId)
            || this.channels.size >= LOCAL_SERVICE_MAX_CONNECTIONS * LOCAL_SERVICE_MAX_PER_MACHINE
            || [...this.channels.values()].filter((c) => c.leaseId === leaseId).length >= LOCAL_SERVICE_MAX_CONNECTIONS) return null
        const channel: Channel = {
            id: channelId, leaseId, abort: new AbortController(), active: false,
            sending: false, receiving: false, sentEnd: false, receivedEnd: false, tx: 0, rx: 0
        }
        this.channels.set(channelId, channel)
        return channel
    }

    connect(leaseId: string, stream: Duplex): void {
        if (stream.destroyed) return
        const channel = this.reserve(randomBytes(16).toString('hex'), leaseId)
        if (!channel) { stream.destroy(); return }
        this.attach(channel, stream)
        this.wire.send({ type: 'open', id: channel.id, leaseId }, (ok) => {
            if (!ok) { this.close(channel, true); return }
            if (channel.abort.signal.aborted) return
            channel.active = true
            this.pump(channel)
        })
    }

    private attach(channel: Channel, stream: Duplex): void {
        channel.stream = stream
        stream.pause()
        stream.on('error', () => this.close(channel, true))
        stream.once('close', () => this.close(channel, true))
        stream.on('readable', () => this.pump(channel))
        stream.once('end', () => this.pump(channel))
    }

    private pump(channel: Channel): void {
        const stream = channel.stream
        if (!channel.active || channel.sending || channel.sentEnd || channel.abort.signal.aborted || !stream) return
        const bytes = stream.read(Math.min(stream.readableLength, LOCAL_SERVICE_CHUNK_BYTES)) as Buffer | null
        let frame: LocalServiceFrame
        if (bytes?.length) frame = { type: 'data', id: channel.id, seq: channel.tx++, bytes }
        else if (stream.readableEnded) {
            channel.sentEnd = true
            frame = { type: 'end', id: channel.id, seq: channel.tx++ }
        } else return
        channel.sending = true
        this.options.activity?.(channel.leaseId)
        this.wire.send(frame, (ok) => {
            channel.sending = false
            if (!ok) { this.close(channel, true); return }
            // Yield between frames; preview traffic must not monopolize chat's connection/event loop.
            setImmediate(() => this.pump(channel))
        })
    }

    private async receive(raw: unknown, ack: (accepted: boolean) => void): Promise<void> {
        if (typeof ack !== 'function') return
        const parsed = FrameSchema.safeParse(raw)
        if (!parsed.success || !this.connected) { ack(false); return }
        const frame = parsed.data
        if (frame.type === 'release') { this.release(frame.leaseId, false); ack(true); return }
        if (frame.type === 'open') {
            const channel = this.options.open ? this.reserve(frame.id, frame.leaseId) : null
            if (!channel) { ack(false); return }
            try {
                const stream = await this.options.open!(frame.leaseId, channel.abort.signal)
                if (channel.abort.signal.aborted || stream.destroyed) { stream.destroy(); this.close(channel, false); ack(false); return }
                this.attach(channel, stream)
                channel.active = true
                ack(true)
                this.pump(channel)
            } catch { this.close(channel, false); ack(false) }
            return
        }
        const channel = this.channels.get(frame.id)
        if (!channel) { ack(frame.type === 'close'); return }
        if (frame.type === 'close') { this.close(channel, false); ack(true); return }
        const stream = channel.stream
        if (!stream || channel.receiving || channel.receivedEnd || frame.seq !== channel.rx++) {
            this.close(channel, true); ack(false); return
        }
        channel.receiving = true
        this.options.activity?.(channel.leaseId)
        const complete = (error?: Error | null) => { channel.receiving = false; ack(!error && !channel.abort.signal.aborted) }
        if (frame.type === 'end') {
            channel.receivedEnd = true
            stream.end(complete)
        } else stream.write(frame.bytes, complete)
    }

    private close(channel: Channel, notify: boolean): void {
        if (channel.abort.signal.aborted) return
        this.channels.delete(channel.id)
        channel.abort.abort()
        channel.stream?.destroy()
        if (notify && this.connected) this.wire.send({ type: 'close', id: channel.id }, () => {})
    }

    release(leaseId: string, notify = true): void {
        for (const channel of this.channels.values()) if (channel.leaseId === leaseId) this.close(channel, false)
        this.options.release(leaseId)
        if (notify && this.connected) this.wire.send({ type: 'release', leaseId }, () => {})
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.unlisten()
        for (const channel of this.channels.values()) this.close(channel, false)
        this.options.disconnect()
    }
}
