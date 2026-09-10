import type { AgentFlavor, CodexCollaborationMode, PermissionMode } from '@hapi/protocol/types'
import { randomUUID } from 'node:crypto'
import { MAX_UPLOAD_CHUNK_BYTES } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RenameNativeCodexSessionResponse } from '@hapi/protocol/apiTypes'
import { LOCAL_SERVICE_RPC, type LocalServiceTunnelRequest } from '@hapi/protocol/localServices'
import { openLocalServiceSocketTunnel, type LocalServiceTunnel } from '../localServices/socketTransport'
import type {
    CodexLocalSessionComposerCapabilitiesRpcResponse,
    ArchiveCodexLocalSessionRpcResponse,
    CodexLocalSessionDataRpcResponse,
    CodexLocalSessionSnapshotReadOptions,
    CodexLocalSessionSnapshotRpcResponse,
    CodexLocalSessionStatusRpcResponse,
    CodexLocalSessionsRpcResponse,
    DiscardCodexLocalSessionMessageRpcResponse,
    NativeCodexDeliveryPolicy,
    NativeCodexAttachment,
    NativeKanbanFeedbackReviewGuard,
    NativeCodexSessionControlAction,
    NativeCodexSessionControlResponse,
    SendCodexLocalSessionMessageRpcResponse
} from '@hapi/protocol/codexTranscript'
import type {
    BinaryFileReadRequest,
    BinaryFileReadResponse,
    NativeKanbanFeedbackDeleteRequest,
    NativeKanbanFeedbackDeleteResponse,
    NativeKanbanFeedbackStageRequest,
    NativeKanbanFeedbackStageResponse,
    NativeCodexAttachmentDeleteRequest,
    NativeCodexAttachmentDeleteResponse,
    NativeCodexAttachmentStageRequest,
    NativeCodexAttachmentStageResponse
} from '@hapi/protocol'
import type {
    CodexSubscriptionLimitsResponse,
    GetCodexSubscriptionLimitsRequest,
    CodexModelSummary,
    CodexModelsResponse,
    CommandResponse,
    CursorModelSummary,
    CursorModelsResponse,
    DeleteUploadResponse,
    DirectoryEntry,
    FileReadResponse,
    GeneratedImageResponse,
    GitBranchResponse,
    GitBranchesResponse,
    LocalPreviewHttpRequest,
    LocalPreviewHttpResponse,
    LocalPreviewProbeRequest,
    LocalPreviewProbeResponse,
    OpenVikingContextListRequest,
    OpenVikingContextListResponse,
    OpenVikingContextReadRequest,
    OpenVikingContextReadResponse,
    OpenVikingStatusResponse,
    ListDirectoryResponse,
    MachineGitBranchCreateRequest,
    MachineGitBranchCommitRequest,
    MachineGitBranchFetchRequest,
    MachineGitBranchPushRequest,
    MachineGitBranchSwitchRequest,
    MachineGitBranchUpdateRequest,
    OpencodeModelsResponse,
    OpencodeModelSummary,
    OpencodeReasoningEffortResponse,
    PathExistsResponse,
    SlashCommandsResponse,
    UploadFileCancelRequest,
    UploadFileChunkRequest,
    UploadFileFinishRequest,
    UploadFileOperationResponse,
    UploadFileStartRequest,
    UploadFileResponse
} from '@hapi/protocol/apiTypes'
import type { Server, Socket } from 'socket.io'
import type { RpcRegistry } from '../socket/rpcRegistry'

const DEFAULT_RPC_TIMEOUT_MS = 30_000
const MODEL_LIST_RPC_TIMEOUT_MS = 120_000
const SIDE_SESSION_FORK_RPC_TIMEOUT_MS = 90_000
const GIT_BRANCH_MUTATION_RPC_TIMEOUT_MS = 45_000
const GIT_BRANCH_REMOTE_RPC_TIMEOUT_MS = 75_000
const UPLOAD_CANCEL_TIMEOUT_MS = 5_000

/**
 * tiann/hapi#916: thrown by {@link RpcGateway.rpcCall} when the target CLI is
 * unreachable (handler not registered or socket disconnected). Callers can
 * narrow on this to treat "CLI gone" as a benign condition (e.g. archive
 * still succeeds at the hub level) without swallowing real RPC errors like
 * timeouts or protocol failures.
 */
export class RpcTargetMissingError extends Error {
    readonly code: 'handler-not-registered' | 'socket-disconnected'
    readonly method: string

    constructor(method: string, reason: 'handler-not-registered' | 'socket-disconnected') {
        super(reason === 'handler-not-registered'
            ? `RPC handler not registered: ${method}`
            : `RPC socket disconnected: ${method}`)
        this.name = 'RpcTargetMissingError'
        this.code = reason
        this.method = method
    }
}

