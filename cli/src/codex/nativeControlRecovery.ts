import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/rpcTypes'

export type NativeControlRecoveryOperation = {
    threadId: string
    recoveryRequestId: string
    cwd: string
    status: 'pending' | 'ready' | 'unconfirmed'
    sessionId?: string
    error?: string
}

type PersistedFile = { version: 1; operations: NativeControlRecoveryOperation[] }

/**
 * Durable runner-local claim table.  A claim is written before a child is
 * spawned; after a crash an ambiguous launch remains unconfirmed forever
 * rather than risking a second child for the same native thread.
 */
export class NativeControlRecoveryCoordinator {
    private readonly byThread = new Map<string, NativeControlRecoveryOperation>()

    constructor(private readonly filePath: string) {
        this.load()
    }

    get(threadId: string): NativeControlRecoveryOperation | null {
        return this.byThread.get(threadId) ?? null
    }

    begin(input: { threadId: string; recoveryRequestId: string; cwd: string; spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult> }): NativeControlRecoveryOperation {
        const existing = this.byThread.get(input.threadId)
        if (existing) return existing
        const operation: NativeControlRecoveryOperation = {
            threadId: input.threadId,
            recoveryRequestId: input.recoveryRequestId,
            cwd: input.cwd,
            status: 'pending'
        }
        this.byThread.set(input.threadId, operation)
        this.save()
        void input.spawn({
            directory: input.cwd,
            agent: 'codex',
            resumeSessionId: input.threadId,
            recoveryRequestId: input.recoveryRequestId,
            recoveryNoKill: true
        }).then((result) => {
            // A ready callback may win this race. Its proof is final; a late
            // spawn completion must never turn ready back into unconfirmed.
            if (operation.status !== 'pending') return
            if (result.type === 'success') {
                operation.sessionId = result.sessionId
            } else if (result.type === 'error') {
                // A timeout is deliberately ambiguous: the detached process
                // may still make progress and must never be replaced.
                operation.status = 'unconfirmed'
                operation.error = result.errorMessage
            } else {
                operation.status = 'unconfirmed'
                operation.error = 'Recovery child requires directory approval'
            }
            this.save()
        }).catch((error) => {
            if (operation.status !== 'pending') return
            operation.status = 'unconfirmed'
            operation.error = error instanceof Error ? error.message : String(error)
            this.save()
        })
        return operation
    }

    acceptUnconfirmed(input: { recoveryRequestId: string; sessionId: string; threadId: string; error: string }): NativeControlRecoveryOperation | null {
        const operation = this.byThread.get(input.threadId)
        if (!operation || operation.recoveryRequestId !== input.recoveryRequestId) return null
        if (operation.sessionId && operation.sessionId !== input.sessionId) return null
        operation.sessionId = input.sessionId
        operation.status = 'unconfirmed'
        operation.error = input.error
        this.save()
        return operation
    }

    acceptReady(input: { recoveryRequestId: string; sessionId: string; threadId: string }): NativeControlRecoveryOperation | null {
        const operation = this.byThread.get(input.threadId)
        if (!operation || operation.recoveryRequestId !== input.recoveryRequestId) return null
        if (operation.sessionId && operation.sessionId !== input.sessionId) return null
        operation.sessionId = input.sessionId
        operation.status = 'ready'
        delete operation.error
        this.save()
        return operation
    }

    private load(): void {
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PersistedFile>
            if (parsed.version !== 1 || !Array.isArray(parsed.operations)) return
            let changed = false
            for (const candidate of parsed.operations) {
                if (!candidate || typeof candidate.threadId !== 'string' || typeof candidate.recoveryRequestId !== 'string' || typeof candidate.cwd !== 'string') continue
                if (candidate.status !== 'pending' && candidate.status !== 'ready' && candidate.status !== 'unconfirmed') continue
                // A restarted runner cannot know whether a prior detached
                // child got past resume. Keep the claim, but fail closed.
                const restored = candidate.status === 'pending'
                    ? { ...candidate, status: 'unconfirmed' as const, error: candidate.error ?? 'Runner restarted while recovery was pending' }
                    : { ...candidate }
                changed ||= restored.status !== candidate.status
                this.byThread.set(candidate.threadId, restored)
            }
            if (changed) this.save()
        } catch {}
    }

    private save(): void {
        const directory = dirname(this.filePath)
        mkdirSync(directory, { recursive: true })
        const temporary = `${this.filePath}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify({ version: 1, operations: [...this.byThread.values()] } satisfies PersistedFile), { mode: 0o600 })
        renameSync(temporary, this.filePath)
        if (existsSync(this.filePath)) chmodSync(this.filePath, 0o600)
    }
}
