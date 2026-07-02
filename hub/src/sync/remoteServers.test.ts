import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(store: Store = new Store(':memory:')): SyncEngine {
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    engine.stop()
    return engine
}

describe('remote server context', () => {
    it('only binds a verified server to Codex sessions on the same runner', () => {
        const engine = createEngine()
        const session = engine.getOrCreateSession(
            'remote-context-machine-a',
            { path: '/tmp/project-a', host: 'localhost', flavor: 'codex', machineId: 'machine-a' },
            null,
            'default'
        )
        const verify = engine.verifyRemoteServerCandidate(session.id, 'default', {
            host: '10.0.1.5',
            user: 'ubuntu',
            workspace: 'prod',
            detectedCommandKind: 'ssh'
        })
        expect(verify.type).toBe('candidate-created')
        if (verify.type !== 'candidate-created') {
            throw new Error(`Expected candidate-created, got ${verify.type}`)
        }

        const accepted = engine.acceptRemoteServerCandidate(verify.candidate.id, 'default', {})
        expect(accepted.type).toBe('accepted')
        if (accepted.type !== 'accepted') {
            throw new Error(`Expected accepted, got ${accepted.type}`)
        }

        const sameRunner = engine.setSessionRemoteServerContext(session.id, 'default', accepted.server.id)
        expect(sameRunner.ok).toBe(true)

        const otherSession = engine.getOrCreateSession(
            'remote-context-machine-b',
            { path: '/tmp/project-b', host: 'localhost', flavor: 'codex', machineId: 'machine-b' },
            null,
            'default'
        )
        const otherRunner = engine.setSessionRemoteServerContext(otherSession.id, 'default', accepted.server.id)
        expect(otherRunner.ok).toBe(false)
        if (otherRunner.ok) {
            throw new Error('Expected other runner to be rejected')
        }
        expect(otherRunner.code).toBe('server_not_verified_for_machine')
    })

    it('rejects remote server context for unsupported agent flavors', () => {
        const engine = createEngine()
        const codexSession = engine.getOrCreateSession(
            'remote-context-codex',
            { path: '/tmp/project-codex', host: 'localhost', flavor: 'codex', machineId: 'machine-a' },
            null,
            'default'
        )
        const verify = engine.verifyRemoteServerCandidate(codexSession.id, 'default', {
            host: '10.0.1.6',
            user: 'ubuntu',
            workspace: 'prod',
            detectedCommandKind: 'ssh'
        })
        if (verify.type !== 'candidate-created') {
            throw new Error(`Expected candidate-created, got ${verify.type}`)
        }
        const accepted = engine.acceptRemoteServerCandidate(verify.candidate.id, 'default', {})
        if (accepted.type !== 'accepted') {
            throw new Error(`Expected accepted, got ${accepted.type}`)
        }

        const claudeSession = engine.getOrCreateSession(
            'remote-context-claude',
            { path: '/tmp/project-claude', host: 'localhost', flavor: 'claude', machineId: 'machine-a' },
            null,
            'default'
        )
        const result = engine.setSessionRemoteServerContext(claudeSession.id, 'default', accepted.server.id)
        expect(result.ok).toBe(false)
        if (result.ok) {
            throw new Error('Expected unsupported agent to be rejected')
        }
        expect(result.code).toBe('unsupported_agent')
    })
})
