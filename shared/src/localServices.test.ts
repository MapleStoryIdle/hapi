import { describe, expect, it } from 'bun:test'
import { OpenLocalServiceSchema, parseLocalServiceUrl } from './localServices'

describe('local service links', () => {
    it('extracts arbitrary ports and preserves paths, query parameters, and fragments', () => {
        expect(parseLocalServiceUrl('http://localhost:43123/settings?a=1&a=2#model')).toEqual({
            protocol: 'http:', hostname: 'localhost', port: 43123,
            origin: 'http://localhost:43123', path: '/settings?a=1&a=2', hash: '#model'
        })
        expect(parseLocalServiceUrl('https://127.0.0.1/api')?.port).toBe(443)
        expect(parseLocalServiceUrl('http://[::1]:1234')?.hostname).toBe('[::1]')
        expect(parseLocalServiceUrl('HTTP://LOCALHOST')?.port).toBe(80)
    })

    it.each([
        'http://localhost.evil.test:1234/', 'http://localhost@evil.test/', 'http://user:pass@localhost:3000/',
        'http://192.168.0.1:3000/', 'http://169.254.169.254/', 'http://2130706433/', 'http://127.1/',
        'http://0x7f000001/', 'http://%6cocalhost/', 'http://localhost:0/', 'http://localhost:65536/',
        'file://localhost/file', 'ftp://127.0.0.1/', '//localhost:3000', 'http:\\localhost:3000/',
        'http://local\nhost/', 'http://localhost:3000.evil/', 'http://[::ffff:127.0.0.1]/'
    ])('rejects non-literal or unsafe destinations: %s', (url) => {
        expect(parseLocalServiceUrl(url)).toBeNull()
    })

    it('requires an explicit, bounded session source', () => {
        expect(OpenLocalServiceSchema.safeParse({ url: 'http://localhost:1234', source: { type: 'session', sessionId: 'one' } }).success).toBe(true)
        expect(OpenLocalServiceSchema.safeParse({ url: 'http://localhost:1234', source: { type: 'native-codex', sessionId: 'one' } }).success).toBe(false)
        expect(OpenLocalServiceSchema.safeParse({ url: 'http://localhost:1234', source: { type: 'session', sessionId: 'one', machineId: 'other' } }).success).toBe(false)
    })
})
