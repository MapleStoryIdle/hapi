import { describe, expect, it } from 'vitest'
import { getShareCacheNamespace } from './shareCacheScope'

function jwtPayload(payload: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
    return `header.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.signature`
}

describe('getShareCacheNamespace', () => {
    it('uses the signed JWT namespace claim instead of the raw bearer token', () => {
        expect(getShareCacheNamespace(jwtPayload({ ns: 'family-one', exp: 123 }))).toBe('family-one')
        expect(getShareCacheNamespace(jwtPayload({ ns: 'family-two', exp: 123 }))).toBe('family-two')
        expect(getShareCacheNamespace(jwtPayload({ ns: '少爷', exp: 123 }))).toBe('少爷')
    })

    it('keeps malformed or claim-less tokens out of another namespace cache bucket', () => {
        expect(getShareCacheNamespace('not-a-jwt')).toBe('__unknown_namespace__')
        expect(getShareCacheNamespace(jwtPayload({ exp: 123 }))).toBe('__unknown_namespace__')
    })
})
