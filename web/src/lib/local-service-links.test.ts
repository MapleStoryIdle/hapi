import { describe, expect, it } from 'vitest'
import { localServiceLaunchHref, parseLocalServiceLaunchHash } from './local-service-links'

describe('local service launch links', () => {
    it.each([
        { type: 'session' as const, sessionId: 'managed-1' },
        { type: 'native-codex' as const, sessionId: 'native-1', machineId: 'runner-2' }
    ])('keeps the exact source and private URL in the fragment: $type', (source) => {
        const url = 'http://localhost:54321/settings?token=private#model'
        const href = localServiceLaunchHref(url, source, '/shapi/')!
        const link = new URL(href, 'https://shapi.example.com')
        expect(link.pathname).toBe('/shapi/local-service')
        expect(link.search).toBe('')
        expect(parseLocalServiceLaunchHash(link.hash)).toEqual({ source, url })
    })

    it('leaves non-loopback links alone and rejects malformed launch data', () => {
        expect(localServiceLaunchHref('https://example.com', { type: 'session', sessionId: 'a' })).toBeNull()
        for (const hash of ['', '#source=not-json', '#source={}&url=http://localhost', '#'.repeat(40_000)]) {
            expect(parseLocalServiceLaunchHash(hash)).toBeNull()
        }
    })
})
