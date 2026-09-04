import type {
    DecryptedMessage as ProtocolDecryptedMessage,
    Machine,
    RunnerState,
    Session,
    SessionSummary,
    SyncEvent as ProtocolSyncEvent,
    WorktreeMetadata
} from '@hapi/protocol/types'
import type { SlashCommand } from '@hapi/protocol/apiTypes'

export type {
    CodexModelsResponse,
    CodexModelSummary,
    CodexSubscriptionLimitsResponse,
    CodexSubscriptionLimits,
    CodexSubscriptionLimitWindow,
    CommandResponse,
    CreateSideSessionResponse,
    CursorModelsResponse,
    CursorModelSummary,
    DeleteUploadResponse,
    DirectoryEntry,
    FileReadResponse,
    GitCommandResponse,
    ListDirectoryResponse,
    OpenVikingContextEntry,
    OpenVikingContextListResponse,
    OpenVikingContextReadResponse,
    OpenVikingStatusResponse,
    MachineDirectoryEntry,
    MachineListDirectoryResponse,
    MachinePathsExistsResponse,
    AuthResponse,
    MachinesResponse,
    MessagesResponse,
    OpencodeModelsResponse,
    OpencodeModelSummary,
    PathExistsResponse,
    PiModelSummary,
    PiModelsResponse,
    PiThinkingLevelMap,
    RevokeShareResponse,
    DeliverShareFeedbackResponse,
    ShareContentResponse,
    ShareFeedbackResponse,
    ShareFeedbackSummary,
    ShareFeedbackMetadata,
    ShareSourceContext,
    KanbanTaskStatus,
    ShareDetails,
    ShareResponse,
    ShareSummary,
    SharesResponse,
    SlashCommand,
    SlashCommandsResponse,
    SessionResponse,
    SessionsResponse,
    SpawnResponse,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'

export type {
    AgentState,
    AttachmentMetadata,
    CodexCollaborationMode,
    CodexSubagentState,
    Metadata,
    PermissionMode,
    Machine,
    MachineHealth,
    PendingRequest,
    PendingRequestKind,
    RunnerState,
    Session,
    SessionPatch,
    SessionSummary,
    SessionSummaryMetadata,
    SideSessionMetadata,
    TeamMember,
    TeamMessage,
    TeamState,
    TeamTask,
    ThreadGoal,
    ThreadGoalStatus,
    TodoItem,
    WorktreeMetadata
} from '@hapi/protocol/types'

export type { HapiSessionExport } from '@hapi/protocol/sessionExport'

export type SessionMetadataSummary = {
    path: string
    host: string
    version?: string
    name?: string
    os?: string
    summary?: { text: string; updatedAt: number }
    machineId?: string
    tools?: string[]
    flavor?: string | null
    capabilities?: {
        terminal?: boolean
    }
    worktree?: WorktreeMetadata
}

export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed'

export type DecryptedMessage = ProtocolDecryptedMessage & {
    status?: MessageStatus
    originalText?: string
    invokedAt?: number | null
}

export type FileSearchItem = {
    fileName: string
    filePath: string
    fullPath: string
    fileType: 'file' | 'folder'
}

export type FileSearchResponse = {
    success: boolean
    files?: FileSearchItem[]
    error?: string
}

export type GitFileStatus = {
    fileName: string
    filePath: string
    fullPath: string
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
    isStaged: boolean
    linesAdded: number
    linesRemoved: number
    oldPath?: string
}

export type GitStatusFiles = {
    stagedFiles: GitFileStatus[]
    unstagedFiles: GitFileStatus[]
    branch: string | null
    totalStaged: number
    totalUnstaged: number
}

export type SkillSummary = {
    name: string
    description?: string
    scope?: 'project' | 'user' | 'plugin' | 'system' | 'admin'
}

export type SkillsResponse = {
    success: boolean
    skills?: SkillSummary[]
    error?: string
}

export type PushSubscriptionKeys = {
    p256dh: string
    auth: string
}

export type PushSubscriptionPayload = {
    endpoint: string
    keys: PushSubscriptionKeys
}

export type PushUnsubscribePayload = {
    endpoint: string
}

export type PushVapidPublicKeyResponse = {
    publicKey: string
}

export type CodexDesktopScriptResponse = {
    success: boolean
    message?: string
    pid?: number
    command?: string
    script?: string
    cwd?: string
    output?: string
    error?: string
    codexDesktopRunning?: boolean
    codexClientAvailable?: boolean
    // 中文注释：多选导入时返回实际处理完成的 Codex 会话数量，用于前端提示本次导入条数。
    syncedCount?: number
    // 中文注释：这里存放本次导入对应的 Codex thread ID 列表，方便日志和排查 direct import 结果。
    sessionIds?: string[]
}

export type CodexLocalSessionSummary = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    originator?: string | null
    cliVersion?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    runState?: CodexLocalSessionRunState
    waitingForUserInput?: boolean
    /** Explicit false from current runners clears a stale SSH ownership lock. */
    controlledByCodexSsh?: boolean
}

