import { describe, expect, it } from 'bun:test'
import type { StoredRemoteServerCandidate } from './types'
import { Store } from './index'
import type { VerifyRemoteServerCandidateResult } from './remoteServers'

function makeStore(): Store {
    return new Store(':memory:')
}

function makeSession(store: Store, tag: string) {
    return store.sessions.getOrCreateSession(
        tag,
        { path: `/tmp/${tag}`, host: 'test-host', flavor: 'codex', machineId: 'machine-a' },
        null,
        'default'
    )
}

function expectCandidateResult(
    result: VerifyRemoteServerCandidateResult
): Extract<VerifyRemoteServerCandidateResult, { status: 'candidate-created' }> {
    expect(result.status).toBe('candidate-created')
    if (result.status !== 'candidate-created') {
        throw new Error(`Expected candidate-created, got ${result.status}`)
    }
    return result
}

function expectCandidate(result: VerifyRemoteServerCandidateResult): StoredRemoteServerCandidate {
    return expectCandidateResult(result).candidate
}

describe('RemoteServerStore', () => {
    it('dedupes pending candidates by namespace, workspace, user, host, and port', () => {
        const store = makeStore()
        const session = makeSession(store, 'remote-candidate-dedupe')

        const first = store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            machineId: 'machine-a',
            host: ' 10.0.0.8 ',
            user: ' deploy ',
            port: 22,
            workspace: 'prod',
            tags: ['api', 'api', ''],
            sourceProject: 'hapi',
            sourceProjectPath: '/repo/hapi',
            sourceSessionTitle: 'Deploy check',
            detectedCommandKind: 'ssh',
            detectedToolCallId: 'tool-a'
        })
        const firstResult = expectCandidateResult(first)
        const firstCandidate = firstResult.candidate
        expect(firstCandidate.alias).toBe('未命名')

        const second = store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            machineId: 'machine-b',
            host: '10.0.0.8',
            user: 'deploy',
            port: 22,
            alias: 'prod-api',
            workspace: 'prod',
            tags: ['web'],
            sourceProject: 'hapi',
            sourceProjectPath: '/repo/hapi',
            sourceSessionTitle: 'Deploy check',
            detectedCommandKind: 'rsync',
            detectedToolCallId: 'tool-b'
        })
        const secondResult = expectCandidateResult(second)
        const secondCandidate = secondResult.candidate

        expect(firstResult.created).toBe(true)
        expect(secondResult.created).toBe(false)
        expect(secondCandidate.id).toBe(firstCandidate.id)
        expect(secondCandidate.machineId).toBe('machine-b')
        expect(secondCandidate.alias).toBe('prod-api')
        expect(secondCandidate.tags).toEqual(['web'])
        expect(secondCandidate.detectedCommandKind).toBe('rsync')
        expect(store.remoteServers.listRemoteServerCandidates('default', 'pending')).toHaveLength(1)

        const accepted = store.remoteServers.acceptRemoteServerCandidate(secondCandidate.id, 'default', {})
        if (accepted.status !== 'accepted') {
            throw new Error(`Expected accepted, got ${accepted.status}`)
        }
        expect(accepted.server.alias).toBe('prod-api')
        expect(store.remoteServers.hasConnection(accepted.server.id, 'machine-a')).toBe(true)
        expect(store.remoteServers.hasConnection(accepted.server.id, 'machine-b')).toBe(true)
    })

    it('accepts a candidate and treats the same workspace target as already recorded', () => {
        const store = makeStore()
        const session = makeSession(store, 'remote-candidate-accept')
        const candidate = expectCandidate(store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            machineId: 'machine-a',
            host: '10.0.0.9',
            user: 'ubuntu',
            alias: 'db-main',
            workspace: 'prod',
            tags: ['db'],
            sourceProject: 'hapi',
            sourceProjectPath: '/repo/hapi',
            sourceSessionTitle: 'DB check',
            detectedCommandKind: 'ssh'
        }))

        const accepted = store.remoteServers.acceptRemoteServerCandidate(candidate.id, 'default', {})
        expect(accepted.status).toBe('accepted')
        if (accepted.status !== 'accepted') {
            throw new Error(`Expected accepted, got ${accepted.status}`)
        }
        expect(accepted.created).toBe(true)
        expect(accepted.server.workspace).toBe('prod')
        expect(accepted.server.alias).toBe('db-main')
        expect(accepted.server.tags).toEqual(['db'])
        expect(accepted.candidate.status).toBe('accepted')

        const updated = store.remoteServers.updateRemoteServer(accepted.server.id, 'default', { alias: '' })
        expect(updated?.alias).toBe('未命名')

        const repeated = store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            machineId: 'machine-b',
            host: '10.0.0.9',
            user: 'ubuntu',
            workspace: 'prod',
            sourceProject: 'hapi',
            sourceProjectPath: '/repo/hapi',
            sourceSessionTitle: 'DB check',
            detectedCommandKind: 'ssh'
        })
        expect(repeated.status).toBe('already-recorded')
        if (repeated.status !== 'already-recorded') {
            throw new Error(`Expected already-recorded, got ${repeated.status}`)
        }
        expect(repeated.server.id).toBe(accepted.server.id)
    })

    it('allows the same user and host in different workspaces', () => {
        const store = makeStore()
        const session = makeSession(store, 'remote-candidate-workspace')
        const candidate = expectCandidate(store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            host: '10.0.0.10',
            user: 'root',
            workspace: 'prod',
            sourceProject: 'hapi',
            sourceProjectPath: null,
            sourceSessionTitle: null,
            detectedCommandKind: 'ssh'
        }))
        const accepted = store.remoteServers.acceptRemoteServerCandidate(candidate.id, 'default', {})
        expect(accepted.status).toBe('accepted')

        const staging = store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            host: '10.0.0.10',
            user: 'root',
            workspace: 'staging',
            sourceProject: 'hapi',
            sourceProjectPath: null,
            sourceSessionTitle: null,
            detectedCommandKind: 'ssh'
        })

        expect(staging.status).toBe('candidate-created')
        if (staging.status !== 'candidate-created') {
            throw new Error(`Expected candidate-created, got ${staging.status}`)
        }
        expect(staging.candidate.workspace).toBe('staging')
    })

    it('clears session remote server bindings when a server is deleted', () => {
        const store = makeStore()
        const session = makeSession(store, 'remote-server-delete')
        const candidate = expectCandidate(store.remoteServers.verifyRemoteServerCandidate({
            namespace: 'default',
            sessionId: session.id,
            host: '10.0.0.11',
            user: 'root',
            workspace: 'prod',
            sourceProject: 'hapi',
            sourceProjectPath: null,
            sourceSessionTitle: null,
            detectedCommandKind: 'ssh'
        }))
        const accepted = store.remoteServers.acceptRemoteServerCandidate(candidate.id, 'default', {})
        if (accepted.status !== 'accepted') {
            throw new Error(`Expected accepted, got ${accepted.status}`)
        }

        expect(store.sessions.setSessionRemoteServerId(session.id, accepted.server.id, 'default')).toBe(true)
        expect(store.sessions.getSession(session.id)?.remoteServerId).toBe(accepted.server.id)

        expect(store.remoteServers.deleteRemoteServer(accepted.server.id, 'default')).toBe(true)
        expect(store.sessions.getSession(session.id)?.remoteServerId).toBeNull()
    })
})
