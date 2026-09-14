import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDpopProof, dpopAccessTokenHash } from './dpop'
import { generateRunnerKeyMaterial } from './credentials'

function decodeJson(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('createDpopProof', () => {
    it('creates a verifiable ES256 proof with normalized htu and ath', () => {
        const keys = generateRunnerKeyMaterial()
        const proof = createDpopProof({
            method: 'post',
            url: 'https://hub.example.test/cli/sessions?after=1#ignored',
            accessToken: 'access-token',
            publicJwk: keys.publicJwk,
            privateJwk: keys.privateJwk,
            now: 1_710_000_000_000,
            jti: 'proof-id'
        })
        const [encodedHeader, encodedPayload, encodedSignature] = proof.split('.')

        expect(decodeJson(encodedHeader!)).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: keys.publicJwk })
        expect(decodeJson(encodedPayload!)).toEqual({
            htm: 'POST',
            htu: 'https://hub.example.test/cli/sessions',
            iat: 1_710_000_000,
            jti: 'proof-id',
            ath: dpopAccessTokenHash('access-token')
        })
        expect(Buffer.from(encodedSignature!, 'base64url')).toHaveLength(64)
        expect(verify(
            'sha256',
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            { key: createPublicKey({ key: keys.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
            Buffer.from(encodedSignature!, 'base64url')
        )).toBe(true)
    })
})
