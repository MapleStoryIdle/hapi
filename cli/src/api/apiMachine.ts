/**
 * WebSocket client for machine/runner communication with hapi-hub
 */

import { io, type Socket } from 'socket.io-client'
import { readdir, realpath, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import type {
    BinaryFileReadRequest,
    BinaryFileReadResponse,
    ClientToServerEvents,
    ExternalCodexRequestPayload,
    NativeKanbanFeedbackDeleteRequest,
    NativeKanbanFeedbackDeleteResponse,
    NativeKanbanFeedbackStageRequest,
    NativeKanbanFeedbackStageResponse,
    ServerToClientEvents,
    Update,
    UpdateMachineBody
} from '@hapi/protocol'
import type { FileReadResponse, GitBranchResponse, GitCommandResponse, MachineDirectoryEntry, MachineListDirectoryResponse, PathExistsResponse } from '@hapi/protocol/apiTypes'
import {
    type CodexLocalSessionListUpdate,
    type CodexLocalSessionDisplaySummary,
    type CodexLocalSessionComposerCapabilitiesRpcResponse,
    type ArchiveCodexLocalSessionRpcResponse,
    type CodexLocalSessionDataRpcResponse,
    type DiscardCodexLocalSessionMessageRpcResponse,
    type CodexLocalSessionRealtimeSnapshot,
    type CodexLocalSessionRealtimeStatus,
    type CodexLocalSessionSnapshotRpcResponse,
    type CodexLocalSessionSnapshotVersion,
    type CodexLocalSessionStatusRpcResponse,
    type CodexLocalSessionSummary,
    type CodexLocalSessionsRpcResponse,
    type NativeCodexDeliveryPolicy,
    type NativeKanbanFeedbackReviewGuard,
    type SendCodexLocalSessionMessageRpcResponse,
    isHapiInitiatedCodexSession
} from '@hapi/protocol/codexTranscript'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { FileNativeCodexSessionDirectSendStore, NativeCodexSessionDirectSender } from '@/codex/nativeSessionDirectSend'
import { NativeKanbanFeedbackStore } from '@/codex/nativeKanbanFeedbackStore'
import { CodexAppServerClient } from '@/codex/codexAppServerClient'
import { NativeCodexSessionListCache } from '@/codex/nativeSessionListCache'
import { NativeCodexSessionTitleCache } from '@/codex/nativeSessionTitleCache'
import { NativeCodexTranscriptCache, type NativeCodexTranscriptRead } from '@/codex/nativeTranscriptCache'
import { NativeCodexSessionWatcher } from '@/codex/nativeSessionWatcher'
import {
    NativeCodexTurnLifecycleTracker,
    normalizeNativeCodexSessionForDisplay,
    type ExternalCodexLifecycleEvent,
    type ExternalCodexUserInputEvent
} from '@/codex/nativeTurnLifecycle'
import type { RunnerState, Machine, MachineMetadata } from './types'
import { RunnerStateSchema, MachineMetadataSchema } from './types'
import { backoff } from '@/utils/time'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import { listSlashCommands } from '../modules/common/slashCommands'
import { listSkills } from '../modules/common/skills'
import { getGitBranchStatusForCwd } from '../modules/common/handlers/git'
import {
    listOpencodeModelsForCwd,
    type ListOpencodeModelsForCwdRequest,
    type ListOpencodeModelsForCwdResponse
} from '../modules/common/opencodeModels'
import type { SpawnSessionOptions, SpawnSessionResult } from '../modules/common/rpcTypes'
import { applyVersionedAck } from './versionedUpdate'
import { buildSocketIoExtraHeaderOptions } from './hubExtraHeaders'
import { collectMachineHealth } from '@/utils/machineHealth'
import { readGeneratedImageFileBytes, readSessionFileBytes } from '@/modules/common/handlers/files'
import { readUploadFileBytes } from '@/modules/common/handlers/uploads'

type NativeCodexArchiveClient = Pick<CodexAppServerClient, 'connect' | 'initialize' | 'archiveThread' | 'disconnect'>

type MachineRpcHandlers = {
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>
    stopSession: (sessionId: string) => boolean
    requestShutdown: () => void
}

interface PathExistsRequest {
    paths: string[]
}

interface ListMachineDirectoryRequest {
    path: string
}

interface GetMachineGitBranchRequest {
    cwd?: unknown
}

interface ReadMachineFileRequest {
    cwd?: unknown
    path?: unknown
}

interface ListCodexLocalSessionsRequest {
    limit?: unknown
    excludeHapiInitiated?: unknown
    forceRefresh?: unknown
}

interface ReadCodexLocalSessionRequest {
    sessionId?: unknown
    before?: unknown
    limit?: unknown
}

interface ReadCodexLocalSessionSnapshotRequest extends ReadCodexLocalSessionRequest {
    knownVersion?: unknown
}

interface GetCodexLocalSessionStatusRequest {
    sessionId?: unknown
}

interface GetCodexLocalSessionComposerCapabilitiesRequest {
    sessionId?: unknown
}

interface SendCodexLocalSessionMessageRequest {
    sessionId?: unknown
    message?: unknown
    displayMessage?: unknown
    clientMessageId?: unknown
    forceRecovery?: unknown
    deliveryPolicy?: unknown
    reviewGuard?: unknown
}

interface DiscardCodexLocalSessionMessageRequest {
    sessionId?: unknown
    clientMessageId?: unknown
}

interface ArchiveCodexLocalSessionRequest {
    sessionId?: unknown
}

function toNativeCodexSessionListUpdate(session: CodexLocalSessionSummary): CodexLocalSessionListUpdate {
    const { file: _file, ...summary } = normalizeNativeCodexSessionForDisplay(session)
    return summary
}

function toNativeCodexSessionDisplaySummary(session: CodexLocalSessionSummary): CodexLocalSessionDisplaySummary {
    const normalized = normalizeNativeCodexSessionForDisplay(session)
    return {
        id: normalized.id,
        title: normalized.title,
        cwd: normalized.cwd,
        modifiedAt: normalized.modifiedAt,
        model: normalized.model,
        modelReasoningEffort: normalized.modelReasoningEffort
    }
}

function buildNativeCodexRealtimeSnapshot(
    read: NativeCodexTranscriptRead,
    status: Extract<CodexLocalSessionStatusRpcResponse, { success: true }>
): CodexLocalSessionRealtimeSnapshot {
    const { queuedMessages, ...baseStatus } = status
    const realtimeStatus: CodexLocalSessionRealtimeStatus = {
        ...baseStatus,
        ...(queuedMessages === undefined ? {} : {
            queuedMessageRefs: queuedMessages.map(({ id, recoveryRequired, recoveryReason }) => ({
                id,
                ...(recoveryRequired ? { recoveryRequired: true } : {}),
                ...(recoveryReason ? { recoveryReason } : {})
            }))
        })
    }
    return {
        version: read.version,
        revision: read.revision,
        status: realtimeStatus,
        timing: read.timing
    }
}

function parseKnownCodexSnapshotVersion(value: unknown): CodexLocalSessionSnapshotVersion | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    const record = value as Record<string, unknown>
    const runnerEpoch = typeof record.runnerEpoch === 'string' ? record.runnerEpoch.trim() : ''
    const revision = record.revision
    if (!runnerEpoch || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
        return null
    }
    return { runnerEpoch, revision }
}

