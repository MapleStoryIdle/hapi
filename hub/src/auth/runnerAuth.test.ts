import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { SignJWT, type JWK } from 'jose'
import { Store } from '../store'
import { RunnerAuthService } from './runnerAuth'

const JWT_SECRET = new TextEncoder().encode('runner-auth-test-secret')
const LEGACY_TOKEN = 'legacy-test-token'
const MACHINE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TARGET = 'https://hub.example.test/api/v2/runner/token'

function runnerToken(): string {
    return `spr${Buffer.alloc(32, 'r').toString('base64url')}`
}

function keyMaterial() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const publicJwk = pair.publicKey.export({ format: 'jwk' })
    const canonical = JSON.stringify({
        crv: 'P-256',
        kty: 'EC',
        x: publicJwk.x!,
        y: publicJwk.y!,
    })
    return {
        privateKey: pair.privateKey,
        publicJwk,
        serializedPublicJwk: canonical,
        thumbprint: createHash('sha256').update(canonical).digest('base64url'),
    }
}

async function proof(input: {
    privateKey: KeyObject
    publicJwk: JWK
    token: string
    method?: string
    target?: string
    jti?: string
}): Promise<string> {
    return await new SignJWT({
        htm: input.method ?? 'POST',
        htu: input.target ?? TARGET,
        iat: Math.floor(Date.now() / 1000),
        jti: input.jti ?? randomUUID(),
        ath: createHash('sha256').update(input.token).digest('base64url'),
    })
        .setProtectedHeader({
            alg: 'ES256',
            typ: 'dpop+jwt',
            jwk: input.publicJwk,
        })
        .sign(input.privateKey)
}

describe('RunnerAuthService', () => {
    it('exchanges a bound spr only with a valid non-replayed DPoP proof', async () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Runner')
        const token = runnerToken()
        const key = keyMaterial()
        store.workspaces.registerClientGeneratedKey(workspace.id, {
            kind: 'runner',
            name: 'Laptop',
            token,
            boundMachineId: MACHINE_ID,
            publicJwk: key.serializedPublicJwk,
            publicKeyThumbprint: key.thumbprint,
        })
        const service = new RunnerAuthService(store, JWT_SECRET)
        const jti = randomUUID()
        const validProof = await proof({
            privateKey: key.privateKey,
            publicJwk: key.publicJwk,
            token,
            jti,
        })
        const grant = await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: MACHINE_ID,
            proof: validProof,
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        })
        expect(grant).toMatchObject({
            workspaceId: workspace.id,
            machineId: MACHINE_ID,
            expiresIn: 300,
        })

        expect(await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: MACHINE_ID,
            proof: validProof,
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        })).toBeNull()
        expect(await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: MACHINE_ID,
            proof: await proof({
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                token,
                method: 'GET',
            }),
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        })).toBeNull()
        expect(await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: MACHINE_ID,
            proof: await proof({
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                token: `${token}wrong`,
            }),
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        })).toBeNull()
        expect(await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: MACHINE_ID,
            proof: await proof({
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                token,
                target: `${TARGET}/wrong`,
            }),
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        })).toBeNull()
        expect(await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            proof: await proof({ privateKey: key.privateKey, publicJwk: key.publicJwk, token }),
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        })).toBeNull()
        store.close()
    })

    it('validates access-token ath, issues one-use tickets, and observes revocation', async () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Runner')
        const token = runnerToken()
        const key = keyMaterial()
        const { id: accessKeyId } = store.workspaces.registerClientGeneratedKey(workspace.id, {
            kind: 'runner',
            name: 'Laptop',
            token,
            boundMachineId: MACHINE_ID,
            publicJwk: key.serializedPublicJwk,
            publicKeyThumbprint: key.thumbprint,
        })
        const service = new RunnerAuthService(store, JWT_SECRET)
        const grant = (await service.exchangeRunnerCredential({
            runnerToken: token,
            machineId: MACHINE_ID,
            proof: await proof({ privateKey: key.privateKey, publicJwk: key.publicJwk, token }),
            method: 'POST',
            targetUrl: TARGET,
            legacyBaseToken: LEGACY_TOKEN,
        }))!
        const ticketTarget = 'https://hub.example.test/api/v2/runner/socket-tickets'
        const identity = await service.authenticateRunnerAccess({
            accessToken: grant.accessToken,
            proof: await proof({
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                token: grant.accessToken,
                target: ticketTarget,
            }),
            method: 'POST',
            targetUrl: ticketTarget,
        })
        expect(identity).toMatchObject({ workspaceId: workspace.id, accessKeyId, machineId: MACHINE_ID })

        const issued = service.issueSocketTicket(identity!)
        expect(issued.expiresIn).toBe(30)
        expect(service.consumeSocketTicket(issued.ticket)).toMatchObject({ accessKeyId })
        expect(service.consumeSocketTicket(issued.ticket)).toBeNull()

        const revokedTicket = service.issueSocketTicket(identity!)
        store.workspaces.revokeKey(workspace.id, accessKeyId)
        expect(service.consumeSocketTicket(revokedTicket.ticket)).toBeNull()
        expect(await service.authenticateRunnerAccess({
            accessToken: grant.accessToken,
            proof: await proof({
                privateKey: key.privateKey,
                publicJwk: key.publicJwk,
                token: grant.accessToken,
                target: ticketTarget,
            }),
            method: 'POST',
            targetUrl: ticketTarget,
        })).toBeNull()
        store.close()
    })
})
