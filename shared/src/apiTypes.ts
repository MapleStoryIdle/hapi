import { z } from 'zod'
import {
    AttachmentMetadataSchema,
    CodexCollaborationModeSchema,
    DecryptedMessageSchema,
    MachineSchema,
    PermissionModeSchema,
    SessionSchema
} from './schemas'
import { AgentFlavorSchema } from './modes'
import type {
    DecryptedMessage,
    Machine,
    Session
} from './schemas'
import type { SessionSummary } from './sessionSummary'

export const CreateOrLoadSessionRequestSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional(),
    model: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    effort: z.string().optional()
})

export type CreateOrLoadSessionRequest = z.infer<typeof CreateOrLoadSessionRequestSchema>

export const CreateOrLoadMachineRequestSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    runnerState: z.unknown().nullable().optional()
})

export type CreateOrLoadMachineRequest = z.infer<typeof CreateOrLoadMachineRequestSchema>

export const CliMessagesResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        localId: z.string().nullable().optional(),
        content: z.unknown()
    }))
})

export type CliMessagesResponse = z.infer<typeof CliMessagesResponseSchema>

export const CreateSessionResponseSchema = z.object({
    session: SessionSchema
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const CreateMachineResponseSchema = z.object({
    machine: MachineSchema
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const GetSessionResponseSchema = CreateSessionResponseSchema
export type GetSessionResponse = CreateSessionResponse

export type AuthResponse = {
    token: string
    user: {
        id: number
        username?: string
        firstName?: string
        lastName?: string
    }
}

export type SessionsResponse = { sessions: SessionSummary[] }
export type SessionResponse = { session: Session }
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        nextBeforeSeq: number | null
        nextBeforeAt: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }

export type KanbanTaskStatus =
    | 'published'
    | 'awaiting_feedback'
    | 'feedback_received'
    | 'review_sending'
    | 'review_sent'

/** Feedback-agent details are self-reported by the external agent. */
export type ShareFeedbackMetadata = {
    agent: { name: string; version: string }
    model: { provider: string; id: string; reasoningEffort: string | null }
    environment: { os: string; arch: string; runtime: string }
}

export type ShareFeedbackSummary = {
    filename: string
    size: number
    receivedAt: number
    metadata: ShareFeedbackMetadata
    reviewDeliveredAt: number | null
}

/**
 * The conversation that owns a feedback-enabled Kanban task. Native Codex
 * threads are deliberately not masqueraded as HAPI session ids.
 */
export type ShareSource =
    | { type: 'hapi'; sessionId: string }
    | { type: 'native-codex'; machineId: string; codexSessionId: string }

/** Owner-only source snapshot captured when a Kanban task is published. */
export type ShareSourceContext = {
    directoryName: string
    gitBranch: string | null
}

/** Owner-only metadata for a currently active Kanban task. */
export type ShareSummary = {
    id: string
    filename: string
    size: number
    createdAt: number
    expiresAt: number
    source: ShareSource | null
    sourceContext: ShareSourceContext | null
    status: KanbanTaskStatus
    feedback: ShareFeedbackSummary | null
}

/** Owner-only detail for a share. Legacy shares have no recoverable original URL. */
export type ShareDetails = ShareSummary & {
    url: string | null
}

export type SharesResponse = { shares: ShareSummary[] }
export type ShareResponse = { share: ShareDetails }
export type RevokeShareResponse = { ok: true }
export type ShareFeedbackResponse = {
    feedback: ShareFeedbackSummary & { content: string }
}
/** Owner-only UTF-8 text preview of an active Kanban source document. */
export type ShareContentResponse = {
    content: string
}
export type DeliverShareFeedbackResponse = {
    ok: true
    status: 'review_sent'
}

export type SpawnResponse =
    | { type: 'success'; sessionId: string; session?: Session }
    | { type: 'error'; message: string }

export const SessionPermissionModeRequestSchema = z.object({
    mode: PermissionModeSchema
})

export type SessionPermissionModeRequest = z.infer<typeof SessionPermissionModeRequestSchema>

export const ResumeSessionRequestSchema = z.object({
    permissionMode: PermissionModeSchema.optional()
})

export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>

export const ReopenSessionResponseSchema = z.object({
    ok: z.literal(true),
    sessionId: z.string(),
    resumed: z.boolean(),
    cursorSessionProtocol: z.enum(['acp', 'stream-json']).optional()
})

export type ReopenSessionResponse = z.infer<typeof ReopenSessionResponseSchema>

export const ReopenSessionMissingMetadataResponseSchema = z.object({
    error: z.string(),
    missing: z.array(z.string()).nonempty()
})

export type ReopenSessionMissingMetadataResponse = z.infer<typeof ReopenSessionMissingMetadataResponseSchema>

export const SessionCollaborationModeRequestSchema = z.object({
    mode: CodexCollaborationModeSchema
})

export type SessionCollaborationModeRequest = z.infer<typeof SessionCollaborationModeRequestSchema>

export const SessionModelRequestSchema = z.object({
    model: z.union([
        z.string().trim().min(1),
        z.object({
            provider: z.string().trim().min(1),
            modelId: z.string().trim().min(1),
        }),
    ]).nullable()
})

export type SessionModelRequest = z.infer<typeof SessionModelRequestSchema>

export const SessionModelReasoningEffortRequestSchema = z.object({
    modelReasoningEffort: z.string().trim().min(1).nullable()
})

export type SessionModelReasoningEffortRequest = z.infer<typeof SessionModelReasoningEffortRequestSchema>

export const SessionEffortRequestSchema = z.object({
    effort: z.string().trim().min(1).nullable()
})

export type SessionEffortRequest = z.infer<typeof SessionEffortRequestSchema>

// Fast mode is an explicit two-way choice. `'standard'` (not `null`) is the
// stored sentinel for an explicit Fast-off so it stays distinct from
// "untouched" and survives restart/resume. Reject anything else so stray tier
// strings are never forwarded to the Codex app-server.
export const SessionServiceTierRequestSchema = z.object({
    serviceTier: z.enum(['fast', 'standard'])
})

export type SessionServiceTierRequest = z.infer<typeof SessionServiceTierRequestSchema>

export const RenameSessionRequestSchema = z.object({
    name: z.string().min(1).max(255)
})

export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>

export type CreateSideSessionResponse =
    | { type: 'success'; sessionId: string; session?: Session }
    | { type: 'error'; message: string; code?: string }

/** Per-session legacy stream-json → ACP migrator request. See tiann/hapi#824. */
export const CursorMigrateToAcpRequestSchema = z.object({
    /** Skip removing the legacy ~/.cursor/chats source store.db even after verify passes. */
    keepSource: z.boolean().optional(),
    /** Allow migrating a session whose lifecycleState === 'running' by archiving it first. */
    forceArchiveRunning: z.boolean().optional(),
    /** Skip the verify-by-prompt step (session/load alone is run). */
    skipVerify: z.boolean().optional()
})

export type CursorMigrateToAcpRequest = z.infer<typeof CursorMigrateToAcpRequestSchema>

export type CursorMigrateOutcome =
    | { ok: true; sessionId: string; acpSessionId: string; replayNotifications: number; durationMs: number; lastUsedModelPreserved: string | null; sourceRemoved: boolean }
    | { ok: false; sessionId: string; reason: CursorMigrateRefusalReason; message: string; durationMs: number }

export type CursorMigrateRefusalReason =
    | 'not_cursor_session'
    | 'already_acp'
    | 'running_refused'
    | 'no_cursor_session_id'
    | 'no_legacy_store_on_disk'
    | 'target_already_exists'
    | 'verify_load_failed'
    | 'verify_prompt_failed'
    | 'metadata_write_failed'
    | 'archive_failed'
    | 'lock_release_timeout'
    | 'acp_transport_active'
    | 'session_resumed_during_migrate'
    | 'legacy_store_modified_during_migrate'
    | 'cross_host_session'
    | 'ambiguous_legacy_store'
    | 'size_mismatch'
    | 'internal_error'

export const UploadFileRequestSchema = z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    mimeType: z.string().min(1).max(255)
})

export type UploadFileRequest = z.infer<typeof UploadFileRequestSchema>

export type UploadFileStartRequest = {
    sessionId: string
    uploadId: string
    filename: string
    mimeType: string
    size: number
}

export type UploadFileChunkRequest = {
    sessionId: string
    uploadId: string
    offset: number
    content: string
}

export type UploadFileFinishRequest = {
    sessionId: string
    uploadId: string
}

export type UploadFileCancelRequest = UploadFileFinishRequest

export type CleanupUploadSessionRequest = {
    sessionId: string
}

export type UploadFileOperationResponse = {
    success: boolean
    error?: string
}

export const DeleteUploadRequestSchema = z.object({
    path: z.string().min(1)
})

export type DeleteUploadRequest = z.infer<typeof DeleteUploadRequestSchema>

export const MessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    beforeAt: z.coerce.number().int().min(0).optional(),
}).refine((data) => (data.beforeAt === undefined) === (data.beforeSeq === undefined), {
    message: 'beforeAt and beforeSeq must be provided together',
    path: ['beforeAt'],
})

