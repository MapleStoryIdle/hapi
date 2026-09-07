/** Bound buffered rewrites, but let a normal burst of SPA chunks wait its turn. */
export class PreviewRewriteQueue {
    private active = 0
    private readonly waiting = new Set<() => void>()

    constructor(private readonly capacity = 4, private readonly maxWaiting = 32) {}

    acquire(signal: AbortSignal): Promise<(() => void) | null> {
        if (signal.aborted) return Promise.reject(signal.reason)
        if (this.active < this.capacity) return Promise.resolve(this.reserve())
        if (this.waiting.size >= this.maxWaiting) return Promise.resolve(null)
        return new Promise((resolve, reject) => {
            const cancel = () => {
                this.waiting.delete(start)
                reject(signal.reason)
            }
            const start = () => {
                signal.removeEventListener('abort', cancel)
                resolve(this.reserve())
            }
            this.waiting.add(start)
            signal.addEventListener('abort', cancel, { once: true })
        })
    }

    private reserve(): () => void {
        this.active++
        let released = false
        return () => {
            if (released) return
            released = true
            this.active--
            const next = this.waiting.values().next().value
            if (next) {
                this.waiting.delete(next)
                next()
            }
        }
    }
}
