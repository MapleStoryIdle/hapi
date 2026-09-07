import { createHash } from 'node:crypto'

// Parse identifiers, never replace route strings or user text. Local lexical
// bindings named window/location retain their original meaning.
const transpiler = new Bun.Transpiler({
    loader: 'js', target: 'browser', minifyWhitespace: true,
    // Untrusted page code must NEVER invoke Bun macros on the Hub. Bun 1.3
    // supports false at runtime; its bundled types omit this boolean branch.
    // @ts-expect-error Bun.Transpiler macro:false disables compile-time execution.
    macro: false,
    define: {
        window: 'globalThis.__SHAPI_PREVIEW_WINDOW__',
        location: 'globalThis.__SHAPI_PREVIEW_LOCATION__',
        'globalThis.location': 'globalThis.__SHAPI_PREVIEW_LOCATION__',
        'self.location': 'globalThis.__SHAPI_PREVIEW_LOCATION__',
        // Do not substitute the Hub's environment or force sites into dev mode.
        'process.env.NODE_ENV': 'process.env.NODE_ENV'
    }
})
const cache = new Map<string, string>()
let cacheBytes = 0
const MAX_CACHE_BYTES = 8 * 1024 * 1024

export function rewritePreviewScript(source: string): string {
    const key = createHash('sha256').update(source).digest('hex')
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const output = transpiler.transformSync(source)
    const bytes = Buffer.byteLength(output)
    if (bytes <= MAX_CACHE_BYTES) {
        while (cache.size >= 32 || cacheBytes + bytes > MAX_CACHE_BYTES) {
            const first = cache.keys().next().value
            if (first === undefined) break
            cacheBytes -= Buffer.byteLength(cache.get(first)!)
            cache.delete(first)
        }
        cache.set(key, output)
        cacheBytes += bytes
    }
    return output
}
