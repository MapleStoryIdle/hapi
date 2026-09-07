import { describe, expect, it } from 'bun:test'
import { localServiceUnavailable } from './unavailable'

describe('local service connection failure', () => {
    it.each([
        ['zh-CN,zh;q=0.9,en;q=0.8', '无法连接服务器', '重新连接'],
        ['en-US,en;q=0.9,zh;q=0.8', 'Unable to connect to the server', 'Try again'],
    ])('uses the preferred language %s and keeps retry inside the sandbox', async (language, message, retry) => {
        const response = localServiceUnavailable(new Request('https://hub.test/private-grant?secret=1', { headers: {
            'sec-fetch-dest': 'iframe', 'accept-language': language
        } }), ['https://hub.test'])
        expect(response.status).toBe(502)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.has('location')).toBe(false)
        const html = await response.text()
        expect(html).toContain(message)
        expect(html).toContain(retry)
        expect(html).toContain('location.reload()')
        expect(html).not.toMatch(/<a\b|window.open|private-grant|secret=1/)
        const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1]
        expect(nonce).toBeTruthy()
        const csp = response.headers.get('content-security-policy')!
        expect(csp).toContain(`script-src 'nonce-${nonce}'`)
        expect(csp).toContain('sandbox allow-scripts;')
        expect(csp).toContain('frame-ancestors https://hub.test')
        expect(csp).not.toContain('allow-same-origin')
    })

    it.each([
        { method: 'POST', headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } },
        { method: 'GET', headers: { 'sec-fetch-dest': 'empty', accept: 'application/json' } },
        { method: 'GET', headers: { 'sec-fetch-dest': 'script', accept: '*/*' } },
        { method: 'HEAD', headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } },
    ])('does not replace resource errors or offer to replay unsafe requests: %j', async (options) => {
        const response = localServiceUnavailable(new Request('https://hub.test/', options))
        expect(response.status).toBe(502)
        expect(response.headers.get('content-type')).toContain('text/plain')
        expect(await response.text()).toBe(options.method === 'HEAD' ? '' : 'Unable to connect to the server')
    })
})
