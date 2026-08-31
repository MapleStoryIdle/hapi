import type { ArtifactService, RevokeShareResult } from '../artifacts/service'
import type { Store } from '../store'
import type { SyncEngine } from '../sync/syncEngine'

export type RevokeShareWithNativeCleanupResult = RevokeShareResult | {
    type: 'cleanup-pending'
    error: string
}

/**
 * Native review prompts point at a runner-private staged file. Cleanup must
 * remove the durable receipt before that file and only then delete the Hub
 * blobs/task. Keeping every record on a disconnected runner makes retry safe.
 */
export async function revokeShareWithNativeCleanup(input: {
    store: Store
    shares: ArtifactService
    engine: SyncEngine | null
    artifactId: string
    namespace: string
}): Promise<RevokeShareWithNativeCleanupResult> {
    const artifact = input.store.artifacts.findOwned(input.artifactId, input.namespace)
    if (!artifact) return { type: 'not-found' }
    const task = input.store.kanbanTasks.find(artifact.id)
    const source = task?.source
    if (!source || source.type !== 'native-codex') {
        return input.shares.revoke(artifact.id, input.namespace)
    }

    // Revoke public access before cleanup. The row and both blobs remain
    // available to this owner-only retry path until the runner confirms that
    // its receipt and staged copy are gone.
    if (!input.store.artifacts.markForDeletion(artifact.id, input.namespace)) {
        return { type: 'not-found' }
    }

    const engine = input.engine
    const machine = engine?.getMachineByNamespace(source.machineId, input.namespace)
    if (!engine || !machine?.active) {
        return { type: 'cleanup-pending', error: 'Native Codex runner is offline; feedback cleanup will retry when it reconnects' }
    }

    const clientMessageId = `hapi-kanban-review:${artifact.id}`
    try {
        const discarded = await engine.discardCodexLocalSessionMessage(source.machineId, source.codexSessionId, clientMessageId)
        if (discarded.success !== true) {
            return { type: 'cleanup-pending', error: discarded.error }
        }
        if (discarded.active) {
            return { type: 'cleanup-pending', error: 'Native Codex is still processing this feedback review' }
        }
        if (task?.feedbackSha256) {
            const deleted = await engine.deleteNativeKanbanFeedback(source.machineId, {
                artifactId: artifact.id,
                codexSessionId: source.codexSessionId,
                sha256: task.feedbackSha256
            })
            if (deleted.success !== true) return { type: 'cleanup-pending', error: deleted.error }
        }
    } catch (error) {
        return {
            type: 'cleanup-pending',
            error: error instanceof Error ? error.message : 'Native feedback cleanup could not be confirmed'
        }
    }
    return input.shares.revoke(artifact.id, input.namespace)
}
