import type { ShareSource } from '@hapi/protocol/apiTypes'

export type StoredSession = {
    id: string
    tag: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    model: string | null
    modelReasoningEffort: string | null
    effort: string | null
    serviceTier: string | null
    todos: unknown | null
    todosUpdatedAt: number | null
    teamState: unknown | null
    teamStateUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMachine = {
    id: string
    namespace: string
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    runnerState: unknown | null
    runnerStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredMessage = {
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
    invokedAt: number | null
    scheduledAt: number | null
}

export type StoredUser = {
    id: number
    platform: string
    platformUserId: string
    namespace: string
    createdAt: number
}

export type StoredPushSubscription = {
    id: number
    namespace: string
    endpoint: string
    p256dh: string
    auth: string
    createdAt: number
}

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }

export type StoredArtifact = {
    id: string
    namespace: string
    tokenHash: string
    /**
     * The original public bearer URL for shares created after the share-manager
     * copy feature was introduced. Legacy shares intentionally have null here.
     */
    publicUrl: string | null
    filename: string
    size: number
    sha256: string
    createdAt: number
    expiresAt: number
    revokedAt: number | null
}

/**
 * One publicly shared file is one Kanban task. The feedback document itself
 * intentionally lives outside SQLite so a database export does not include
 * untrusted agent content.
 */
export type KanbanTaskStatus =
    | 'published'
    | 'awaiting_feedback'
    | 'feedback_received'
    | 'review_sending'
    | 'review_sent'

export type FeedbackMetadata = {
    agent: {
        name: string
        version: string
    }
    model: {
        provider: string
        id: string
        reasoningEffort: string | null
    }
    environment: {
        os: string
        arch: string
        runtime: string
    }
}

export type StoredKanbanTask = {
    artifactId: string
    namespace: string
    source: ShareSource | null
    status: KanbanTaskStatus
    feedbackRequest: string | null
    feedbackTokenHash: string | null
    feedbackLeaseId: string | null
    feedbackLeaseExpiresAt: number | null
    feedbackFilename: string | null
    feedbackSize: number | null
    feedbackSha256: string | null
    feedbackMetadata: FeedbackMetadata | null
    feedbackReceivedAt: number | null
    reviewDeliveredAt: number | null
    createdAt: number
    updatedAt: number
}