export type RpcCommandResponse = CommandResponse
export type RpcGitBranchResponse = GitBranchResponse
export type RpcGitBranchesResponse = GitBranchesResponse
export type RpcReadFileResponse = FileReadResponse
export type RpcGeneratedImageResponse = GeneratedImageResponse
export type RpcUploadFileResponse = UploadFileResponse
export type RpcDeleteUploadResponse = DeleteUploadResponse
export type RpcDirectoryEntry = DirectoryEntry
export type RpcListDirectoryResponse = ListDirectoryResponse
export type RpcPathExistsResponse = PathExistsResponse
export type RpcCodexModel = CodexModelSummary
export type RpcListCodexModelsResponse = CodexModelsResponse
export type RpcGetCodexSubscriptionLimitsResponse = CodexSubscriptionLimitsResponse
export type RpcCursorModel = CursorModelSummary
export type RpcListCursorModelsResponse = CursorModelsResponse
export type RpcOpencodeModel = OpencodeModelSummary
export type RpcListOpencodeModelsResponse = OpencodeModelsResponse
export type RpcListOpencodeReasoningEffortOptionsResponse = OpencodeReasoningEffortResponse
export type RpcLocalPreviewProbeResponse = LocalPreviewProbeResponse
export type RpcLocalPreviewHttpResponse = LocalPreviewHttpResponse
export type RpcOpenVikingStatusResponse = OpenVikingStatusResponse
export type RpcOpenVikingContextListResponse = OpenVikingContextListResponse
export type RpcOpenVikingContextReadResponse = OpenVikingContextReadResponse
export type RpcCodexLocalSessionsResponse = CodexLocalSessionsRpcResponse
export type RpcCodexLocalSessionDataResponse = CodexLocalSessionDataRpcResponse
export type RpcCodexLocalSessionComposerCapabilitiesResponse = CodexLocalSessionComposerCapabilitiesRpcResponse
export type RpcCodexLocalSessionSnapshotResponse = CodexLocalSessionSnapshotRpcResponse
export type RpcCodexLocalSessionStatusResponse = CodexLocalSessionStatusRpcResponse
export type RpcArchiveCodexLocalSessionResponse = ArchiveCodexLocalSessionRpcResponse
export type RpcDiscardCodexLocalSessionMessageResponse = DiscardCodexLocalSessionMessageRpcResponse
export type RpcSendCodexLocalSessionMessageResponse = SendCodexLocalSessionMessageRpcResponse
export type RpcNativeKanbanFeedbackStageResponse = NativeKanbanFeedbackStageResponse
export type RpcNativeKanbanFeedbackDeleteResponse = NativeKanbanFeedbackDeleteResponse
export type RpcNativeCodexAttachmentStageResponse = NativeCodexAttachmentStageResponse
export type RpcNativeCodexAttachmentDeleteResponse = NativeCodexAttachmentDeleteResponse
export type RpcForkCodexSideSessionResponse =
    | { type: 'success'; childCodexThreadId: string; parentCodexThreadId: string }
    | { type: 'error'; message: string; code?: string }
export type RpcFileBytesResponse = {
    success: true
    bytes: Uint8Array
    mimeType?: string | null
    fileName?: string | null
    size?: number
    mtimeMs?: number
} | {
    success: false
    error: string
}

function normalizeUploadOperation(value: unknown, fallback: string): UploadFileOperationResponse {
    if (!value || typeof value !== 'object') {
        return { success: false, error: `Unexpected upload response: ${fallback}` }
    }

    const record = value as Record<string, unknown>
    if (record.success === true) {
        return { success: true }
    }

    return {
        success: false,
        error: typeof record.error === 'string' ? record.error : fallback
    }
}

function normalizeUploadResponse(value: unknown, fallback: string): RpcUploadFileResponse {
    const operation = normalizeUploadOperation(value, fallback)
    if (!operation.success) {
        return operation
    }

    const path = (value as Record<string, unknown>).path
    if (typeof path !== 'string' || !path) {
        return { success: false, error: `Unexpected upload response: ${fallback}` }
    }

    return { success: true, path }
}

export type RpcGeneratedImageFileReference = {
    path: string
    mimeType: string
    size: number
    mtimeMs: number
    fileName?: string | null
}