export type CodexLocalSessionsResponse = {
    success: true
    sessions: CodexLocalSessionSummary[]
}

export type CodexLocalSessionContextMessage = {
    id: string
    createdAt: number
    /** Stable transcript order when multiple entries share a timestamp. */
    position?: number
    content: {
        role: 'user' | 'agent'
        content: unknown
        meta?: unknown
    }
}

/** Direct native child thread rendered through the shared CodexAgent card. */
export type CodexLocalSessionSubagent = {
    id: string
    parentSessionId: string
    name?: string | null
    role?: string | null
    agentPath?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    status: 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'
    statusText?: string | null
    startedAt: number
    updatedAt: number
    completedAt?: number
    traceMessages: Array<{
        createdAt?: number
        role: 'agent'
        content: {
            type: 'codex'
            data: unknown
        }
        meta?: unknown
    }>
}

export type CodexLocalSessionContextResponse = {
    success: true
    session: Pick<CodexLocalSessionSummary, 'id' | 'title' | 'cwd' | 'modifiedAt' | 'model' | 'modelReasoningEffort' | 'controlledByCodexSsh'>
    messages: CodexLocalSessionContextMessage[]
    subagents?: CodexLocalSessionSubagent[]
    page: {
        limit: number
        nextBefore: number | null
        hasMore: boolean
    }
    /** Runner-local transcript revision when the response came from /snapshot. */
    revision?: number
}

export type CodexLocalSessionRunState = 'idle' | 'processing' | 'unknown'

export type CodexLocalSessionPlanStep = {
    text: string
    status: 'pending' | 'in_progress' | 'completed'
}

export type CodexLocalSessionPlan = {
    turnId: string
    callId: string
    steps: CodexLocalSessionPlanStep[]
}

export type CodexLocalSessionDirectSendPhase =
    | 'launching'
    | 'matching'
    | 'connected'
    | 'retrying'
    | 'reasoning'

export type CodexLocalSessionDirectSendProgress = {
    phase: CodexLocalSessionDirectSendPhase
    startedAt: number
    phaseStartedAt: number
    transport: 'app-server' | 'exec-resume'
    attempt?: number
}

export type CodexLocalSessionDirectSendRecoveryReason =
    | 'codex_timeout'
    | 'session_status_unknown'
    | 'launch_failed'
    | 'runner_restarted'
    | 'external_writer_active'

export type CodexLocalSessionStatusResponse =
    | {
        success: true
        status: CodexLocalSessionRunState
        activeTurnId?: string
        waitingForUserInput?: boolean
        /** Current runners always include true or false. */
        controlledByCodexSsh?: boolean
        stalledSince?: number
        startedAt?: number
        progress?: CodexLocalSessionDirectSendProgress
        lastError?: string
        lastErrorAt?: number
        lastErrorClientMessageId?: string
        lastErrorCode?: CodexLocalSessionDirectSendRecoveryReason
        queuedMessages?: CodexLocalSessionQueuedMessage[]
    }
    | {
        success: false
        error: string
    }

export type CodexLocalSessionComposerCapabilitiesResponse =
    | {
        success: true
        commands: SlashCommand[]
        skills: SkillSummary[]
    }
    | {
        success: false
        error: string
    }