export type MessagesQuery = z.infer<typeof MessagesQuerySchema>

export const SendMessageRequestSchema = z.object({
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional(),
    scheduledAt: z.number().int().positive().nullable().optional(),
}).refine(
    (data) => data.scheduledAt == null || typeof data.localId === 'string',
    { message: 'scheduledAt requires localId', path: ['localId'] }
).refine(
    (data) => data.scheduledAt == null || data.scheduledAt <= Date.now() + 7 * 24 * 60 * 60 * 1000,
    { message: 'scheduledAt must be within 7 days from now', path: ['scheduledAt'] }
).refine(
    (data) => data.scheduledAt == null || !data.attachments?.length,
    { message: 'scheduled messages with attachments are not supported', path: ['attachments'] }
)

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

export const SpawnSessionRequestSchema = z.object({
    directory: z.string().min(1),
    agent: AgentFlavorSchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional()
})

export type SpawnSessionRequest = z.infer<typeof SpawnSessionRequestSchema>

export const MachineListDirectoryRequestSchema = z.object({
    path: z.string().min(1)
})

export type MachineListDirectoryRequest = z.infer<typeof MachineListDirectoryRequestSchema>

export const MachinePathsExistsRequestSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export type MachinePathsExistsRequest = z.infer<typeof MachinePathsExistsRequestSchema>