function normalizeWorkspaceRoots(paths?: string[]): string[] | undefined {
    if (!paths?.length) {
        return undefined
    }

    const normalized = Array.from(new Set(paths.map((path) => {
        try {
            return realpathSync(path)
        } catch {
            return resolvePath(path)
        }
    })))

    return normalized.length > 0 ? normalized : undefined
}

function workspaceRootsEqual(left?: string[], right?: string[]): boolean {
    const normalizedLeft = left ?? []
    const normalizedRight = right ?? []
    if (normalizedLeft.length !== normalizedRight.length) {
        return false
    }

    return normalizedLeft.every((value, index) => value === normalizedRight[index])
}

function runnerMetadataMatchesAdvertised(
    current: MachineMetadata | null,
    advertised: MachineMetadata
): boolean {
    if (!current) return false

    return current.host === advertised.host
        && current.platform === advertised.platform
        && current.happyCliVersion === advertised.happyCliVersion
        && current.homeDir === advertised.homeDir
        && current.codexHome === advertised.codexHome
        && current.nativeCodexRealtime === advertised.nativeCodexRealtime
        && current.happyHomeDir === advertised.happyHomeDir
        && current.happyLibDir === advertised.happyLibDir
        && workspaceRootsEqual(current.workspaceRoots, advertised.workspaceRoots)
}

