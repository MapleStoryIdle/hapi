import { afterEach, describe, expect, it } from 'bun:test'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { LOCAL_SERVICE_CHUNK_BYTES, type LocalServiceFrame, type LocalServiceFrameHandler } from './localServices'
import { LocalServicePeer, type LocalServiceWire } from './localServiceTransport'

const leaseId = 'a'.repeat(32)
const id = 'b'.repeat(32)
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function wireFixture(options: ConstructorParameters<typeof LocalServicePeer>[1]) {
    let receive!: LocalServiceFrameHandler
    let disconnect!: () => void
    const sent: Array<{ frame: LocalServiceFrame; ack: (ok: boolean) => void }> = []
    const wire: LocalServiceWire = {
        connected: () => true,
        send: (frame, ack) => { sent.push({ frame, ack }) },
        listen(handler, onDisconnect) { receive = handler; disconnect = onDisconnect; return () => {} }
    }
    const peer = new LocalServicePeer(wire, options)
    cleanups.push(() => peer.dispose())
    return { peer, sent, receive: (frame: unknown, ack = (_ok: boolean) => {}) => receive(frame, ack), disconnect: () => disconnect() }
}

describe('bounded binary local service transport', () => {
    it('does not acknowledge an incoming chunk until the destination write completes', async () => {
        let complete!: () => void
        const destination = new Duplex({ read() {}, write(_bytes, _encoding, done) { complete = done } })
        const f = wireFixture({ open: async () => destination, release: () => {}, disconnect: () => {} })
        expect(await new Promise((resolve) => f.receive({ type: 'open', id, leaseId }, resolve))).toBe(true)
        let acknowledged = false
        f.receive({ type: 'data', id, seq: 0, bytes: Buffer.alloc(LOCAL_SERVICE_CHUNK_BYTES) }, (ok) => { acknowledged = ok })
        await tick()
        expect(acknowledged).toBe(false)
        complete()
        await tick()
        expect(acknowledged).toBe(true)
        f.peer.release(leaseId)
        expect(destination.destroyed).toBe(true)
    })

    it('waits for each acknowledgment and slices large reads into 64 KiB frames', async () => {
        const f = wireFixture({ release: () => {}, disconnect: () => {} })
        const stream = Duplex.from({ readable: Readable.from([Buffer.alloc(LOCAL_SERVICE_CHUNK_BYTES * 3, 7)]), writable: new Writable({ write(_chunk, _encoding, done) { done() } }) })
        cleanups.push(() => stream.destroy())
        f.peer.connect(leaseId, stream)
        expect(f.sent.shift()!.frame.type).toBe('open')
        // No data before the open acknowledgment.
        await tick()
        expect(f.sent).toHaveLength(0)
        // A separate stream exercises the acknowledged path.
        const active = new PassThrough()
        cleanups.push(() => active.destroy())
        f.peer.connect(leaseId, active)
        f.sent.shift()!.ack(true)
        active.end(Buffer.alloc(LOCAL_SERVICE_CHUNK_BYTES * 3, 9))
        for (let index = 0; index < 3; index++) {
            await tick()
            expect(f.sent).toHaveLength(1)
            const item = f.sent.shift()!
            expect(item.frame.type).toBe('data')
            if (item.frame.type !== 'data') throw new Error('Expected binary data')
            expect(item.frame.bytes.length).toBe(LOCAL_SERVICE_CHUNK_BYTES)
            expect(item.frame.seq).toBe(index)
            await tick()
            expect(f.sent).toHaveLength(0)
            item.ack(true)
        }
    })

    it('rejects oversized frames, bad sequence numbers and unexpected reverse opens', async () => {
        const stream = new PassThrough()
        const f = wireFixture({ open: async () => stream, release: () => {}, disconnect: () => {} })
        const receive = (frame: unknown) => new Promise<boolean>((resolve) => f.receive(frame, resolve))
        expect(await receive({ type: 'open', id, leaseId })).toBe(true)
        expect(await receive({ type: 'data', id, seq: 0, bytes: Buffer.alloc(LOCAL_SERVICE_CHUNK_BYTES + 1) })).toBe(false)
        expect(await receive({ type: 'data', id, seq: 4, bytes: Buffer.from('bad order') })).toBe(false)
        expect(stream.destroyed).toBe(true)
        const hub = wireFixture({ release: () => {}, disconnect: () => {} })
        expect(await new Promise((resolve) => hub.receive({ type: 'open', id, leaseId }, resolve))).toBe(false)
    })

    it('cancels a pending local connect and destroys late connections on release', async () => {
        let finish!: (stream: Duplex) => void
        let signal!: AbortSignal
        const f = wireFixture({
            open: async (_lease, abort) => { signal = abort; return await new Promise((resolve) => { finish = resolve }) },
            release: () => {}, disconnect: () => {}
        })
        const opened = new Promise<boolean>((resolve) => f.receive({ type: 'open', id, leaseId }, resolve))
        f.peer.release(leaseId)
        expect(signal.aborted).toBe(true)
        const stream = new PassThrough()
        finish(stream)
        expect(await opened).toBe(false)
        expect(stream.destroyed).toBe(true)
    })

    it('caps concurrent channels per lease and drops work on disconnect rather than replaying', async () => {
        const f = wireFixture({ release: () => {}, disconnect: () => {} })
        const streams = Array.from({ length: 25 }, () => new PassThrough())
        for (const stream of streams) f.peer.connect(leaseId, stream)
        expect(f.sent).toHaveLength(24)
        expect(streams[24].destroyed).toBe(true)
        f.disconnect()
        for (const stream of streams) expect(stream.destroyed).toBe(true)
        expect(f.peer.connected).toBe(false)
        for (const item of f.sent) item.ack(true)
        await tick()
        expect(f.sent).toHaveLength(24)
    })
})
