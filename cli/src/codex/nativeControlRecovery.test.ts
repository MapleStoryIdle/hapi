import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeControlRecoveryCoordinator } from './nativeControlRecovery'

describe('NativeControlRecoveryCoordinator', () => {
    it('persists one exact-thread claim and never spawns twice for retry ids', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-recovery-'))
        try {
            const coordinator = new NativeControlRecoveryCoordinator(join(directory, 'recovery.json'))
            let spawnCount = 0
            const spawn = async () => { spawnCount += 1; return { type: 'success' as const, sessionId: 'managed-1' } }
            const first = coordinator.begin({ threadId: 'thread-1', recoveryRequestId: 'request-1', cwd: '/work', spawn })
            const second = coordinator.begin({ threadId: 'thread-1', recoveryRequestId: 'request-2', cwd: '/other', spawn })
            expect(second).toBe(first)
            await Promise.resolve()
            expect(spawnCount).toBe(1)
            expect(coordinator.get('thread-1')?.sessionId).toBe('managed-1')
            const restarted = new NativeControlRecoveryCoordinator(join(directory, 'recovery.json'))
            expect(restarted.get('thread-1')).toMatchObject({ recoveryRequestId: 'request-1', status: 'unconfirmed' })
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('only marks ready for the exact persisted request and thread', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-recovery-'))
        try {
            const coordinator = new NativeControlRecoveryCoordinator(join(directory, 'recovery.json'))
            coordinator.begin({ threadId: 'thread-1', recoveryRequestId: 'request-1', cwd: '/work', spawn: async () => ({ type: 'error' as const, errorMessage: 'late' }) })
            expect(coordinator.acceptReady({ threadId: 'thread-1', recoveryRequestId: 'wrong', sessionId: 'managed-1' })).toBeNull()
            expect(coordinator.acceptReady({ threadId: 'thread-1', recoveryRequestId: 'request-1', sessionId: 'managed-1' })).toMatchObject({ status: 'ready', sessionId: 'managed-1' })
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('rejects a ready callback for a different managed child once spawn identified it', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-recovery-'))
        try {
            const coordinator = new NativeControlRecoveryCoordinator(join(directory, 'recovery.json'))
            coordinator.begin({ threadId: 'thread-1', recoveryRequestId: 'request-1', cwd: '/work', spawn: async () => ({ type: 'success' as const, sessionId: 'managed-1' }) })
            await Promise.resolve()
            expect(coordinator.acceptReady({ threadId: 'thread-1', recoveryRequestId: 'request-1', sessionId: 'managed-2' })).toBeNull()
            expect(coordinator.get('thread-1')?.status).toBe('pending')
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('does not downgrade ready when delayed spawn completion arrives', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-recovery-'))
        try {
            let complete!: (value: { type: 'error'; errorMessage: string }) => void
            const coordinator = new NativeControlRecoveryCoordinator(join(directory, 'recovery.json'))
            coordinator.begin({
                threadId: 'thread-1', recoveryRequestId: 'request-1', cwd: '/work',
                spawn: async () => await new Promise((resolve) => { complete = resolve })
            })
            coordinator.acceptReady({ threadId: 'thread-1', recoveryRequestId: 'request-1', sessionId: 'managed-1' })
            complete({ type: 'error', errorMessage: 'late timeout' })
            await Promise.resolve()
            expect(coordinator.get('thread-1')).toMatchObject({ status: 'ready', sessionId: 'managed-1' })
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('records an attached child that exits after an ambiguous ready acknowledgement', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-recovery-'))
        try {
            const coordinator = new NativeControlRecoveryCoordinator(join(directory, 'recovery.json'))
            coordinator.begin({
                threadId: 'thread-1', recoveryRequestId: 'request-1', cwd: '/work',
                spawn: async () => ({ type: 'success', sessionId: 'managed-1' })
            })
            coordinator.acceptReady({ threadId: 'thread-1', recoveryRequestId: 'request-1', sessionId: 'managed-1' })
            expect(coordinator.acceptUnconfirmed({
                threadId: 'thread-1', recoveryRequestId: 'request-1', sessionId: 'managed-1', error: 'ready acknowledgement was lost'
            })).toMatchObject({ status: 'unconfirmed', sessionId: 'managed-1' })
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