function mergeAdvertisedRunnerMetadata(
    current: MachineMetadata | null,
    advertised: MachineMetadata
): MachineMetadata {
    const {
        host: _host,
        platform: _platform,
        happyCliVersion: _happyCliVersion,
        homeDir: _homeDir,
        codexHome: _codexHome,
        nativeCodexRealtime: _nativeCodexRealtime,
        happyHomeDir: _happyHomeDir,
        happyLibDir: _happyLibDir,
        workspaceRoots: _workspaceRoots,
        ...preserved
    } = current ?? {}

    return {
        ...preserved,
        ...advertised
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private keepAliveStartTimeout: ReturnType<typeof setTimeout> | null = null
    private rpcHandlerManager: RpcHandlerManager
    private readonly nativeCodexSessionTitleCache = new NativeCodexSessionTitleCache()
    private readonly nativeCodexTurnLifecycle = new NativeCodexTurnLifecycleTracker({
        onUnconfirmedLeaseExpired: (codexSessionId) => this.handleNativeCodexLifecycleChange(codexSessionId),
        onUserInputLeaseExpired: (codexSessionId) => this.handleNativeCodexLifecycleChange(codexSessionId),
        onProcessingStale: (codexSessionId) => this.handleNativeCodexLifecycleChange(codexSessionId)
    })
    private readonly nativeCodexTranscriptCache = new NativeCodexTranscriptCache({
        applyLifecycle: (session) => this.nativeCodexTurnLifecycle.applyToSummary(session)
    })
    private readonly nativeCodexSessionListCache = new NativeCodexSessionListCache({
        resolveTitles: (sessionIds, options) => this.nativeCodexSessionTitleCache.resolve(sessionIds, options),
        applyLifecycle: (session) => normalizeNativeCodexSessionForDisplay(
            this.maskRunnerOwnedNativeUserInput(
                this.nativeCodexTurnLifecycle.applyToSummary(session)
            )
        )
    })
    private readonly nativeCodexSessionDirectSender: NativeCodexSessionDirectSender
    private readonly nativeKanbanFeedbackStore = new NativeKanbanFeedbackStore(
        join(configuration.happyHomeDir, 'native-kanban-feedback')
    )
    private readonly nativeCodexSessionWatcher = new NativeCodexSessionWatcher({
        onChange: ({ codexSessionId, filePath, modifiedAt }) => {
            const summaryRead = this.nativeCodexTranscriptCache.refreshSummary(codexSessionId)
            if (summaryRead) {
                this.nativeCodexTurnLifecycle.observeTranscriptEvents(codexSessionId, summaryRead.lifecycleEvents)
                if (this.nativeCodexSessionDirectSender.ownsActiveDelivery(codexSessionId)) {
                    this.nativeCodexTurnLifecycle.suppressUserInputWait(codexSessionId)
                } else {
                    this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(codexSessionId, summaryRead.userInputEvents)
                }
            }
            const listSession = this.nativeCodexSessionListCache.update(filePath, modifiedAt)
            const read = this.nativeCodexTranscriptCache.refreshCached(codexSessionId, { limit: 50 })
            this.nativeCodexSessionDirectSender.notifyTranscriptChanged(codexSessionId)
            this.reportNativeCodexSessionUpdated(codexSessionId, modifiedAt, read, listSession)
        }
    })

    private readonly normalizedWorkspaceRoots: string[] | undefined

    constructor(
        private readonly token: string,
        private readonly machine: Machine,
        private readonly workspaceRoots?: string[],
        private readonly advertisedMetadata?: MachineMetadata,
        private readonly createNativeCodexArchiveClient: () => NativeCodexArchiveClient = () => new CodexAppServerClient()
    ) {
        // Realpath roots once so all subsequent comparisons are against
        // canonical, symlink-resolved locations. Falls back to lexical
        // resolution if realpath fails so we still get protection.
        this.normalizedWorkspaceRoots = normalizeWorkspaceRoots(workspaceRoots)
        this.nativeCodexSessionDirectSender = new NativeCodexSessionDirectSender(
            undefined,
            undefined,
            undefined,
            { getSummary: (sessionId) => this.getNativeCodexSessionSummary(sessionId) },
            // One short-lived bridge per native hand-off. Never reuse this
            // client across original Codex sessions: their local owner can
            // continue editing the transcript outside SHAPI.
            () => new CodexAppServerClient(),
            new FileNativeCodexSessionDirectSendStore(join(configuration.happyHomeDir, 'native-codex-direct-outbox.json')),
            (sessionId, guard) => this.nativeKanbanFeedbackStore.verify(sessionId, guard)
        )

        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })
        this.nativeCodexSessionDirectSender.setStateChangeListener((sessionId) => {
            this.reportNativeCodexSessionUpdated(sessionId)
        })

        registerCommonHandlers(this.rpcHandlerManager, getInvokedCwd())

        this.rpcHandlerManager.registerHandler<ReadMachineFileRequest, FileReadResponse>(
            RPC_METHODS.ReadMachineFile,
            async (params) => {
                const cwd = typeof params?.cwd === 'string' ? params.cwd.trim() : ''
                const path = typeof params?.path === 'string' ? params.path.trim() : ''
                if (!cwd) {
                    return { success: false, error: 'cwd is required' }
                }
                if (!path) {
                    return { success: false, error: 'path is required' }
                }

                const result = await readSessionFileBytes(path, cwd)
                if (!result.success) {
                    return result
                }
                return { success: true, content: result.bytes.toString('base64') }
            }
        )

        this.rpcHandlerManager.registerHandler<ListCodexLocalSessionsRequest, CodexLocalSessionsRpcResponse>(
            RPC_METHODS.ListCodexLocalSessions,
            async (params) => {
                const limit = params?.limit
                if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
                    return { success: false, error: 'limit must be an integer between 1 and 100' }
                }
                const excludeHapiInitiated = params?.excludeHapiInitiated
                if (excludeHapiInitiated !== undefined && typeof excludeHapiInitiated !== 'boolean') {
                    return { success: false, error: 'excludeHapiInitiated must be a boolean' }
                }
                const forceRefresh = params?.forceRefresh
                if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean') {
                    return { success: false, error: 'forceRefresh must be a boolean' }
                }
                return {
                    success: true,
                    sessions: this.nativeCodexSessionListCache.list(
                        limit ?? 500,
                        { excludeHapiInitiated },
                        { forceRefresh }
                    )
                }
            }
        )

        this.rpcHandlerManager.registerHandler<ReadCodexLocalSessionRequest, CodexLocalSessionDataRpcResponse>(
            RPC_METHODS.ReadCodexLocalSession,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, error: 'sessionId is required' }
                }
                const before = params?.before
                const limit = params?.limit
                if (before !== undefined && (typeof before !== 'number' || !Number.isInteger(before) || before < 0)) {
                    return { success: false, error: 'before must be a non-negative integer' }
                }
                if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
                    return { success: false, error: 'limit must be an integer between 1 and 100' }
                }
                const read = this.readNativeCodexTranscript(sessionId, { before, limit })
                if (read) {
                    this.observeNativeCodexSession(sessionId)
                }
                return read
                    ? { success: true, data: read.data }
                    : { success: false, error: 'Codex session not found' }
            }
        )

        this.rpcHandlerManager.registerHandler<ReadCodexLocalSessionSnapshotRequest, CodexLocalSessionSnapshotRpcResponse>(
            RPC_METHODS.ReadCodexLocalSessionSnapshot,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, error: 'sessionId is required' }
                }
                const before = params?.before
                const limit = params?.limit
                if (before !== undefined && (typeof before !== 'number' || !Number.isInteger(before) || before < 0)) {
                    return { success: false, error: 'before must be a non-negative integer' }
                }
                if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
                    return { success: false, error: 'limit must be an integer between 1 and 100' }
                }
                const knownVersion = params?.knownVersion === undefined
                    ? undefined
                    : parseKnownCodexSnapshotVersion(params.knownVersion)
                if (params?.knownVersion !== undefined && !knownVersion) {
                    return { success: false, error: 'knownVersion must contain runnerEpoch and a positive integer revision' }
                }

                const read = this.readNativeCodexTranscript(sessionId, { before, limit })
                if (!read) {
                    return { success: false, error: 'Codex session not found' }
                }
                this.observeNativeCodexSession(sessionId)
                const status = this.getNativeCodexSessionStatus(sessionId, read.data.session, read.plan)
                if (status.success !== true) {
                    return { success: false, error: status.error }
                }
                const canUseKnownVersion = before === undefined && (limit ?? 50) === 50
                if (knownVersion
                    && canUseKnownVersion
                    && knownVersion.runnerEpoch === read.version.runnerEpoch
                    && knownVersion.revision === read.version.revision) {
                    return {
                        success: true,
                        unchanged: true,
                        version: read.version,
                        revision: read.revision,
                        session: toNativeCodexSessionDisplaySummary(read.data.session),
                        status,
                        timing: read.timing
                    }
                }
                return {
                    success: true,
                    unchanged: false,
                    snapshot: {
                        data: read.data,
                        status,
                        plan: read.plan,
                        version: read.version,
                        revision: read.revision,
                        timing: read.timing
                    }
                }
            }
        )

        this.rpcHandlerManager.registerHandler<GetCodexLocalSessionStatusRequest, CodexLocalSessionStatusRpcResponse>(
            RPC_METHODS.GetCodexLocalSessionStatus,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, error: 'sessionId is required' }
                }
                const summary = this.getNativeCodexSessionSummary(sessionId)
                if (summary) {
                    this.observeNativeCodexSession(sessionId)
                }
                return this.getNativeCodexSessionStatus(sessionId, summary ?? undefined)
            }
        )

        this.rpcHandlerManager.registerHandler<
            GetCodexLocalSessionComposerCapabilitiesRequest,
            CodexLocalSessionComposerCapabilitiesRpcResponse
        >(
            RPC_METHODS.GetCodexLocalSessionComposerCapabilities,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, error: 'sessionId is required' }
                }

                const summary = this.getNativeCodexSessionSummary(sessionId)
                if (!summary) {
                    return { success: false, error: 'Codex session not found' }
                }

                const cwd = summary.cwd?.trim()
                const [commands, skills] = await Promise.all([
                    listSlashCommands('codex', cwd),
                    listSkills(cwd, { flavor: 'codex' })
                ])
                return {
                    success: true,
                    // Native direct delivery cannot update SHAPI-owned
                    // model/plan/permission state. Only expose prompts that
                    // expand into a normal Codex message.
                    commands: commands.filter((command) => command.source !== 'builtin'),
                    skills
                }
            }
        )

        this.rpcHandlerManager.registerHandler<SendCodexLocalSessionMessageRequest, SendCodexLocalSessionMessageRpcResponse>(
            RPC_METHODS.SendCodexLocalSessionMessage,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, code: 'invalid_message', error: 'sessionId is required' }
                }
                if (params?.forceRecovery !== undefined && typeof params.forceRecovery !== 'boolean') {
                    return { success: false, code: 'invalid_message', error: 'forceRecovery must be a boolean' }
                }
                if (params?.deliveryPolicy !== undefined && params.deliveryPolicy !== 'default' && params.deliveryPolicy !== 'untrusted-review') {
                    return { success: false, code: 'invalid_message', error: 'deliveryPolicy is invalid' }
                }
                if (params?.reviewGuard !== undefined && (params.deliveryPolicy !== 'untrusted-review' || !params.reviewGuard || typeof params.reviewGuard !== 'object')) {
                    return { success: false, code: 'invalid_message', error: 'reviewGuard is only valid for an untrusted review' }
                }
                const summary = this.getNativeCodexSessionSummary(sessionId)
                if (summary) {
                    this.observeNativeCodexSession(sessionId)
                }
                return this.nativeCodexSessionDirectSender.send(
                    sessionId,
                    params?.message,
                    params?.displayMessage,
                    params?.clientMessageId,
                    params?.forceRecovery,
                    params?.deliveryPolicy as NativeCodexDeliveryPolicy | undefined,
                    params?.reviewGuard as NativeKanbanFeedbackReviewGuard | undefined
                )
            }
        )

        this.rpcHandlerManager.registerHandler<
            DiscardCodexLocalSessionMessageRequest,
            DiscardCodexLocalSessionMessageRpcResponse
        >(
            RPC_METHODS.DiscardCodexLocalSessionMessage,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, code: 'invalid_client_message_id', error: 'sessionId is required' }
                }
                this.observeNativeCodexSession(sessionId)
                return this.nativeCodexSessionDirectSender.discard(sessionId, params?.clientMessageId)
            }
        )

        this.rpcHandlerManager.registerHandler<
            ArchiveCodexLocalSessionRequest,
            ArchiveCodexLocalSessionRpcResponse
        >(
            RPC_METHODS.ArchiveCodexLocalSession,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, code: 'session_not_found', error: 'sessionId is required' }
                }

                // A Kanban card has not necessarily opened the native drawer,
                // so warm this exact summary before checking ownership and
                // reserving it against SHAPI delivery. Message bodies stay cold.
                const summary = this.getNativeCodexSessionSummary(sessionId)
                if (!summary) {
                    return { success: false, code: 'session_not_found', error: 'Codex session not found' }
                }
                this.observeNativeCodexSession(sessionId)

                return await this.nativeCodexSessionDirectSender.archive(sessionId, async () => {
                    const appServer = this.createNativeCodexArchiveClient()
                    try {
                        await appServer.connect()
                        await appServer.initialize({
                            clientInfo: {
                                name: 'hapi-native-session-archive',
                                title: 'SHAPI Native Session Archive',
                                version: '1.0.0'
                            },
                            capabilities: { experimentalApi: true }
                        })
                        await appServer.archiveThread({ threadId: sessionId })

                        // Codex owns the file move/state transition. Clear all
                        // runner-derived views before notifying every browser so
                        // no stale local transcript row is rendered as success.
                        this.nativeCodexTranscriptCache.evict(sessionId)
                        this.nativeCodexSessionListCache.invalidate()
                        this.reportNativeCodexSessionUpdated(sessionId)
                        return { success: true }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        const unsupported = /(?:method not found|unknown method|thread\/archive.*(?:unsupported|not found)|-32601)/i.test(message)
                        return {
                            success: false,
                            code: unsupported ? 'archive_unsupported' : 'archive_failed',
                            error: unsupported
                                ? 'This Codex app-server does not support native session archive'
                                : message || 'Failed to archive native Codex session'
                        }
                    } finally {
                        await appServer.disconnect()
                    }
                })
            }
        )

        this.rpcHandlerManager.registerHandler<PathExistsRequest, PathExistsResponse>(RPC_METHODS.PathExists, async (params) => {
            const rawPaths = Array.isArray(params?.paths) ? params.paths : []
            const uniquePaths = Array.from(new Set(rawPaths.filter((path): path is string => typeof path === 'string')))
            const exists: Record<string, boolean> = {}

            await Promise.all(uniquePaths.map(async (path) => {
                const trimmed = path.trim()
                if (!trimmed) return
                try {
                    const stats = await stat(trimmed)
                    exists[trimmed] = stats.isDirectory()
                } catch {
                    exists[trimmed] = false
                }
            }))

            return { exists }
        })

        this.rpcHandlerManager.registerHandler<GetMachineGitBranchRequest, GitBranchResponse>(
            RPC_METHODS.GetMachineGitBranch,
            async (params) => {
                const rawCwd = typeof params?.cwd === 'string' ? params.cwd.trim() : ''
                if (!rawCwd) {
                    return { success: false, error: 'cwd is required' }
                }

                // A project header belongs to a directory, not to an active
                // SHAPI process. Match session creation's unrestricted cwd
                // policy so historical session groups can still show branch.
                const cwd = await this.resolveForWorkspaceCheck(rawCwd)
                return await getGitBranchStatusForCwd(cwd)
            }
        )

        this.rpcHandlerManager.registerHandler<ListMachineDirectoryRequest, MachineListDirectoryResponse>(RPC_METHODS.ListMachineDirectory, async (params) => {
            if (!this.normalizedWorkspaceRoots?.length) {
                return { success: false, error: 'Workspace browsing is not enabled for this machine' }
            }

            const rawPath = typeof params?.path === 'string' ? params.path.trim() : ''
            if (!rawPath) {
                return { success: false, error: 'Path is required' }
            }

            const targetPath = await this.resolveForWorkspaceCheck(rawPath)
            if (!this.isWithinWorkspaceRoots(targetPath)) {
                return { success: false, error: 'Path is outside workspace roots' }
            }

            try {
                const dirStat = await stat(targetPath)
                if (!dirStat.isDirectory()) {
                    return { success: false, error: 'Path is not a directory' }
                }

                const dirEntries = await readdir(targetPath, { withFileTypes: true })
                const entries: MachineDirectoryEntry[] = []

                await Promise.all(dirEntries.map(async (entry) => {
                    if (entry.name.startsWith('.')) return

                    const fullPath = join(targetPath, entry.name)
                    let type: 'file' | 'directory' | 'other' = 'other'
                    let size: number | undefined
                    let modified: number | undefined
                    let isGitRepo = false

                    if (entry.isDirectory()) {
                        type = 'directory'
                        try {
                            const gitStat = await stat(join(fullPath, '.git'))
                            isGitRepo = gitStat.isDirectory() || gitStat.isFile()
                        } catch {
                            // not a git repo
                        }
                    } else if (entry.isFile()) {
                        type = 'file'
                    }

                    if (!entry.isSymbolicLink()) {
                        try {
                            const stats = await stat(fullPath)
                            size = stats.size
                            modified = stats.mtime.getTime()
                        } catch {
                            // ignore stat errors
                        }
                    }

                    entries.push({ name: entry.name, type, size, modified, isGitRepo })
                }))

                entries.sort((a, b) => {
                    if (a.type === 'directory' && b.type !== 'directory') return -1
                    if (a.type !== 'directory' && b.type === 'directory') return 1
                    return a.name.localeCompare(b.name)
                })

                return { success: true, entries }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' }
            }
        })

        // OpenCode model discovery spawns an `opencode acp` subprocess scoped to
        // the requested cwd. Session creation is intentionally allowed to target
        // any directory the runner can access, so resolve the path for a stable
        // subprocess cwd but do not apply the optional browser-root restriction.
        // Re-register the handler that `registerCommonHandlers` installed so the
        // model probe follows the same unrestricted session-creation policy.
        this.rpcHandlerManager.registerHandler<ListOpencodeModelsForCwdRequest, ListOpencodeModelsForCwdResponse>(
            RPC_METHODS.ListOpencodeModelsForCwd,
            async (params) => {
                const rawCwd = typeof params?.cwd === 'string' ? params.cwd.trim() : ''
                if (!rawCwd) {
                    return { success: false, error: 'cwd is required' }
                }

                const resolvedCwd = await this.resolveForWorkspaceCheck(rawCwd)
                return await listOpencodeModelsForCwd(resolvedCwd)
            }
        )
    }

    private isWithinWorkspaceRoots(absolutePath: string): boolean {
        if (!this.normalizedWorkspaceRoots?.length) return true
        return this.normalizedWorkspaceRoots.some((workspaceRoot) => {
            const rel = relative(workspaceRoot, absolutePath)
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
        })
    }

    /**
     * Canonicalize a path for workspace-root containment checks. Resolves
     * symlinks via realpath so a symlink such as `/safe/out -> /etc` cannot
     * be used to escape the configured root with a lexical-only check.
     *
     * If the path doesn't exist (e.g. a session is being spawned in a
     * directory we'll create), walks up to the nearest existing ancestor
     * and realpaths *that*, joining the missing tail back on. This way the
     * check still runs against the real on-disk location once any
     * intermediate symlink in the parent chain has been resolved.
     */
    private async resolveForWorkspaceCheck(path: string): Promise<string> {
        const absolute = resolvePath(path)
        try {
            return await realpath(absolute)
        } catch {
            const missing: string[] = []
            let cursor = absolute
            while (cursor !== dirname(cursor)) {
                missing.unshift(basename(cursor))
                cursor = dirname(cursor)
                try {
                    return join(await realpath(cursor), ...missing)
                } catch {
                    // keep walking to the nearest existing parent
                }
            }
            return absolute
        }
    }

    setRPCHandlers({ spawnSession, stopSession, requestShutdown }: MachineRpcHandlers): void {
        this.rpcHandlerManager.registerHandler(RPC_METHODS.SpawnHappySession, async (params: any) => {
            const { directory, sessionId, resumeSessionId, forkSessionId, machineId, approvedNewDirectoryCreation, agent, model, effort, modelReasoningEffort, yolo, permissionMode, serviceTier, token, sessionType, worktreeName } = params || {}

            if (!directory) {
                throw new Error('Directory is required')
            }

            // `workspaceRoots` controls the optional file browser. It must not
            // block an explicitly requested session directory; users may run a
            // session in any path available to this runner.
            const result = await spawnSession({
                directory,
                sessionId,
                resumeSessionId,
                forkSessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                modelReasoningEffort,
                yolo,
                permissionMode,
                serviceTier,
                token,
                sessionType,
                worktreeName
            })

            switch (result.type) {
                case 'success':
                    return { type: 'success', sessionId: result.sessionId }
                case 'requestToApproveDirectoryCreation':
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory }
                case 'error':
                    return { type: 'error', errorMessage: result.errorMessage }
            }
        })

        this.rpcHandlerManager.registerHandler(RPC_METHODS.StopSession, (params: any) => {
            const { sessionId } = params || {}
            if (!sessionId) {
                throw new Error('Session ID is required')
            }

            const success = stopSession(sessionId)
            if (!success) {
                throw new Error('Session not found or failed to stop')
            }

            return { message: 'Session stopped' }
        })

        this.rpcHandlerManager.registerHandler(RPC_METHODS.StopRunner, () => {
            setTimeout(() => requestShutdown(), 100)
            return { message: 'Runner stop request acknowledged' }
        })
    }

    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata)

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: updated,
                expectedVersion: this.machine.metadataVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'metadata',
                parseValue: (value) => {
                    const parsed = MachineMetadataSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.metadata = value
                },
                applyVersion: (version) => {
                    this.machine.metadataVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid metadata value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-metadata response',
                errorMessage: 'Machine metadata update failed',
                versionMismatchMessage: 'Metadata version mismatch'
            })
        })
    }

    async updateRunnerState(handler: (state: RunnerState | null) => RunnerState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.runnerState)

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                runnerState: updated,
                expectedVersion: this.machine.runnerStateVersion
            }) as unknown

            applyVersionedAck(answer, {
                valueKey: 'runnerState',
                parseValue: (value) => {
                    const parsed = RunnerStateSchema.safeParse(value)
                    return parsed.success ? parsed.data : null
                },
                applyValue: (value) => {
                    this.machine.runnerState = value
                },
                applyVersion: (version) => {
                    this.machine.runnerStateVersion = version
                },
                logInvalidValue: (context, version) => {
                    const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                    logger.debug(`[API MACHINE] Ignoring invalid runnerState value from ${suffix}`, { version })
                },
                invalidResponseMessage: 'Invalid machine-update-state response',
                errorMessage: 'Machine state update failed',
                versionMismatchMessage: 'Runner state version mismatch'
            })
        })
    }

    /**
     * Forward a pending request from a locally launched, non-SHAPI Codex
     * session. This is intentionally best-effort, but Socket.IO may queue a
     * request during the runner's initial connection handshake.
     */
    reportExternalCodexRequest(
        request: Omit<ExternalCodexRequestPayload, 'machineId' | 'phase'> & { phase?: 'requested' | 'resolved' }
    ): boolean {
        const socket = this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined
        if (!socket) {
            logger.debug('[API MACHINE] Dropping external Codex request before socket setup')
            return false
        }

        const normalizedRequest: Omit<ExternalCodexRequestPayload, 'machineId'> = {
            ...request,
            phase: request.phase ?? 'requested'
        }
        const runnerOwnsUserInput = normalizedRequest.kind === 'user-input'
            && this.nativeCodexSessionDirectSender.ownsActiveDelivery(normalizedRequest.codexSessionId)
        const initialSummary = this.nativeCodexTranscriptCache.readSummary(normalizedRequest.codexSessionId)
        let transcriptChanged = false
        let transcriptUserInputChanged = false
        if (initialSummary) {
            transcriptChanged = this.nativeCodexTurnLifecycle.observeTranscriptEvents(
                request.codexSessionId,
                initialSummary.lifecycleEvents
            )
            transcriptUserInputChanged = runnerOwnsUserInput
                ? this.nativeCodexTurnLifecycle.suppressUserInputWait(request.codexSessionId)
                : this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(
                    request.codexSessionId,
                    initialSummary.userInputEvents
                )
        }
        const summary = initialSummary?.session ?? null
        const shouldTrackLocalInput = normalizedRequest.kind === 'user-input'
            && !runnerOwnsUserInput
            && (summary === null || !isHapiInitiatedCodexSession(summary))
        const hookChanged = shouldTrackLocalInput
            ? this.nativeCodexTurnLifecycle.observeExternalUserInput(normalizedRequest as ExternalCodexUserInputEvent)
            : false
        const localChanged = transcriptChanged || transcriptUserInputChanged || hookChanged

        const shouldForwardRequest = !runnerOwnsUserInput && (
            normalizedRequest.kind !== 'user-input'
            || (
                normalizedRequest.phase === 'requested'
                && shouldTrackLocalInput
                && this.nativeCodexTurnLifecycle.isActiveUserInputRequest(
                    normalizedRequest.codexSessionId,
                    normalizedRequest.requestId
                )
            )
        )
        if (shouldForwardRequest) {
            socket.emit('external-codex-request', {
                machineId: this.machine.id,
                ...normalizedRequest
            })
        }
        if (localChanged) {
            this.observeNativeCodexSession(normalizedRequest.codexSessionId)
            this.nativeCodexSessionDirectSender.notifyTranscriptChanged(normalizedRequest.codexSessionId)
            const updatedSummary = this.nativeCodexTranscriptCache
                .readSummary(normalizedRequest.codexSessionId)?.session ?? summary
            this.reportNativeCodexSessionUpdated(
                normalizedRequest.codexSessionId,
                normalizedRequest.observedAt ?? Date.now(),
                null,
                updatedSummary
            )
        }
        return true
    }

    /** Apply a local UserPromptSubmit turn start without emitting an alert. */
    observeExternalCodexLifecycle(event: ExternalCodexLifecycleEvent): boolean {
        // Read existing transcript terminals before accepting the asynchronous
        // hook. A completed turn must never be resurrected by late delivery.
        const initialSummary = this.nativeCodexTranscriptCache.readSummary(event.codexSessionId)
        const transcriptChanged = initialSummary
            ? this.nativeCodexTurnLifecycle.observeTranscriptEvents(event.codexSessionId, initialSummary.lifecycleEvents)
            : false
        const userInputChanged = initialSummary
            ? this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(event.codexSessionId, initialSummary.userInputEvents)
            : false
        const hookChanged = this.nativeCodexTurnLifecycle.observeHookStart(event)
        if (!transcriptChanged && !userInputChanged && !hookChanged) {
            return false
        }

        const summary = this.nativeCodexTranscriptCache.readSummary(event.codexSessionId)?.session ?? null
        if (summary) {
            this.observeNativeCodexSession(event.codexSessionId)
        }
        this.nativeCodexSessionDirectSender.notifyTranscriptChanged(event.codexSessionId)
        this.reportNativeCodexSessionUpdated(event.codexSessionId, event.observedAt, null, summary)
        return true
    }

    private readNativeCodexTranscript(
        sessionId: string,
        options: Parameters<NativeCodexTranscriptCache['read']>[1] = {}
    ): NativeCodexTranscriptRead | null {
        const initialRead = this.nativeCodexTranscriptCache.read(sessionId, options)
        if (!initialRead) return null

        const lifecycleChanged = this.nativeCodexTurnLifecycle.observeTranscriptEvents(
            sessionId,
            initialRead.lifecycleEvents
        )
        const runnerOwnsDelivery = this.nativeCodexSessionDirectSender.ownsActiveDelivery(sessionId)
        const userInputChanged = runnerOwnsDelivery
            ? this.nativeCodexTurnLifecycle.suppressUserInputWait(sessionId)
            : this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(
                sessionId,
                initialRead.userInputEvents
            )
        if (lifecycleChanged || userInputChanged) {
            this.nativeCodexSessionDirectSender.notifyTranscriptChanged(sessionId)
        }
        const read = lifecycleChanged || userInputChanged
            ? this.nativeCodexTranscriptCache.readCached(sessionId, options) ?? initialRead
            : initialRead
        return this.withNativeCodexTitle(read)
    }

    /**
     * The direct-send queue reads this path outside watcher callbacks. Consume
     * any newly appended terminal before it decides whether a queued prompt is
     * safe to deliver. This method deliberately does not emit: the watcher or
     * caller owns browser notification, while the local state must be current.
     */
    private getNativeCodexSessionSummary(sessionId: string): CodexLocalSessionSummary | null {
        const initialRead = this.nativeCodexTranscriptCache.readSummary(sessionId)
        if (!initialRead) return null

        const lifecycleChanged = this.nativeCodexTurnLifecycle.observeTranscriptEvents(
            sessionId,
            initialRead.lifecycleEvents
        )
        const runnerOwnsDelivery = this.nativeCodexSessionDirectSender.ownsActiveDelivery(sessionId)
        const userInputChanged = runnerOwnsDelivery
            ? this.nativeCodexTurnLifecycle.suppressUserInputWait(sessionId)
            : this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(
                sessionId,
                initialRead.userInputEvents
            )
        const session = lifecycleChanged || userInputChanged
            ? this.nativeCodexTranscriptCache.readSummary(sessionId)?.session ?? initialRead.session
            : initialRead.session
        return this.maskRunnerOwnedNativeUserInput(session)
    }

    private handleNativeCodexLifecycleChange(sessionId: string): void {
        // Both the short hook lease and the five-minute transcript freshness
        // boundary need an event even when the JSONL stops changing. The
        // summary/status serializers convert those states to unknown, never
        // to an unsafe idle claim.
        const summary = this.nativeCodexTranscriptCache.readSummary(sessionId)?.session ?? null
        this.nativeCodexSessionDirectSender.notifyTranscriptChanged(sessionId)
        this.reportNativeCodexSessionUpdated(sessionId, Date.now(), null, summary)
    }

    private observeNativeCodexSession(sessionId: string): void {
        const session = this.getNativeCodexSessionSummary(sessionId)
        if (!session) {
            return
        }
        this.nativeCodexSessionWatcher.observeTranscript(session.file, session.id)
    }

    private reportNativeCodexSessionUpdated(
        codexSessionId: string,
        modifiedAt = Date.now(),
        transcriptRead?: NativeCodexTranscriptRead | null,
        listSession?: CodexLocalSessionSummary | null
    ): boolean {
        const socket = this.socket as Socket<ServerToClientEvents, ClientToServerEvents> | undefined
        if (!socket) {
            return false
        }
        const cachedRead = transcriptRead === undefined
            ? this.nativeCodexTranscriptCache.readCached(codexSessionId, { limit: 50 })
            : transcriptRead
        const read = cachedRead ? this.withNativeCodexTitle(cachedRead) : null
        // The watcher also monitors recently active local transcripts that no
        // browser has opened. Do not turn those lightweight invalidations
        // into a full cross-directory session lookup merely to construct a
        // status payload; an open detail already has a hot cache entry.
        const status = read
            ? this.getNativeCodexSessionStatus(codexSessionId, read.data.session, read.plan)
            : null
        // Every matching browser receives this global event. Send an
        // invalidation version plus status only; an opened detail asks for
        // transcript bodies through its conditional snapshot RPC.
        const snapshot = read && status?.success === true
            ? buildNativeCodexRealtimeSnapshot(read, status)
            : undefined
        const rawSummary = read?.data.session ?? listSession
        const summary = rawSummary ? this.maskRunnerOwnedNativeUserInput(rawSummary) : null
        socket.emit('codex-session-updated', {
            machineId: this.machine.id,
            codexSessionId,
            modifiedAt,
            ...(summary ? { summary: toNativeCodexSessionListUpdate(summary) } : {}),
            ...(snapshot === undefined ? {} : { snapshot })
        })
        return true
    }

    /**
     * Plan steps travel only in the full snapshot body. Realtime updates carry
     * the tiny active turn identity so a newly started turn immediately hides
     * a cached plan belonging to the preceding turn.
     */
    private getNativeCodexSessionStatus(
        sessionId: string,
        summary?: CodexLocalSessionSummary | null,
        plan?: NativeCodexTranscriptRead['plan']
    ): CodexLocalSessionStatusRpcResponse {
        const status = this.nativeCodexSessionDirectSender.getStatus(sessionId, summary)
        if (status.success !== true || status.status !== 'processing') {
            return status
        }
        const activeTurnId = this.nativeCodexTurnLifecycle.getActiveTurnId(sessionId)
            ?? plan?.turnId
        return activeTurnId ? { ...status, activeTurnId } : status
    }

    private withNativeCodexTitle(read: NativeCodexTranscriptRead): NativeCodexTranscriptRead {
        const title = this.nativeCodexSessionTitleCache.resolve([read.data.session.id]).get(read.data.session.id)
        const session = this.maskRunnerOwnedNativeUserInput(read.data.session)
        if ((!title || title === session.title) && session === read.data.session) return read

        return {
            ...read,
            data: {
                ...read.data,
                session: {
                    ...session,
                    ...(title ? { title } : {})
                }
            }
        }
    }

    private maskRunnerOwnedNativeUserInput(session: CodexLocalSessionSummary): CodexLocalSessionSummary {
        return session.waitingForUserInput === true
            && this.nativeCodexSessionDirectSender.ownsActiveDelivery(session.id)
            ? { ...session, waitingForUserInput: false }
            : session
    }

    connect(): void {
        this.socket = io(`${configuration.apiUrl}/cli`, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            ...buildSocketIoExtraHeaderOptions()
        })
        // Create the socket before the transcript watcher so a change during
        // runner startup is queued by Socket.IO instead of being dropped.
        this.nativeCodexSessionWatcher.start()

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to bot')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            this.updateRunnerState((state) => ({
                ...(state ?? {}),
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.runnerState?.httpPort,
                startedAt: Date.now()
            })).catch((error) => {
                logger.debug('[API MACHINE] Failed to update runner state on connect', error)
            })

            const advertisedMetadata = this.advertisedMetadata
            if (advertisedMetadata && !runnerMetadataMatchesAdvertised(this.machine.metadata, advertisedMetadata)) {
                this.updateMachineMetadata((current) => {
                    return mergeAdvertisedRunnerMetadata(current ?? this.machine.metadata, advertisedMetadata)
                }).then(() => {
                    logger.debug('[API MACHINE] Runner metadata synced to hub')
                }).catch((error) => {
                    logger.debug('[API MACHINE] Failed to sync runner metadata to hub', error)
                })
            }

            this.startKeepAlive()
        })

        this.socket.on('disconnect', () => {
            logger.debug('[API MACHINE] Disconnected from bot')
            this.rpcHandlerManager.onSocketDisconnect()
            this.stopKeepAlive()
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('file:read-bytes', async (data: BinaryFileReadRequest, callback: (response: BinaryFileReadResponse) => void) => {
            try {
                if (data.type === 'machine-file') {
                    const cwd = typeof data.cwd === 'string' ? data.cwd.trim() : ''
                    const path = typeof data.path === 'string' ? data.path.trim() : ''
                    if (!cwd) {
                        callback({ success: false, error: 'cwd is required' })
                        return
                    }
                    if (!path) {
                        callback({ success: false, error: 'path is required' })
                        return
                    }

                    callback(await readSessionFileBytes(path, cwd))
                    return
                }

                if (data.type === 'uploaded-file') {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : ''
                    if (!sessionId) {
                        callback({ success: false, error: 'sessionId is required' })
                        return
                    }
                    callback(await readUploadFileBytes(data.path, sessionId))
                    return
                }

                if (data.type !== 'generated-image-file') {
                    callback({ success: false, error: 'Unsupported machine file read' })
                    return
                }

                callback(await readGeneratedImageFileBytes(data))
            } catch (error) {
                callback({ success: false, error: error instanceof Error ? error.message : String(error) })
            }
        })

        this.socket.on(
            'native-kanban-feedback:stage',
            (data: NativeKanbanFeedbackStageRequest, callback: (response: NativeKanbanFeedbackStageResponse) => void) => {
                const sessionId = typeof data?.codexSessionId === 'string' ? data.codexSessionId.trim() : ''
                const summary = sessionId ? this.getNativeCodexSessionSummary(sessionId) : null
                if (!summary || isHapiInitiatedCodexSession(summary)) {
                    callback({ success: false, error: 'Only an original native Codex session may receive feedback' })
                    return
                }
                callback(this.nativeKanbanFeedbackStore.stage({ ...data, codexSessionId: sessionId }))
            }
        )

        this.socket.on(
            'native-kanban-feedback:delete',
            (data: NativeKanbanFeedbackDeleteRequest, callback: (response: NativeKanbanFeedbackDeleteResponse) => void) => {
                callback(this.nativeKanbanFeedbackStore.delete(data))
            }
        )

        this.socket.on('update', (data: Update) => {
            if (data.body.t !== 'update-machine') {
                return
            }

            const update = data.body as UpdateMachineBody
            if (update.machineId !== this.machine.id) {
                return
            }

            if (update.metadata) {
                const parsed = MachineMetadataSchema.safeParse(update.metadata.value)
                if (parsed.success) {
                    this.machine.metadata = parsed.data
                } else {
                    logger.debug('[API MACHINE] Ignoring invalid metadata update', { version: update.metadata.version })
                }
                this.machine.metadataVersion = update.metadata.version
            }

            if (update.runnerState) {
                const next = update.runnerState.value
                if (next == null) {
                    this.machine.runnerState = null
                } else {
                    const parsed = RunnerStateSchema.safeParse(next)
                    if (parsed.success) {
                        this.machine.runnerState = parsed.data
                    } else {
                        logger.debug('[API MACHINE] Ignoring invalid runnerState update', { version: update.runnerState.version })
                    }
                }
                this.machine.runnerStateVersion = update.runnerState.version
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`)
        })

        this.socket.on('error', (payload) => {
            logger.debug('[API MACHINE] Socket error:', payload)
        })
    }

    private startKeepAlive(): void {
        this.stopKeepAlive()
        const emitAlive = () => {
            this.socket.emit('machine-alive', {
                machineId: this.machine.id,
                time: Date.now(),
                health: collectMachineHealth()
            })
        }
        // Prime CPU sampling so the first heartbeat already includes CPU %.
        collectMachineHealth()
        this.keepAliveStartTimeout = setTimeout(() => {
            this.keepAliveStartTimeout = null
            emitAlive()
            this.keepAliveInterval = setInterval(emitAlive, 20_000)
        }, 50)
    }

    private stopKeepAlive(): void {
        if (this.keepAliveStartTimeout) {
            clearTimeout(this.keepAliveStartTimeout)
            this.keepAliveStartTimeout = null
        }
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval)
            this.keepAliveInterval = null
        }
    }

    shutdown(): void {
        this.stopKeepAlive()
        this.nativeCodexSessionWatcher.stop()
        this.nativeCodexSessionDirectSender.dispose()
        this.nativeCodexTurnLifecycle.dispose()
        if (this.socket) {
            this.socket.close()
        }
    }
}