export const LocalPreviewProtocolSchema = z.enum(['http', 'https'])
export type LocalPreviewProtocol = z.infer<typeof LocalPreviewProtocolSchema>

export const LocalPreviewPortSchema = z.number().int().min(1).max(65535)

export const LocalPreviewPathSchema = z.string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/'), { message: 'path must start with /' })

export const LocalPreviewCheckRequestSchema = z.object({
    protocol: LocalPreviewProtocolSchema.default('http'),
    port: LocalPreviewPortSchema,
    path: LocalPreviewPathSchema.optional().default('/'),
    sourceUrl: z.string().trim().max(4096).optional()
})

export type LocalPreviewCheckRequest = z.infer<typeof LocalPreviewCheckRequestSchema>

export const LocalPreviewProbeRequestSchema = z.object({
    protocol: LocalPreviewProtocolSchema.default('http'),
    port: LocalPreviewPortSchema,
    path: LocalPreviewPathSchema.optional().default('/')
})

export type LocalPreviewProbeRequest = z.infer<typeof LocalPreviewProbeRequestSchema>

export type LocalPreviewProbeResponse = {
    ok: boolean
    status?: number
    contentType?: string | null
    title?: string | null
    error?: string
}

export const LocalPreviewHttpMethodSchema = z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

export const LocalPreviewHttpRequestSchema = z.object({
    protocol: LocalPreviewProtocolSchema.default('http'),
    port: LocalPreviewPortSchema,
    path: LocalPreviewPathSchema,
    method: LocalPreviewHttpMethodSchema.default('GET'),
    headers: z.record(z.string(), z.string()).optional(),
    bodyBase64: z.string().optional()
})

export type LocalPreviewHttpRequest = z.infer<typeof LocalPreviewHttpRequestSchema>

export type LocalPreviewHttpResponse = {
    ok: boolean
    status: number
    statusText?: string
    headers: Record<string, string>
    bodyBase64: string
    error?: string
}

export type LocalPreviewCandidate = {
    id: string
    sessionId: string
    machineId: string
    protocol: LocalPreviewProtocol
    port: number
    path: string
    url: string
    sourceUrl?: string
    status: 'online' | 'offline'
    title?: string | null
    statusCode?: number
    error?: string
    checkedAt: number
}

export type LocalPreviewCheckResponse = {
    candidate: LocalPreviewCandidate
}

export const OpenVikingContextUriSchema = z.string()
    .trim()
    .min(9)
    .max(4096)
    .refine((value) => value === 'viking://' || value.startsWith('viking://'), {
        message: 'uri must use the viking:// scheme'
    })

export const OpenVikingContextListRequestSchema = z.object({
    uri: OpenVikingContextUriSchema.default('viking://')
})

export type OpenVikingContextListRequest = z.infer<typeof OpenVikingContextListRequestSchema>

export const OpenVikingContextReadRequestSchema = z.object({
    uri: OpenVikingContextUriSchema
})

export type OpenVikingContextReadRequest = z.infer<typeof OpenVikingContextReadRequestSchema>

export type OpenVikingContextEntry = {
    name: string
    uri: string
    isDir: boolean
    size?: number
    modTime?: string
}

