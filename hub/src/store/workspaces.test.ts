import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { RUNNER_PAIRING_POLL_INTERVAL_MS } from './workspaces'

const exportedPublicJwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
const publicJwk = JSON.stringify(exportedPublicJwk)
const canonicalPublicJwk = JSON.stringify({ crv: 'P-256', kty: 'EC', x: exportedPublicJwk.x!, y: exportedPublicJwk.y! })
const thumbprint = createHash('sha256').update(canonicalPublicJwk).digest('base64url')
const opaque = (character: string) => Buffer.alloc(32, character).toString('base64url')
const runnerToken = (character: string = 'a') => `spr${opaque(character)}`

function pairingInput(expiresAt: number) {
    return {
        runnerName: 'Mac mini',
        runnerMachineId: 'machine-a',
        runnerToken: runnerToken(),
        publicJwk,
        publicKeyThumbprint: thumbprint,
        expiresAt
    }
}

describe('WorkspaceStore', () => {
    it('maps legacy namespace tokens to stable workspaces', () => {
        const store = new Store(':memory:')
        store.workspaces.ensureLegacyWorkspace('team-a', true)
        store.workspaces.bootstrapLegacyCredentials('base')
        const first = store.workspaces.authenticate('base:team-a', 'base', 'web')
        const second = store.workspaces.authenticate('base:team-a', 'base', 'runner')
        const repeated = store.workspaces.authenticate('base:team-a', 'base', 'runner')
        expect(first?.workspace.id).toBe(second?.workspace.id)
        expect(repeated?.workspace.id).toBe(second?.workspace.id)
        expect(first?.workspace.dataNamespace).toBe('team-a')
        expect(store.workspaces.authenticate('wrong:team-a', 'base', 'web')).toBeNull()
        expect(store.workspaces.authenticate('base:unknown-team', 'base', 'web')).toBeNull()
        expect(store.workspaces.authenticate('base:default', 'base', 'web')).toBeNull()
        expect(store.workspaces.revokeKey(first!.workspace.id, first!.accessKeyId)).toBe(true)
        expect(store.workspaces.authenticate('base:team-a', 'base', 'web')).toBeNull()
        store.close()
    })

    it('uses purpose-bound independent credentials', () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Team A')
        const web = store.workspaces.issueKey(workspace.id, 'web', 'Owner')
        const runnerValue = runnerToken('r')
        const runner = store.workspaces.registerClientGeneratedKey(workspace.id, {
            kind: 'runner', name: 'Mac mini', token: runnerValue, boundMachineId: 'machine-a', publicJwk, publicKeyThumbprint: thumbprint
        })
        expect(web.token).toMatch(/^spw[A-Za-z0-9_-]+$/)
        expect(runnerValue).toMatch(/^spr[A-Za-z0-9_-]+$/)
        expect(store.workspaces.authenticate(web.token, 'legacy', 'web')?.workspace.id).toBe(workspace.id)
        expect(store.workspaces.authenticate(web.token, 'legacy', 'runner')).toBeNull()
        expect(store.workspaces.authenticate(runnerValue, 'legacy', 'runner', 'machine-a')?.workspace.id).toBe(workspace.id)
        expect(store.workspaces.authenticate(runnerValue, 'legacy', 'web')).toBeNull()
        expect(store.workspaces.revokeKey(workspace.id, runner.id)).toBe(true)
        expect(store.workspaces.authenticate(runnerValue, 'legacy', 'runner', 'machine-a')).toBeNull()
        store.close()
    })

    it('migrates v28 and registers namespaces that already own data', () => {
        const dir = mkdtempSync(join(tmpdir(), 'shapi-workspace-v29-'))
        const path = join(dir, 'hapi.db')
        const initial = new Store(path)
        initial.sessions.getOrCreateSession('tag', {}, {}, 'team-a')
        initial.close()
        const db = new Database(path)
        db.exec('DROP TABLE runner_pairings; DROP TABLE web_sessions; DROP TABLE workspace_access_keys; DROP TABLE workspaces; PRAGMA user_version=28')
        db.close()

        const migrated = new Store(path)
        migrated.workspaces.bootstrapLegacyCredentials('base')
        expect(migrated.workspaces.getByDataNamespace('team-a')?.name).toBe('team-a')
        expect(migrated.workspaces.authenticate('base:team-a', 'base', 'runner')?.workspace.dataNamespace).toBe('team-a')
        migrated.close()
        rmSync(dir, { recursive: true, force: true })
    })
})