export class RpcGateway {
    constructor(
        private readonly io: Server,
        private readonly rpcRegistry: RpcRegistry
    ) {
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        mode?: PermissionMode,
        allowTools?: string[],
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
        answers?: Record<string, string[]> | Record<string, { answers: string[] }>
    ): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.Permission, {
            id: requestId,
            approved: true,
            mode,
            allowTools,
            decision,
            answers
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    ): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.Permission, {
            id: requestId,
            approved: false,
            decision
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.Abort, { reason: 'User aborted via Telegram Bot' })
    }

    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.Switch, { to })
    }

    async requestSessionConfig(
        sessionId: string,
        config: {
            permissionMode?: PermissionMode
            model?: { provider: string; modelId: string } | string | null
            modelReasoningEffort?: string | null
            effort?: string | null
            collaborationMode?: CodexCollaborationMode
        }
    ): Promise<unknown> {
        return await this.sessionRpc(sessionId, RPC_METHODS.SetSessionConfig, config)
    }

    async killSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.KillSession, {})
    }

    async handoffSessionToLocal(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, RPC_METHODS.HandoffLocal, {})
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent: AgentFlavor = 'claude',
        model?: string,
        modelReasoningEffort?: string,
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        resumeSessionId?: string,
        effort?: string,
        permissionMode?: PermissionMode,
        serviceTier?: string,
        forkSessionId?: string,
        approvedNewDirectoryCreation?: boolean
    ): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const result = await this.machineRpc(
                machineId,
                RPC_METHODS.SpawnHappySession,
                { type: 'spawn-in-directory', directory, agent, model, modelReasoningEffort, yolo, sessionType, worktreeName, resumeSessionId, effort, permissionMode, serviceTier, forkSessionId, approvedNewDirectoryCreation }
            )
            if (result && typeof result === 'object') {
                const obj = result as Record<string, unknown>
                if (obj.type === 'success' && typeof obj.sessionId === 'string') {
                    return { type: 'success', sessionId: obj.sessionId }
                }
                if (obj.type === 'error' && typeof obj.errorMessage === 'string') {
                    return { type: 'error', message: obj.errorMessage }
                }
                if (obj.type === 'requestToApproveDirectoryCreation' && typeof obj.directory === 'string') {
                    return { type: 'error', message: `Directory creation requires approval: ${obj.directory}` }
                }
                if (typeof obj.error === 'string') {
                    return { type: 'error', message: obj.error }
                }
                if (obj.type !== 'success' && typeof obj.message === 'string') {
                    return { type: 'error', message: obj.message }
                }
            }
            const details = typeof result === 'string'
                ? result
                : (() => {
                    try {
                        return JSON.stringify(result)
                    } catch {
                        return String(result)
                    }
                })()
            return { type: 'error', message: `Unexpected spawn result: ${details}` }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    async listMachineDirectory(machineId: string, path: string): Promise<RpcListDirectoryResponse> {
        const result = await this.machineRpc(machineId, RPC_METHODS.ListMachineDirectory, { path }) as RpcListDirectoryResponse | unknown
        if (!result || typeof result !== 'object') {
            return { success: false, error: 'Unexpected list-directory result' }
        }
        return result as RpcListDirectoryResponse
    }

    async browseSessionFiles(machineId: string, cwd: string, request: import('@hapi/protocol/apiTypes').SessionFileBrowserRequest): Promise<import('@hapi/protocol/apiTypes').SessionFileBrowserResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.BrowseSessionFiles, { cwd, request }) as import('@hapi/protocol/apiTypes').SessionFileBrowserResponse
    }

    async listCodexLocalSessions(
        machineId: string,
        limit: number,
        options?: { excludeHapiInitiated?: boolean; forceRefresh?: boolean }
    ): Promise<RpcCodexLocalSessionsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListCodexLocalSessions, {
            limit,
            ...(options ?? {})
        }) as RpcCodexLocalSessionsResponse
    }

    async readCodexLocalSession(
        machineId: string,
        sessionId: string,
        options?: { before?: number; limit?: number }
    ): Promise<RpcCodexLocalSessionDataResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ReadCodexLocalSession, {
            sessionId,
            ...options
        }) as RpcCodexLocalSessionDataResponse
    }

    async readCodexLocalSessionSnapshot(
        machineId: string,
        sessionId: string,
        options?: CodexLocalSessionSnapshotReadOptions
    ): Promise<RpcCodexLocalSessionSnapshotResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ReadCodexLocalSessionSnapshot, {
            sessionId,
            ...options
        }) as RpcCodexLocalSessionSnapshotResponse
    }

    async getCodexLocalSessionStatus(
        machineId: string,
        sessionId: string
    ): Promise<RpcCodexLocalSessionStatusResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.GetCodexLocalSessionStatus, {
            sessionId
        }) as RpcCodexLocalSessionStatusResponse
    }

    async controlCodexLocalSession(
        machineId: string,
        sessionId: string,
        action: NativeCodexSessionControlAction
    ): Promise<NativeCodexSessionControlResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ControlCodexLocalSession, {
            sessionId,
            ...action
        }) as NativeCodexSessionControlResponse
    }

    async getCodexLocalSessionComposerCapabilities(
        machineId: string,
        sessionId: string
    ): Promise<RpcCodexLocalSessionComposerCapabilitiesResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.GetCodexLocalSessionComposerCapabilities, {
            sessionId
        }) as RpcCodexLocalSessionComposerCapabilitiesResponse
    }

    async sendCodexLocalSessionMessage(
        machineId: string,
        sessionId: string,
        message: string,
        displayMessage?: string,
        clientMessageId?: string,
        forceRecovery?: boolean,
        deliveryPolicy?: NativeCodexDeliveryPolicy,
        reviewGuard?: NativeKanbanFeedbackReviewGuard,
        attachmentIds?: readonly string[]
    ): Promise<RpcSendCodexLocalSessionMessageResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.SendCodexLocalSessionMessage, {
            sessionId,
            message,
            ...(displayMessage === undefined ? {} : { displayMessage }),
            ...(clientMessageId === undefined ? {} : { clientMessageId }),
            ...(forceRecovery === true ? { forceRecovery: true } : {}),
            ...(deliveryPolicy === undefined || deliveryPolicy === 'default' ? {} : { deliveryPolicy }),
            ...(deliveryPolicy === 'untrusted-review' && reviewGuard ? { reviewGuard } : {}),
            ...(attachmentIds?.length ? { attachmentIds: [...attachmentIds] } : {})
        }) as RpcSendCodexLocalSessionMessageResponse
    }

    async discardCodexLocalSessionMessage(
        machineId: string,
        sessionId: string,
        clientMessageId: string
    ): Promise<RpcDiscardCodexLocalSessionMessageResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.DiscardCodexLocalSessionMessage, {
            sessionId,
            clientMessageId
        }) as RpcDiscardCodexLocalSessionMessageResponse
    }

    async archiveCodexLocalSession(
        machineId: string,
        sessionId: string
    ): Promise<RpcArchiveCodexLocalSessionResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ArchiveCodexLocalSession, {
            sessionId
        }) as RpcArchiveCodexLocalSessionResponse
    }

    async renameCodexLocalSession(machineId: string, sessionId: string, name: string): Promise<RenameNativeCodexSessionResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.RenameCodexLocalSession, { sessionId, name }, 60_000) as RenameNativeCodexSessionResponse
    }

    async stageNativeKanbanFeedback(
        machineId: string,
        request: NativeKanbanFeedbackStageRequest
    ): Promise<RpcNativeKanbanFeedbackStageResponse> {
        const socket = this.getSocketForMachine(machineId, 'native-kanban-feedback:stage')
        const response = await socket.timeout(DEFAULT_RPC_TIMEOUT_MS).emitWithAck('native-kanban-feedback:stage', request) as NativeKanbanFeedbackStageResponse | unknown
        if (!response || typeof response !== 'object') return { success: false, error: 'Unexpected native feedback stage response' }
        const record = response as Record<string, unknown>
        if (record.success === true && typeof record.path === 'string') return { success: true, path: record.path }
        return { success: false, error: typeof record.error === 'string' ? record.error : 'Could not stage native feedback' }
    }

    async deleteNativeKanbanFeedback(
        machineId: string,
        request: NativeKanbanFeedbackDeleteRequest
    ): Promise<RpcNativeKanbanFeedbackDeleteResponse> {
        const socket = this.getSocketForMachine(machineId, 'native-kanban-feedback:delete')
        const response = await socket.timeout(DEFAULT_RPC_TIMEOUT_MS).emitWithAck('native-kanban-feedback:delete', request) as NativeKanbanFeedbackDeleteResponse | unknown
        if (!response || typeof response !== 'object') return { success: false, error: 'Unexpected native feedback delete response' }
        const record = response as Record<string, unknown>
        if (record.success === true && typeof record.deleted === 'boolean') return { success: true, deleted: record.deleted }
        return { success: false, error: typeof record.error === 'string' ? record.error : 'Could not delete native feedback stage' }
    }

    async stageNativeCodexAttachment(
        machineId: string,
        request: NativeCodexAttachmentStageRequest
    ): Promise<RpcNativeCodexAttachmentStageResponse> {
        const socket = this.getSocketForMachine(machineId, 'native-codex-attachment:stage')
        const response = await socket.timeout(DEFAULT_RPC_TIMEOUT_MS).emitWithAck('native-codex-attachment:stage', request) as NativeCodexAttachmentStageResponse | unknown
        if (!response || typeof response !== 'object') return { success: false, error: 'Unexpected native attachment stage response' }
        const record = response as Record<string, unknown>
        const attachment = record.attachment
        if (
            record.success === true
            && attachment
            && typeof attachment === 'object'
            && typeof (attachment as Record<string, unknown>).id === 'string'
            && typeof (attachment as Record<string, unknown>).filename === 'string'
            && typeof (attachment as Record<string, unknown>).mimeType === 'string'
            && typeof (attachment as Record<string, unknown>).size === 'number'
            && ((attachment as Record<string, unknown>).kind === 'image' || (attachment as Record<string, unknown>).kind === 'file')
        ) {
            return { success: true, attachment: attachment as NativeCodexAttachment }
        }
        return { success: false, error: typeof record.error === 'string' ? record.error : 'Could not stage native attachment' }
    }

    async deleteNativeCodexAttachment(
        machineId: string,
        request: NativeCodexAttachmentDeleteRequest
    ): Promise<RpcNativeCodexAttachmentDeleteResponse> {
        const socket = this.getSocketForMachine(machineId, 'native-codex-attachment:delete')
        const response = await socket.timeout(DEFAULT_RPC_TIMEOUT_MS).emitWithAck('native-codex-attachment:delete', request) as NativeCodexAttachmentDeleteResponse | unknown
        if (!response || typeof response !== 'object') return { success: false, error: 'Unexpected native attachment delete response' }
        const record = response as Record<string, unknown>
        if (record.success === true && typeof record.deleted === 'boolean') return { success: true, deleted: record.deleted }
        return { success: false, error: typeof record.error === 'string' ? record.error : 'Could not delete native attachment' }
    }

    async checkPathsExist(machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        const result = await this.machineRpc(machineId, RPC_METHODS.PathExists, { paths }) as RpcPathExistsResponse | unknown
        if (!result || typeof result !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const existsValue = (result as RpcPathExistsResponse).exists
        if (!existsValue || typeof existsValue !== 'object') {
            throw new Error('Unexpected path-exists result')
        }

        const exists: Record<string, boolean> = {}
        for (const [key, value] of Object.entries(existsValue)) {
            exists[key] = value === true
        }
        return exists
    }

    async getMachineGitBranch(machineId: string, cwd: string): Promise<RpcGitBranchResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.GetMachineGitBranch, { cwd }) as RpcGitBranchResponse
    }

    async getMachineGitBranches(machineId: string, cwd: string): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.GetMachineGitBranches, { cwd }) as RpcGitBranchesResponse
    }

    async switchMachineGitBranch(
        machineId: string,
        request: MachineGitBranchSwitchRequest
    ): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(
            machineId,
            RPC_METHODS.SwitchMachineGitBranch,
            request,
            GIT_BRANCH_MUTATION_RPC_TIMEOUT_MS
        ) as RpcGitBranchesResponse
    }

    async createMachineGitBranch(
        machineId: string,
        request: MachineGitBranchCreateRequest
    ): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.CreateMachineGitBranch, request) as RpcGitBranchesResponse
    }

    async commitMachineGitChanges(
        machineId: string,
        request: MachineGitBranchCommitRequest
    ): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(
            machineId,
            RPC_METHODS.CommitMachineGitChanges,
            request,
            GIT_BRANCH_REMOTE_RPC_TIMEOUT_MS
        ) as RpcGitBranchesResponse
    }

    async pushMachineGitBranch(
        machineId: string,
        request: MachineGitBranchPushRequest
    ): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(
            machineId,
            RPC_METHODS.PushMachineGitBranch,
            request,
            GIT_BRANCH_REMOTE_RPC_TIMEOUT_MS
        ) as RpcGitBranchesResponse
    }

    async fetchMachineGitBranches(
        machineId: string,
        request: MachineGitBranchFetchRequest
    ): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(
            machineId,
            RPC_METHODS.FetchMachineGitBranches,
            request,
            GIT_BRANCH_REMOTE_RPC_TIMEOUT_MS
        ) as RpcGitBranchesResponse
    }

    async updateMachineGitBranch(
        machineId: string,
        request: MachineGitBranchUpdateRequest
    ): Promise<RpcGitBranchesResponse> {
        return await this.machineRpc(
            machineId,
            RPC_METHODS.UpdateMachineGitBranch,
            request,
            GIT_BRANCH_REMOTE_RPC_TIMEOUT_MS
        ) as RpcGitBranchesResponse
    }

    async readMachineFile(machineId: string, cwd: string, path: string): Promise<RpcReadFileResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ReadMachineFile, { cwd, path }) as RpcReadFileResponse
    }

    async readMachineFileBytes(machineId: string, cwd: string, path: string): Promise<RpcFileBytesResponse> {
        return await this.binaryFileCallForMachine(machineId, `${machineId}:${RPC_METHODS.ReadMachineFile}`, {
            type: 'machine-file',
            cwd,
            path
        })
    }

    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.GitStatus, { cwd }) as RpcCommandResponse
    }

    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.GitDiffNumstat, options) as RpcCommandResponse
    }

    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.GitDiffFile, options) as RpcCommandResponse
    }

    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ReadFile, { path }) as RpcReadFileResponse
    }

    async readSessionFileBytes(sessionId: string, path: string): Promise<RpcFileBytesResponse> {
        return await this.binaryFileCallForSession(sessionId, `${sessionId}:${RPC_METHODS.ReadFile}`, {
            type: 'session-file',
            path
        })
    }

    async readGeneratedImage(sessionId: string, imageId: string): Promise<RpcGeneratedImageResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ReadGeneratedImage, { id: imageId }) as RpcGeneratedImageResponse
    }

    async readGeneratedImageBytes(sessionId: string, imageId: string): Promise<RpcFileBytesResponse> {
        return await this.binaryFileCallForSession(sessionId, `${sessionId}:${RPC_METHODS.ReadGeneratedImage}`, {
            type: 'generated-image',
            imageId
        })
    }

    async readGeneratedImageFileBytes(machineId: string, reference: RpcGeneratedImageFileReference): Promise<RpcFileBytesResponse> {
        return await this.binaryFileCallForMachine(machineId, `${machineId}:${RPC_METHODS.ReadGeneratedImage}`, {
            type: 'generated-image-file',
            path: reference.path,
            mimeType: reference.mimeType,
            size: reference.size,
            mtimeMs: reference.mtimeMs,
            fileName: reference.fileName
        })
    }

    async readUploadedFileBytes(machineId: string, sessionId: string, path: string): Promise<RpcFileBytesResponse> {
        return await this.binaryFileCallForMachine(machineId, `${machineId}:${RPC_METHODS.DeleteUpload}`, {
            type: 'uploaded-file',
            sessionId,
            path
        })
    }

    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListDirectory, { path }) as RpcListDirectoryResponse
    }

    async uploadFileBytes(
        machineId: string,
        sessionId: string,
        filename: string,
        bytes: Uint8Array,
        mimeType: string
    ): Promise<RpcUploadFileResponse> {
        const uploadId = randomUUID()
        let cancelRequired = true

        try {
            const startRequest: UploadFileStartRequest = {
                sessionId,
                uploadId,
                filename,
                mimeType,
                size: bytes.byteLength
            }
            const started = normalizeUploadOperation(
                await this.machineRpc(machineId, RPC_METHODS.UploadFileStart, startRequest),
                'Failed to start upload'
            )
            if (!started.success) {
                return started
            }

            for (let offset = 0; offset < bytes.byteLength; offset += MAX_UPLOAD_CHUNK_BYTES) {
                const chunk = bytes.subarray(offset, Math.min(offset + MAX_UPLOAD_CHUNK_BYTES, bytes.byteLength))
                const chunkRequest: UploadFileChunkRequest = {
                    sessionId,
                    uploadId,
                    offset,
                    content: Buffer.from(chunk).toString('base64')
                }
                const appended = normalizeUploadOperation(
                    await this.machineRpc(machineId, RPC_METHODS.UploadFileChunk, chunkRequest),
                    'Failed to append upload chunk'
                )
                if (!appended.success) {
                    return appended
                }
            }

            const finishedRequest: UploadFileFinishRequest = { sessionId, uploadId }
            const finished = normalizeUploadResponse(
                await this.machineRpc(machineId, RPC_METHODS.UploadFileFinish, finishedRequest),
                'Failed to finish upload'
            )
            if (finished.success) {
                cancelRequired = false
            }
            return finished
        } finally {
            if (cancelRequired) {
                const cancelRequest: UploadFileCancelRequest = { sessionId, uploadId }
                await this.machineRpc(
                    machineId,
                    RPC_METHODS.UploadFileCancel,
                    cancelRequest,
                    UPLOAD_CANCEL_TIMEOUT_MS
                ).catch(() => undefined)
            }
        }
    }

    async deleteUploadFile(machineId: string, sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.DeleteUpload, { sessionId, path }) as RpcDeleteUploadResponse
    }

    async cleanupUploadSession(machineId: string, sessionId: string): Promise<void> {
        await this.machineRpc(machineId, RPC_METHODS.CleanupUploadSession, { sessionId })
    }

    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.Ripgrep, { args, cwd }) as RpcCommandResponse
    }

    async listSlashCommands(sessionId: string, agent: string): Promise<SlashCommandsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListSlashCommands, { agent }) as SlashCommandsResponse
    }

    async listSkills(sessionId: string, flavor?: string): Promise<{
        success: boolean
        skills?: Array<{ name: string; description?: string; scope?: 'project' | 'user' | 'plugin' | 'system' | 'admin' }>
        error?: string
    }> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListSkills, { flavor }) as {
            success: boolean
            skills?: Array<{ name: string; description?: string; scope?: 'project' | 'user' | 'plugin' | 'system' | 'admin' }>
            error?: string
        }
    }

    async listCodexModelsForSession(sessionId: string): Promise<RpcListCodexModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListCodexModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCodexModelsResponse
    }

    async getCodexSubscriptionLimitsForSession(sessionId: string, model?: string | null, cwd?: string | null, provider?: string | null): Promise<RpcGetCodexSubscriptionLimitsResponse> {
        const request: GetCodexSubscriptionLimitsRequest = { model: model ?? null, cwd, provider }
        return await this.sessionRpc(
            sessionId,
            RPC_METHODS.GetCodexSubscriptionLimits,
            request,
            DEFAULT_RPC_TIMEOUT_MS
        ) as RpcGetCodexSubscriptionLimitsResponse
    }

    async forkCodexSideSession(sessionId: string): Promise<RpcForkCodexSideSessionResponse> {
        const result = await this.sessionRpc(
            sessionId,
            RPC_METHODS.ForkCodexSideSession,
            {},
            SIDE_SESSION_FORK_RPC_TIMEOUT_MS
        )
        if (!result || typeof result !== 'object') {
            return { type: 'error', message: 'Unexpected side session fork result', code: 'bad_response' }
        }
        const obj = result as Record<string, unknown>
        if (
            obj.type === 'success'
            && typeof obj.childCodexThreadId === 'string'
            && obj.childCodexThreadId.length > 0
            && typeof obj.parentCodexThreadId === 'string'
            && obj.parentCodexThreadId.length > 0
        ) {
            return {
                type: 'success',
                childCodexThreadId: obj.childCodexThreadId,
                parentCodexThreadId: obj.parentCodexThreadId
            }
        }
        if (obj.type === 'error' && typeof obj.message === 'string') {
            return {
                type: 'error',
                message: obj.message,
                ...(typeof obj.code === 'string' ? { code: obj.code } : {})
            }
        }
        return { type: 'error', message: 'Unexpected side session fork result', code: 'bad_response' }
    }

    async listCodexModelsForMachine(machineId: string): Promise<RpcListCodexModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListCodexModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCodexModelsResponse
    }

    async getCodexSubscriptionLimitsForMachine(machineId: string, model?: string | null, cwd?: string | null, provider?: string | null): Promise<RpcGetCodexSubscriptionLimitsResponse> {
        const request: GetCodexSubscriptionLimitsRequest = { model: model ?? null, cwd, provider }
        return await this.machineRpc(
            machineId,
            RPC_METHODS.GetCodexSubscriptionLimits,
            request,
            DEFAULT_RPC_TIMEOUT_MS
        ) as RpcGetCodexSubscriptionLimitsResponse
    }

    async listCursorModelsForSession(sessionId: string): Promise<RpcListCursorModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListCursorModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCursorModelsResponse
    }

    async listCursorModelsForMachine(machineId: string): Promise<RpcListCursorModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListCursorModels, {}, MODEL_LIST_RPC_TIMEOUT_MS) as RpcListCursorModelsResponse
    }

    async listOpencodeModelsForSession(sessionId: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListOpencodeModels, {}) as RpcListOpencodeModelsResponse
    }

    async listOpencodeModelsForCwd(machineId: string, cwd: string): Promise<RpcListOpencodeModelsResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.ListOpencodeModelsForCwd, { cwd }) as RpcListOpencodeModelsResponse
    }

    async checkLocalPreview(machineId: string, request: LocalPreviewProbeRequest): Promise<RpcLocalPreviewProbeResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.LocalPreviewCheck, request) as RpcLocalPreviewProbeResponse
    }

    async openLocalServiceTunnel(machineId: string, request: LocalServiceTunnelRequest, namespace: string): Promise<LocalServiceTunnel> {
        const method = `${machineId}:${LOCAL_SERVICE_RPC}`
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        const socket = socketId ? this.io.of('/cli').sockets.get(socketId) : undefined
        if (!socket) throw new RpcTargetMissingError(method, 'socket-disconnected')
        return await openLocalServiceSocketTunnel(socket, machineId, namespace, request)
    }

    async proxyLocalPreviewRequest(machineId: string, request: LocalPreviewHttpRequest): Promise<RpcLocalPreviewHttpResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.LocalPreviewHttpRequest, request) as RpcLocalPreviewHttpResponse
    }

    async getOpenVikingStatus(machineId: string): Promise<RpcOpenVikingStatusResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.OpenVikingStatus, {}) as RpcOpenVikingStatusResponse
    }

    async listOpenVikingContext(machineId: string, request: OpenVikingContextListRequest): Promise<RpcOpenVikingContextListResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.OpenVikingListContext, request) as RpcOpenVikingContextListResponse
    }

    async readOpenVikingContext(machineId: string, request: OpenVikingContextReadRequest): Promise<RpcOpenVikingContextReadResponse> {
        return await this.machineRpc(machineId, RPC_METHODS.OpenVikingReadContext, request) as RpcOpenVikingContextReadResponse
    }

    /** Generic Pi RPC call — routes all Pi-specific session RPCs through
     *  a single entry point instead of per-method wrappers. */
    async callPiRpc<T = unknown>(sessionId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
        return await this.sessionRpc(sessionId, method, params ?? {}, timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS) as T
    }

    async listOpencodeReasoningEffortOptionsForSession(sessionId: string): Promise<RpcListOpencodeReasoningEffortOptionsResponse> {
        return await this.sessionRpc(sessionId, RPC_METHODS.ListOpencodeReasoningEffortOptions, {}) as RpcListOpencodeReasoningEffortOptionsResponse
    }

    private async sessionRpc(
        sessionId: string,
        method: string,
        params: unknown,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<unknown> {
        return await this.rpcCall(`${sessionId}:${method}`, params, timeoutMs)
    }

    private async machineRpc(
        machineId: string,
        method: string,
        params: unknown,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<unknown> {
        return await this.rpcCall(`${machineId}:${method}`, params, timeoutMs)
    }

    private async rpcCall(method: string, params: unknown, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
        const socketId = this.rpcRegistry.getSocketIdForMethod(method)
        if (!socketId) {
            throw new RpcTargetMissingError(method, 'handler-not-registered')
        }

        const socket = this.io.of('/cli').sockets.get(socketId)
        if (!socket) {
            throw new RpcTargetMissingError(method, 'socket-disconnected')
        }

        const response = await socket.timeout(timeoutMs).emitWithAck('rpc-request', {
            method,
            params: JSON.stringify(params)
        }) as unknown

        if (typeof response !== 'string') {
            return response
        }

        try {
            return JSON.parse(response) as unknown
        } catch {
            return response
        }
    }

    private async binaryFileCallForSession(
        sessionId: string,
        method: string,
        request: BinaryFileReadRequest,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<RpcFileBytesResponse> {
        const socket = this.getSocketForSession(sessionId, method)
        return await this.emitBinaryFileRead(socket, request, timeoutMs)
    }

    private async binaryFileCallForMachine(
        machineId: string,
        method: string,
        request: BinaryFileReadRequest,
        timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS
    ): Promise<RpcFileBytesResponse> {
        const socket = this.getSocketForMachine(machineId, method)
        return await this.emitBinaryFileRead(socket, request, timeoutMs)
    }

    private async emitBinaryFileRead(
        socket: Socket,
        request: BinaryFileReadRequest,
        timeoutMs: number
    ): Promise<RpcFileBytesResponse> {
        const response = await socket.timeout(timeoutMs).emitWithAck('file:read-bytes', request) as BinaryFileReadResponse | unknown
        if (!response || typeof response !== 'object') {
            return { success: false, error: 'Unexpected binary file response' }
        }

        const record = response as Record<string, unknown>
        if (record.success !== true) {
            return {
                success: false,
                error: typeof record.error === 'string' ? record.error : 'Failed to read file bytes'
            }
        }

        const bytes = normalizeBinaryBytes(record.bytes)
        if (!bytes) {
            return { success: false, error: 'Invalid binary file response' }
        }

        return {
            success: true,
            bytes,
            mimeType: typeof record.mimeType === 'string' ? record.mimeType : null,
            fileName: typeof record.fileName === 'string' ? record.fileName : null,
            size: typeof record.size === 'number' ? record.size : undefined,
            mtimeMs: typeof record.mtimeMs === 'number' ? record.mtimeMs : undefined
        }
    }

    private getSocketForSession(sessionId: string, method: string): Socket {
        const namespace = this.io.of('/cli')
        const room = namespace.adapter.rooms.get(`session:${sessionId}`)
        if (!room || room.size === 0) {
            throw new RpcTargetMissingError(method, 'socket-disconnected')
        }

        for (const socketId of room) {
            const socket = namespace.sockets.get(socketId)
            if (socket) {
                return socket
            }
        }

        throw new RpcTargetMissingError(method, 'socket-disconnected')
    }

    private getSocketForMachine(machineId: string, method: string): Socket {
        const namespace = this.io.of('/cli')
        const room = namespace.adapter.rooms.get(`machine:${machineId}`)
        if (!room || room.size === 0) {
            throw new RpcTargetMissingError(method, 'socket-disconnected')
        }

        for (const socketId of room) {
            const socket = namespace.sockets.get(socketId)
            if (socket) {
                return socket
            }
        }

        throw new RpcTargetMissingError(method, 'socket-disconnected')
    }
}

function normalizeBinaryBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
        return value
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value)
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
        return Uint8Array.from(value)
    }
    if (value && typeof value === 'object') {
        const data = (value as { data?: unknown }).data
        if (Array.isArray(data) && data.every((item) => typeof item === 'number')) {
            return Uint8Array.from(data)
        }
    }
    return null
}
