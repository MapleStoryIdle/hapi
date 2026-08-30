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
    remoteServerId: string | null
    todos: unknown | null
    todosUpdatedAt: number | null
    teamState: unknown | null
    teamStateUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    seq: number
}

export type StoredRemoteServer = {
    id: string
    namespace: string
    name: string
    alias: string
    host: string
    user: string
    port: number
    workspace: string
    tags: string[]
    sourceProject: string
    sourceProjectPath: string | null
    sourceSessionId: string
    sourceSessionTitle: string | null
    machineId: string | null
    machineIds: string[]
    lastVerifiedAt: number | null
    lastUsedAt: number
    createdAt: number
    updatedAt: number
}

export type StoredRemoteServerCandidateStatus = 'pending' | 'accepted' | 'dismissed'
export type StoredRemoteServerDetectedCommandKind = 'ssh' | 'scp' | 'rsync'

export type StoredRemoteServerCandidate = {
    id: string
    namespace: string
    machineId: string | null
    sessionId: string
    status: StoredRemoteServerCandidateStatus
    name: string
    alias: string
    host: string
    user: string
    port: number
    workspace: string
    tags: string[]
    sourceProject: string
    sourceProjectPath: string | null
    sourceSessionTitle: string | null
    detectedCommandKind: StoredRemoteServerDetectedCommandKind
    detectedToolCallId: string | null
    existingServerId: string | null
    verifiedAt: number
    lastSeenAt: number
    createdAt: number
    updatedAt: number
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