describe('WorkspaceStore auth-v2 foundations', () => {
    it('keeps fresh default and newly created workspaces legacy-ineligible', () => {
        const store = new Store(':memory:')
        const defaultWorkspace = store.workspaces.getByDataNamespace('default')!
        const workspace = store.workspaces.create('New workspace')
        store.workspaces.bootstrapLegacyCredentials('base')

        expect(store.workspaces.authenticate('base', 'base', 'web')).toBeNull()
        expect(store.workspaces.authenticate(`base:${workspace.dataNamespace}`, 'base', 'web')).toBeNull()
        expect(store.workspaces.listKeys(defaultWorkspace.id)).toEqual([])
        expect(store.workspaces.listKeys(workspace.id)).toEqual([])
        store.close()
    })

    it('migrates v30 data, including a partial eligibility column, without changing data ids or legacy access', () => {
        const dir = mkdtempSync(join(tmpdir(), 'shapi-workspace-v30-'))
        const path = join(dir, 'hapi.db')
        const initial = new Store(path)
        const session = initial.sessions.getOrCreateSession('tag', {}, {}, 'team-a')
        initial.machines.getOrCreateMachine('machine-a', {}, {}, 'team-a')
        const message = initial.messages.addMessage(session.id, { role: 'user', text: 'kept' })
        initial.close()

        const db = new Database(path)
        db.exec(`
            DROP TABLE runner_pairings;
            DROP TABLE web_sessions;
            DROP TABLE workspace_access_keys;
            DROP TABLE workspaces;
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                data_namespace TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                legacy_eligible INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE workspace_access_keys (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK(kind IN ('legacy', 'web', 'runner')),
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                last_used_at INTEGER,
                revoked_at INTEGER
            );
            INSERT INTO workspaces(id,name,data_namespace,created_at,legacy_eligible) VALUES ('legacy-team', 'team-a', 'team-a', 1, 0);
            PRAGMA user_version=30;
        `)
        db.close()

        const migrated = new Store(path)
        expect(migrated.sessions.getSessionByNamespace(session.id, 'team-a')?.id).toBe(session.id)
        expect(migrated.machines.getMachineByNamespace('machine-a', 'team-a')?.namespace).toBe('team-a')
        expect(migrated.messages.getAllMessages(session.id)[0]?.id).toBe(message.id)
        expect(migrated.workspaces.authenticate('base:team-a', 'base', 'runner')?.workspace.id).toBe('legacy-team')
        migrated.close()
        rmSync(dir, { recursive: true, force: true })
    })

    it('issues, expires, validates csrf for, and revokes opaque web sessions', () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Team A')
        const key = store.workspaces.issueKey(workspace.id, 'web', 'Owner')
        const now = Date.now()
        const issued = store.workspaces.issueWebSession(workspace.id, key.id, 100, 1_000, now)

        expect(store.workspaces.verifyWebSessionCsrf(issued.id, issued.csrfToken)).toBe(true)
        expect(store.workspaces.verifyWebSessionCsrf(issued.id, 'wrong')).toBe(false)
        expect(store.workspaces.authenticateWebSession(issued.token, 100, now + 50)?.workspace.id).toBe(workspace.id)
        expect(store.workspaces.authenticateWebSession(issued.token, 100, now + 151)).toBeNull()
        expect(store.workspaces.revokeWebSession(workspace.id, issued.id)).toBe(true)
        const second = store.workspaces.issueWebSession(workspace.id, key.id, 1_000, 2_000)
        expect(store.workspaces.revokeWebSessionsByAccessKey(key.id)).toBe(1)
        expect(store.workspaces.authenticateWebSession(second.token, 1_000)).toBeNull()
        store.close()
    })

    it('requires canonical, machine-bound runner credentials and immutable binding metadata', () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Team A')
        expect(() => store.workspaces.registerClientGeneratedKey(workspace.id, { kind: 'web', name: 'Owner', token: 'spwshort' })).toThrow()
        expect(() => store.workspaces.registerClientGeneratedKey(workspace.id, { kind: 'runner', name: 'Runner', token: runnerToken() })).toThrow()
        expect(() => store.workspaces.registerClientGeneratedKey(workspace.id, {
            kind: 'runner', name: 'Bad runner', token: runnerToken('z'), boundMachineId: 'machine-z', publicJwk: '{"kty":"bogus"}', publicKeyThumbprint: thumbprint
        })).toThrow('Runner public-key metadata is invalid')
        const key = store.workspaces.registerClientGeneratedKey(workspace.id, {
            kind: 'runner', name: 'Runner', token: runnerToken(), boundMachineId: 'machine-a', publicJwk, publicKeyThumbprint: thumbprint
        })

        expect(store.workspaces.authenticate(runnerToken(), 'legacy', 'runner')).toBeNull()
        expect(store.workspaces.authenticate(runnerToken(), 'legacy', 'runner', 'machine-b')).toBeNull()
        expect(store.workspaces.authenticate(runnerToken(), 'legacy', 'runner', 'machine-a')?.workspace.id).toBe(workspace.id)
        expect(store.workspaces.bindRunnerKey(workspace.id, key.id, 'machine-a', publicJwk, thumbprint)).toBe(true)
        expect(store.workspaces.bindRunnerKey(workspace.id, key.id, 'machine-b', publicJwk, thumbprint)).toBe(false)
        expect(store.workspaces.bindRunnerKey(workspace.id, key.id, 'machine-a', publicJwk, 'other-thumbprint-01')).toBe(false)
        const revoked: string[] = []
        store.workspaces.setAccessKeyRevokedHandler((id) => revoked.push(id))
        expect(store.workspaces.revokeKey(workspace.id, key.id)).toBe(true)
        expect(revoked).toEqual([key.id])
        store.close()
    })

    it('uses server-issued strict Crockford codes and rate-limits polling', () => {
        const store = new Store(':memory:')
        const now = Date.now()
        expect(RUNNER_PAIRING_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000)
        const pairing = store.workspaces.issueRunnerPairing(pairingInput(now + 60_000), now, {
            deviceCode: opaque('d'), humanCode: '0123ABCD'
        })
        expect(pairing.workspaceId).toBeNull()
        expect(pairing.humanCode).toBe('0123ABCD')
        expect(store.workspaces.getRunnerPairingByHumanCode('0123ABCD')?.id).toBe(pairing.id)
        expect(store.workspaces.getRunnerPairingByHumanCode('0123-abcd')).toBeNull()
        expect(store.workspaces.pollPairing(pairing.deviceCode, now)).toEqual({ status: 'slow_down', retryAfterMs: RUNNER_PAIRING_POLL_INTERVAL_MS * 2 })
        expect(store.workspaces.getRunnerPairing(pairing.id)?.pollViolations).toBe(1)
        expect(store.workspaces.pollPairing(pairing.deviceCode, now + RUNNER_PAIRING_POLL_INTERVAL_MS * 2).status).toBe('pending')
        expect(() => store.workspaces.issueRunnerPairing(pairingInput(now + 60_000), now, { humanCode: 'SHORT' })).toThrow()
        expect(() => store.workspaces.issueRunnerPairing(pairingInput(now + 60_000), now, { deviceCode: 'short' })).toThrow()
        store.close()
    })

    it('approves exactly once, consumes once, and preserves consumed poll retry data', () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Team A')
        const now = Date.now()
        const pairing = store.workspaces.issueRunnerPairing(pairingInput(now + 60_000), now, { deviceCode: opaque('e'), humanCode: 'ABCDEFGH' })

        expect(store.workspaces.approveRunnerPairing(workspace.id, pairing.id, now)?.workspaceId).toBe(workspace.id)
        expect(store.workspaces.approveRunnerPairing(workspace.id, pairing.id, now)).toBeNull()
        const consumed = store.workspaces.consumeApprovedRunnerPairing(pairing.deviceCode, now + 1)!
        expect(consumed.state).toBe('consumed')
        expect(store.workspaces.consumeApprovedRunnerPairing(pairing.deviceCode, now + 2)?.accessKeyId).toBe(consumed.accessKeyId)
        expect(store.workspaces.pollPairing(pairing.deviceCode, now + 2)).toEqual({ status: 'consumed', accessKeyId: consumed.accessKeyId! })
        expect(store.workspaces.authenticate(runnerToken(), 'legacy', 'runner', 'machine-a')?.workspace.id).toBe(workspace.id)
        store.close()
    })

    it('does not approve or consume denied and expired pairings', () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Team A')
        const now = Date.now()
        const denied = store.workspaces.issueRunnerPairing(pairingInput(now + 60_000), now, { deviceCode: opaque('f'), humanCode: 'BCDEFGHJ' })
        expect(store.workspaces.denyRunnerPairing(denied.id, now)).toBe(true)
        expect(store.workspaces.approveRunnerPairing(workspace.id, denied.id, now)).toBeNull()
        expect(store.workspaces.consumeApprovedRunnerPairing(denied.deviceCode, now)).toBeNull()

        const expired = store.workspaces.issueRunnerPairing({ ...pairingInput(now + 1), runnerToken: runnerToken('b') }, now, { deviceCode: opaque('g'), humanCode: 'CDEFGHJK' })
        expect(store.workspaces.approveRunnerPairing(workspace.id, expired.id, now + 1)).toBeNull()
        expect(store.workspaces.pollPairing(expired.deviceCode, now + 1)).toEqual({ status: 'expired' })
        store.close()
    })
})