export type CodexLocalSessionSnapshotVersion = {
    runnerEpoch: string
    revision: number
}

export type CodexLocalSessionSnapshotResponse = CodexLocalSessionContextResponse & {
    unchanged?: false
    status: Extract<CodexLocalSessionStatusResponse, { success: true }>
    /** Full snapshot only; realtime carries only activeTurnId. */
    plan?: CodexLocalSessionPlan | null
    /** Missing only when an older runner answers the snapshot RPC. */
    version?: CodexLocalSessionSnapshotVersion
    revision: number
    timing: {
        cache: 'hit' | 'miss'
        durationMs: number
    }
}

export type CodexLocalSessionSnapshotReadResponse = CodexLocalSessionSnapshotResponse | {
    success: true
    unchanged: true
    status: Extract<CodexLocalSessionStatusResponse, { success: true }>
    version: CodexLocalSessionSnapshotVersion
    revision: number
    session?: CodexLocalSessionContextResponse['session']
    timing: {
        cache: 'hit' | 'miss'
        durationMs: number
    }
}

export type CodexLocalSessionRealtimeSnapshot = {
    version: CodexLocalSessionSnapshotVersion
    revision: number
    status: Omit<Extract<CodexLocalSessionStatusResponse, { success: true }>, 'queuedMessages'> & {
        queuedMessageRefs?: Array<Pick<
            CodexLocalSessionQueuedMessage,
            'id' | 'recoveryRequired' | 'recoveryReason'
        >>
    }
    timing: {
        cache: 'hit' | 'miss'
        durationMs: number
    }
}

export type SendCodexLocalSessionMessageResponse =
    | {
        success: true
        status: 'processing' | 'queued'
        startedAt?: number
        progress?: CodexLocalSessionDirectSendProgress
        queuedAt?: number
        queuePosition?: number
        queueId?: string
        queuedMessages?: CodexLocalSessionQueuedMessage[]
    }
    | {
        success: false
        error: string
        code?: string
    }

export type DiscardCodexLocalSessionMessageResponse =
    | {
        success: true
        discarded: boolean
        /** The receipt may still belong to an active native Codex turn. */
        active?: boolean
        queuedMessages: CodexLocalSessionQueuedMessage[]
    }
    | {
        success: false
        error: string
        code?: string
    }

export type ArchiveCodexLocalSessionResponse =
    | { success: true }
    | {
        success: false
        error: string
        code?: string
    }

export type CodexLocalSessionQueuedMessage = {
    id: string
    text: string
    queuedAt: number
    recoveryRequired?: boolean
    recoveryReason?: CodexLocalSessionDirectSendRecoveryReason
}

export type ForkCodexLocalSessionResponse =
    | { type: 'success'; sessionId: string; session?: Session }
    | {
        type: 'error'
        code?: 'hub_unavailable' | 'invalid_fork_request' | 'runner_offline' | 'session_read_failed' | 'session_not_found' | 'workspace_missing' | 'codex_home_unavailable' | 'fork_spawn_failed'
        message: string
    }

export type CodexDesktopSyncRequest = {
    // 中文注释：前端弹窗直接提交 Codex thread ID，后端会按这些 transcript 直接导入到 SHAPI。
    sessionIds: string[]
}

export type CodexDesktopStatusResponse = {
    success: true
    codexDesktopRunning: boolean
    codexClientAvailable: boolean
}

export type CodexDuplicateSessionGroup = {
    codexSessionId: string
    hapiSessionIds: string[]
    canonicalSessionId?: string
    removedSessionIds?: string[]
}

export type CodexDuplicateSessionsResponse = {
    success: true
    // 中文注释：这里只返回本次选中导入的 codexSessionId 中检测出来的重复会话，不包含未勾选的其它会话。
    duplicates: CodexDuplicateSessionGroup[]
} | {
    success: false
    error: string
}

export type CodexMergeDuplicateSessionsResponse = {
    success: true
    merged: CodexDuplicateSessionGroup[]
    mergedCount: number
} | {
    success: false
    error: string
}

export type VisibilityPayload = {
    subscriptionId: string
    visibility: 'visible' | 'hidden'
}

export type SyncEvent = ProtocolSyncEvent
