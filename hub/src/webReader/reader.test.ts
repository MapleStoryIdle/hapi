import { describe, expect, it } from 'bun:test'
import { extractReader, readerUrl, requiresReader, readWebPage } from './reader'

describe('public reader', () => {
    it.each(['http://127.0.0.1', 'http://localhost:8317', 'http://10.1.2.3', 'http://169.254.169.254', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com:8888', 'http://2130706433'])('rejects unsafe target %s', value => {
        expect(() => readerUrl(value)).toThrow()
    })
    it('only uses reader for confirmed embedding restrictions', () => {
        const url = new URL('https://example.com/doc')
        expect(requiresReader({ 'x-frame-options': 'DENY' }, url, 'https://hapi.test')).toBe(true)
        expect(requiresReader({ 'x-frame-options': 'SAMEORIGIN' }, url, 'https://hapi.test')).toBe(true)
        expect(requiresReader({ 'x-frame-options': 'SAMEORIGIN' }, url, url.origin)).toBe(false)
        expect(requiresReader({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }, url, 'https://hapi.test')).toBe(true)
        expect(requiresReader({}, url, 'https://hapi.test')).toBe(false)
    })
    it('extracts text and code without executable HTML or attributes', () => {
        const result = extractReader(`<html><head><title>Guide</title></head><body><article><h1>Guide</h1><p>${'Useful documentation text. '.repeat(40)}</p><pre><code>const value = 1 &lt; 2</code></pre><script>alert(1)</script><p><a href="/next" onclick="steal()">Next</a><a href="javascript:evil()">Bad</a><img src="http://localhost/private" alt="Diagram"></p></article></body></html>`, new URL('https://example.com/docs'))
        expect(result.mode).toBe('readonly')
        const json = JSON.stringify(result)
        expect(json).toContain('const value = 1 ')
        expect(json).toContain('"tag":"pre"')
        expect(json).toContain('https://example.com/next')
        expect(json).not.toMatch(/onclick|steal|alert\(1\)|javascript:|localhost|"tag":"script"/)
    })
    it('blocks a private DNS result without issuing an HTTP request', async () => {
        await expect(readWebPage('http://localhost.localdomain', 'https://hapi.test')).rejects.toThrow()
    })
    it('retains real images, captions and merged table cells without copying unsafe attributes', () => {
        const result = extractReader(`<html><head><title>Image guide</title></head><body><article><p>${'Documentation with pictures and tables. '.repeat(30)}</p>
            <figure><img src="../diagram.png" width="800" height="400" alt="Diagram" onerror="evil()"><figcaption>Figure one</figcaption></figure>
            <img data-src="//cdn.example.com/lazy.webp" alt="Lazy picture">
            <table><caption>Results</caption><tbody><tr><th colspan="2">Heading</th></tr><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></tbody></table>
            </article></body></html>`, new URL('https://example.com/docs/page'))
        const json = JSON.stringify(result)
        expect(json).toContain('https://example.com/diagram.png')
        expect(json).toContain('https://cdn.example.com/lazy.webp')
        expect(json).toContain('"width":800,"height":400')
        expect(json).toContain('Figure one')
        expect(json).toContain('"colSpan":2')
        expect(json).toContain('"rowSpan":2')
        expect(json).not.toContain('onerror')
    })
})
