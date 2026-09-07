import { expect, it } from 'bun:test'
import { PreviewRewriteQueue } from './previewRewriteQueue'

it('queues a burst in order without increasing the active rewrite limit', async () => {
    const queue = new PreviewRewriteQueue(1, 2)
    const signal = new AbortController().signal
    const first = await queue.acquire(signal)
    const order: number[] = []
    const second = queue.acquire(signal).then((release) => { order.push(2); return release })
    const third = queue.acquire(signal).then((release) => { order.push(3); return release })
    expect(await queue.acquire(signal)).toBeNull()
    expect(order).toEqual([])
    first!()
    const releaseSecond = await second
    expect(order).toEqual([2])
    first!() // Duplicate completion must not make a second slot available.
    await Promise.resolve()
    expect(order).toEqual([2])
    releaseSecond!()
    const releaseThird = await third
    releaseThird!()
    expect(order).toEqual([2, 3])
})

it('removes cancelled waiters and refuses an already-aborted request', async () => {
    const queue = new PreviewRewriteQueue(1, 1)
    const first = await queue.acquire(new AbortController().signal)
    const controller = new AbortController()
    const waiting = queue.acquire(controller.signal)
    controller.abort(new Error('Disconnected'))
    await expect(waiting).rejects.toThrow('Disconnected')
    await expect(queue.acquire(controller.signal)).rejects.toThrow('Disconnected')
    const next = queue.acquire(new AbortController().signal)
    first!()
    const release = await next
    expect(release).toBeTypeOf('function')
    release!()
})
