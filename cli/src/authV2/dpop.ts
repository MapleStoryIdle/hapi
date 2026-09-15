import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto'
import type { RunnerPrivateJwk, RunnerPublicJwk } from './credentials'

function base64UrlJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function dpopAccessTokenHash(token: string): string {
    return createHash('sha256').update(token).digest('base64url')
}

export function dpopTargetUrl(rawUrl: string): string {
    const url = new URL(rawUrl)
    url.hash = ''
    url.search = ''
    return url.toString()
}

export function createDpopProof(input: {
    method: string
    url: string
    accessToken: string
    publicJwk: RunnerPublicJwk
    privateJwk: RunnerPrivateJwk
    now?: number
    jti?: string
}): string {
    const header = base64UrlJson({
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: input.publicJwk
    })
    const payload = base64UrlJson({
        htm: input.method.toUpperCase(),
        htu: dpopTargetUrl(input.url),
        iat: Math.floor((input.now ?? Date.now()) / 1_000),
        jti: input.jti ?? randomUUID(),
        ath: dpopAccessTokenHash(input.accessToken)
    })
    const signingInput = `${header}.${payload}`
    const privateKey = createPrivateKey({ key: input.privateJwk, format: 'jwk' })
    const signature = sign('sha256', Buffer.from(signingInput), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363'
    })
    return `${signingInput}.${signature.toString('base64url')}`
}