export type OpenVikingContextListResponse = {
    ok: boolean
    entries?: OpenVikingContextEntry[]
    error?: string
}

export type OpenVikingContextReadResponse = {
    ok: boolean
    content?: string
    error?: string
}

export type OpenVikingStatusResponse = {
    ok: boolean
    status?: number
    version?: string
    authMode?: string
    error?: string
}

export const AuthRequestSchema = z.union([
    z.object({ initData: z.string() }),
    z.object({ accessToken: z.string() })
])

export type AuthRequest = z.infer<typeof AuthRequestSchema>

export type CommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type GitCommandResponse = CommandResponse

/** Branch probe metadata for a directory on a runner. */
export type GitBranchResponse = GitCommandResponse & {
    /** True only for a linked Git worktree, not the primary checkout. */
    isWorktree?: boolean
    /** True when tracked, staged, or untracked worktree changes exist. */
    isDirty?: boolean
}

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type GeneratedImageResponse = {
    success: boolean
    content?: string
    mimeType?: string
    fileName?: string
    error?: string
}

export type UploadFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type DeleteUploadResponse = {
    success: boolean
    error?: string
}

export type DirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
}

export type ListDirectoryResponse = {
    success: boolean
    entries?: DirectoryEntry[]
    error?: string
}

export type RpcListDirectoryResponse = ListDirectoryResponse

export type MachineDirectoryEntry = DirectoryEntry & {
    isGitRepo?: boolean
}

export type MachineListDirectoryResponse = {
    success: boolean
    entries?: MachineDirectoryEntry[]
    error?: string
}

export type PathExistsResponse = {
    exists: Record<string, boolean>
}

export type MachinePathsExistsResponse = PathExistsResponse

export type CodexModelSummary = {
    id: string
    displayName: string
    isDefault: boolean
    defaultReasoningEffort?: string | null
    supportedReasoningEfforts?: string[]
    /** Service tier ids advertised for this model in the current auth/plan context (e.g. 'fast'). */
    serviceTiers?: string[]
}

export type CodexModelsResponse = {
    success: boolean
    models?: CodexModelSummary[]
    error?: string
}

export type ListCodexModelsResponse = CodexModelsResponse

export type CodexSubscriptionLimitWindow = {
    usedPercent: number
    windowDurationMins: number | null
    resetsAt: number | null
}

export type CodexSubscriptionLimits = {
    limitId: string | null
    limitName: string | null
    planType: string | null
    primary: CodexSubscriptionLimitWindow | null
    secondary: CodexSubscriptionLimitWindow | null
    updatedAt: number
}

export type CodexSubscriptionLimitsResponse = {
    success: boolean
    limits?: CodexSubscriptionLimits
    error?: string
}

export type GetCodexSubscriptionLimitsRequest = {
    model?: string | null
}

export type GetCodexSubscriptionLimitsResponse = CodexSubscriptionLimitsResponse

export type OpencodeModelSummary = {
    modelId: string
    name?: string
}

export type OpencodeModelsResponse = {
    success: boolean
    availableModels?: OpencodeModelSummary[]
    /** CLI `agent --list-models` skus grouped under ACP wire bases for variant pickers. */
    cliModelSkus?: OpencodeModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListOpencodeModelsResponse = OpencodeModelsResponse

export type OpencodeReasoningEffortOption = {
    value: string
    name?: string
}

export type OpencodeReasoningEffortResponse = {
    success: boolean
    options?: OpencodeReasoningEffortOption[]
    currentValue?: string | null
    error?: string
}

export type CursorModelSummary = OpencodeModelSummary

export type CursorModelsResponse = OpencodeModelsResponse

export type ListCursorModelsResponse = CursorModelsResponse

/** Maps thinking levels to provider-specific values. null = unsupported. */
export type PiThinkingLevelMap = Partial<Record<string, string | null>>

export type PiModelSummary = {
    provider: string
    modelId: string
    name?: string
    contextWindow?: number
    /** Whether the model supports reasoning/thinking */
    reasoning?: boolean
    /** Maps Pi thinking levels to provider values; null = unsupported level */
    thinkingLevelMap?: PiThinkingLevelMap
}

export type PiModelsResponse = {
    success: boolean
    availableModels?: PiModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListPiModelsResponse = PiModelsResponse

export type PiCommandSummary = {
    name: string
    description?: string
    source: 'extension' | 'prompt' | 'skill'
}

export type PiCommandsResponse = {
    success: boolean
    commands?: PiCommandSummary[]
    error?: string
}

export type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user' | 'plugin' | 'project'
    content?: string
    pluginName?: string
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}
