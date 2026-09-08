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
    NativeCodexAttachmentDeleteRequest,
    NativeCodexAttachmentDeleteResponse,
    NativeCodexAttachmentStageRequest,
    NativeCodexAttachmentStageResponse,
    NativeKanbanFeedbackDeleteRequest,
    NativeKanbanFeedbackDeleteResponse,
    NativeKanbanFeedbackStageRequest,
    NativeKanbanFeedbackStageResponse,
    ServerToClientEvents,
    Update,
    UpdateMachineBody
} from '@hapi/protocol'
import {
    MachineGitBranchCreateRequestSchema,
    MachineGitBranchCommitRequestSchema,
    MachineGitBranchesRequestSchema,
    MachineGitBranchFetchRequestSchema,
    MachineGitBranchPushRequestSchema,
    MachineGitBranchSwitchRequestSchema,
    MachineGitBranchUpdateRequestSchema
} from '@hapi/protocol/apiTypes'
import type {
    FileReadResponse,
    GitBranchResponse,
    GitBranchesResponse,
    GitCommandResponse,
    MachineDirectoryEntry,
    MachineListDirectoryResponse,
    PathExistsResponse
} from '@hapi/protocol/apiTypes'
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
    type CodexImportedMessageContent,
    type CodexTranscriptLifecycleEvent,
    type CodexLocalSessionsRpcResponse,
    type NativeCodexDeliveryPolicy,
    type NativeCodexSessionControlAction,
    type NativeCodexSessionConfiguration,
    type NativeCodexSessionControlResponse,
    type NativeKanbanFeedbackReviewGuard,
    type SendCodexLocalSessionMessageRpcResponse,
    isHapiInitiatedCodexSession,
    parseNativeCodexAttachmentPrompt,
    readLocalCodexSessionSummary
} from '@hapi/protocol/codexTranscript'
import { NativeCodexSessionControlActionSchema } from '@hapi/protocol/codexTranscript'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import {
    FileNativeCodexSessionDirectSendStore,
    type NativeCodexSessionControlContext,
    NativeCodexSessionDirectSender,
    type NativeCodexTranscriptUserMessageEvidence
} from '@/codex/nativeSessionDirectSend'
import { FileNativeCodexSessionControlStore } from '@/codex/nativeCodexControlStore'
import { NativeCodexAttachmentStore } from '@/codex/nativeCodexAttachmentStore'
import { NativeKanbanFeedbackStore } from '@/codex/nativeKanbanFeedbackStore'
import { CodexAppServerClient } from '@/codex/codexAppServerClient'
import { CodexSshAppServerClient } from '@/codex/codexSshAppServerClient'
import { NativeCodexSessionListCache } from '@/codex/nativeSessionListCache'
import { NativeCodexSessionTitleCache } from '@/codex/nativeSessionTitleCache'
import { NativeCodexTranscriptCache, readRecentLifecycleTail, type NativeCodexTranscriptRead } from '@/codex/nativeTranscriptCache'
import { NativeCodexSessionWatcher } from '@/codex/nativeSessionWatcher'
import { CodexSshSessionOwnershipProbe, getCodexSshControlSocketPath } from '@/codex/codexSshOwnership'
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
import { LocalServiceTunnels } from '../runner/localServiceTunnels'
import { localServiceSocketWire } from '@hapi/protocol/localServiceTransport'
import { LOCAL_SERVICE_RPC, type LocalServiceTunnelRequest, type LocalServiceTunnelResponse } from '@hapi/protocol/localServices'
import { listSlashCommands } from '../modules/common/slashCommands'
import { listSkills } from '../modules/common/skills'
import { listCodexModels } from '../modules/common/codexModels'
import { RenameNativeCodexSessionRequestSchema, type RenameNativeCodexSessionResponse, type CodexModelSummary } from '@hapi/protocol/apiTypes'
import {
    commitGitChangesForCwd,
    createGitBranchForCwd,
    fetchGitBranchesForCwd,
    getGitBranchesForCwd,
    getGitBranchStatusForCwd,
    pushGitBranchForCwd,
    switchGitBranchForCwd,
    updateGitBranchForCwd
} from '../modules/common/handlers/git'
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

const CODEX_SSH_OWNERSHIP_MONITOR_INTERVAL_MS = 1_000
const NATIVE_CODEX_ATTACHMENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000

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

interface ControlCodexLocalSessionRequest {
    sessionId?: unknown
    action?: unknown
    expectedTurnId?: unknown
    configuration?: unknown
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
    attachmentIds?: unknown
}

interface DiscardCodexLocalSessionMessageRequest {
    sessionId?: unknown
    clientMessageId?: unknown
}

interface ArchiveCodexLocalSessionRequest {
    sessionId?: unknown
}

function getNativeCodexTranscriptUserMessageEvidence(
    messages: readonly CodexImportedMessageContent[]
): NativeCodexTranscriptUserMessageEvidence[] {
    const evidence: NativeCodexTranscriptUserMessageEvidence[] = []
    for (const message of messages) {
        if (message.role !== 'user' || message.content.type !== 'text') continue
        const text = (parseNativeCodexAttachmentPrompt(message.content.text)?.text ?? message.content.text).trim()
        const createdAt = message.createdAt
        if (!text || createdAt === undefined || !Number.isFinite(createdAt) || createdAt < 0) continue
        evidence.push({ text, createdAt })
    }
    return evidence
}

function toNativeCodexSessionListUpdate(session: CodexLocalSessionSummary): CodexLocalSessionListUpdate {
    const normalized = normalizeNativeCodexSessionForDisplay(session)
    const { file: _file, ...summary } = normalized
    return { ...summary, controlledByCodexSsh: normalized.controlledByCodexSsh ?? false }
}

function toNativeCodexSessionDisplaySummary(session: CodexLocalSessionSummary): CodexLocalSessionDisplaySummary {
    const normalized = normalizeNativeCodexSessionForDisplay(session)
    return {
        id: normalized.id,
        title: normalized.title,
        cwd: normalized.cwd,
        modifiedAt: normalized.modifiedAt,
        model: normalized.model,
        modelReasoningEffort: normalized.modelReasoningEffort,
        controlledByCodexSsh: normalized.controlledByCodexSsh ?? false
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
    private readonly localServiceTunnels = new LocalServiceTunnels(() => {
        const ports = [this.machine.runnerState?.httpPort].filter((port): port is number => typeof port === 'number')
        try {
            const hub = new URL(configuration.apiUrl)
            if (['localhost', '127.0.0.1', '[::1]'].includes(hub.hostname)) {
                ports.push(Number(hub.port || (hub.protocol === 'https:' ? 443 : 80)))
            }
        } catch { /* Existing connection validation reports invalid Hub URLs. */ }
        return ports
    })
    private socket!: Socket<ServerToClientEvents, ClientToServerEvents>
    private keepAliveInterval: NodeJS.Timeout | null = null
    private keepAliveStartTimeout: ReturnType<typeof setTimeout> | null = null
    private codexSshOwnershipMonitor: ReturnType<typeof setInterval> | null = null
    private nativeCodexAttachmentCleanupTimer: ReturnType<typeof setInterval> | null = null
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
        readSummary: (filePath, modifiedAt, size) => {
            const session = readLocalCodexSessionSummary(filePath, modifiedAt, size)
            if (session && size !== undefined) {
                // A missed watcher callback must not leave the old hook lease
                // overriding a completed transcript on the list page.
                const tail = readRecentLifecycleTail(filePath, size)
                this.observeNativeCodexLifecycleEvents(session.id, tail.lifecycleEvents)
                if (this.nativeCodexSessionDirectSender.ownsActiveDelivery(session.id)) {
                    this.nativeCodexTurnLifecycle.suppressUserInputWait(session.id)
                } else {
                    this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(session.id, tail.userInputEvents)
                }
            }
            return session
        },
        resolveTitles: (sessionIds, options) => this.nativeCodexSessionTitleCache.resolve(sessionIds, options),
        applyLifecycle: (session) => normalizeNativeCodexSessionForDisplay(
            this.maskRunnerOwnedNativeUserInput(
                this.nativeCodexTurnLifecycle.applyToSummary(session)
            )
        )
    })
    private readonly nativeCodexSshOwnership = new CodexSshSessionOwnershipProbe()
    private readonly nativeCodexSessionDirectSender: NativeCodexSessionDirectSender
    private nativeCodexModelCatalog: { loadedAt: number; models: CodexModelSummary[] } | null = null
    private readonly nativeKanbanFeedbackStore = new NativeKanbanFeedbackStore(
        join(configuration.happyHomeDir, 'native-kanban-feedback')
    )
    private readonly nativeCodexAttachmentStore = new NativeCodexAttachmentStore(
        join(configuration.happyHomeDir, 'native-codex-attachments')
    )
    private readonly nativeCodexSessionWatcher = new NativeCodexSessionWatcher({
        onChange: ({ codexSessionId, filePath, modifiedAt }) => {
            let read = this.nativeCodexTranscriptCache.refreshCachedFromFile(
                codexSessionId,
                filePath,
                { limit: 50 }
            )
            if (!read && this.nativeCodexSessionDirectSender.needsTranscriptDeliveryEvidence(codexSessionId)) {
                read = this.nativeCodexTranscriptCache.read(codexSessionId, { limit: 50 })
            }
            const summaryRead = read ?? this.nativeCodexTranscriptCache.refreshSummaryFromFile(codexSessionId, filePath)
            if (summaryRead) {
                this.observeNativeCodexLifecycleEvents(codexSessionId, summaryRead.lifecycleEvents)
                if (this.nativeCodexSessionDirectSender.ownsActiveDelivery(codexSessionId)) {
                    this.nativeCodexTurnLifecycle.suppressUserInputWait(codexSessionId)
                } else {
                    this.nativeCodexTurnLifecycle.observeTranscriptUserInputEvents(codexSessionId, summaryRead.userInputEvents)
                }
            }
            const listSession = this.nativeCodexSessionListCache.update(filePath, modifiedAt)
            this.nativeCodexSessionDirectSender.notifyTranscriptChanged(
                codexSessionId,
                read ? getNativeCodexTranscriptUserMessageEvidence(read.data.importedMessages) : []
            )
            this.reportNativeCodexSessionUpdated(codexSessionId, modifiedAt, read, listSession)
        }
    })

    private readonly normalizedWorkspaceRoots: string[] | undefined

    constructor(
        private readonly token: string,
        private readonly machine: Machine,
        private readonly workspaceRoots?: string[],
        private readonly advertisedMetadata?: MachineMetadata,
        private readonly createNativeCodexArchiveClient: () => NativeCodexArchiveClient = () => new CodexAppServerClient(),
        private readonly createNativeCodexRenameClient: () => Pick<CodexAppServerClient, 'connect' | 'initialize' | 'setThreadName' | 'disconnect'> = () => new CodexAppServerClient()
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
            (sessionId, guard) => this.nativeKanbanFeedbackStore.verify(sessionId, guard),
            (sessionId) => this.isNativeCodexSessionControlledBySsh(sessionId, { forceRefresh: true }),
            () => new CodexSshAppServerClient({ socketPath: getCodexSshControlSocketPath() }),
            new FileNativeCodexSessionControlStore(join(configuration.happyHomeDir, 'native-codex-controls.json')),
            (sessionId, nativeConfiguration) => this.validateNativeCodexConfiguration(sessionId, nativeConfiguration),
            (sessionId, attachmentIds) => this.nativeCodexAttachmentStore.resolve(sessionId, attachmentIds),
            (sessionId, attachmentIds) => this.nativeCodexAttachmentStore.deleteMany(sessionId, attachmentIds)
        )

        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            logger: (msg, data) => logger.debug(msg, data)
        })
        this.nativeCodexSessionDirectSender.setStateChangeListener((sessionId) => {
            this.reportNativeCodexSessionUpdated(sessionId)
        })
        this.startNativeCodexAttachmentCleanup()

        registerCommonHandlers(this.rpcHandlerManager, getInvokedCwd())
        this.rpcHandlerManager.registerHandler<LocalServiceTunnelRequest, LocalServiceTunnelResponse>(
            LOCAL_SERVICE_RPC,
            (request) => this.localServiceTunnels.open(request)
        )

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
                const heldSessionIds = await this.refreshNativeCodexSshOwnership({ forceRefresh: forceRefresh === true })
                return {
                    success: true,
                    sessions: this.nativeCodexSessionListCache.list(
                        limit ?? 500,
                        { excludeHapiInitiated },
                        { forceRefresh }
                    ).map((session) => this.withNativeCodexSshControl(session, heldSessionIds))
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
                await this.refreshNativeCodexSshOwnership()
                const read = this.readNativeCodexTranscript(sessionId, { before, limit })
                if (read) {
                    this.observeNativeCodexSession(sessionId)
                }
                const controlledRead = read ? this.withNativeCodexSshControlForRead(read) : null
                return controlledRead
                    ? { success: true, data: controlledRead.data }
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

                await this.refreshNativeCodexSshOwnership()
                const read = this.readNativeCodexTranscript(sessionId, { before, limit })
                if (!read) {
                    return { success: false, error: 'Codex session not found' }
                }
                this.observeNativeCodexSession(sessionId)
                const controlledRead = this.withNativeCodexSshControlForRead(read)
                const status = this.getNativeCodexSessionStatus(sessionId, controlledRead.data.session)
                if (status.success !== true) {
                    return { success: false, error: status.error }
                }
                const canUseKnownVersion = before === undefined && (limit ?? 50) === 50
                if (knownVersion
                    && canUseKnownVersion
                    && knownVersion.runnerEpoch === controlledRead.version.runnerEpoch
                    && knownVersion.revision === controlledRead.version.revision) {
                    return {
                        success: true,
                        unchanged: true,
                        version: controlledRead.version,
                        revision: controlledRead.revision,
                        session: toNativeCodexSessionDisplaySummary(controlledRead.data.session),
                        status,
                        timing: controlledRead.timing
                    }
                }
                return {
                    success: true,
                    unchanged: false,
                    snapshot: {
                        data: controlledRead.data,
                        status,
                        plan: controlledRead.plan,
                        version: controlledRead.version,
                        revision: controlledRead.revision,
                        timing: controlledRead.timing
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
                await this.refreshNativeCodexSshOwnership()
                return this.getNativeCodexSessionStatus(sessionId, summary ?? undefined)
            }
        )

        this.rpcHandlerManager.registerHandler<ControlCodexLocalSessionRequest, NativeCodexSessionControlResponse>(
            RPC_METHODS.ControlCodexLocalSession,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                if (!sessionId) {
                    return { success: false, code: 'invalid_request', error: 'sessionId is required' }
                }
                const action = NativeCodexSessionControlActionSchema.safeParse({
                    action: params?.action,
                    ...(params?.expectedTurnId === undefined ? {} : { expectedTurnId: params.expectedTurnId }),
                    ...(params?.configuration === undefined ? {} : { configuration: params.configuration })
                })
                if (!action.success) {
                    return { success: false, code: 'invalid_request', error: 'A valid native control action is required' }
                }
                const summary = this.getNativeCodexSessionSummary(sessionId)
                if (!summary) {
                    return { success: false, code: 'session_not_found', error: 'Codex session not found' }
                }
                this.observeNativeCodexSession(sessionId)
                await this.refreshNativeCodexSshOwnership({ forceRefresh: true })
                const currentSummary = this.getNativeCodexSessionSummary(sessionId) ?? summary
                const status = this.getNativeCodexSessionStatus(sessionId, currentSummary)
                const controlledByCodexSsh = !isHapiInitiatedCodexSession(currentSummary)
                    && this.nativeCodexSshOwnership.getCachedHeldSessionIds().has(sessionId)
                const activeTurnId = status.success === true ? status.activeTurnId ?? null : null
                const context: NativeCodexSessionControlContext = { controlledByCodexSsh, activeTurnId }
                const result = await this.nativeCodexSessionDirectSender.control(sessionId, action.data, context)
                this.reportNativeCodexSessionUpdated(sessionId)
                return result
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
                return await this.nativeCodexSessionDirectSender.sendWithExternalControlCheck(
                    sessionId,
                    params?.message,
                    params?.displayMessage,
                    params?.clientMessageId,
                    params?.forceRecovery,
                    params?.deliveryPolicy as NativeCodexDeliveryPolicy | undefined,
                    params?.reviewGuard as NativeKanbanFeedbackReviewGuard | undefined,
                    params?.attachmentIds
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

        this.rpcHandlerManager.registerHandler<{ sessionId?: unknown; name?: unknown }, RenameNativeCodexSessionResponse>(
            RPC_METHODS.RenameCodexLocalSession,
            async (params) => {
                const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : ''
                const request = RenameNativeCodexSessionRequestSchema.safeParse(params)
                if (!sessionId || !request.success) {
                    return { success: false, code: 'invalid_request', error: 'A session ID and a name of 1–255 characters are required' }
                }
                const summary = this.getNativeCodexSessionSummary(sessionId)
                if (!summary) {
                    return { success: false, code: 'session_not_found', error: 'Codex session not found' }
                }
                if (isHapiInitiatedCodexSession(summary)) {
                    return { success: false, code: 'not_native_session', error: 'Rename this session from its SHAPI session page' }
                }
                const appServer = this.createNativeCodexRenameClient()
                try {
                    await appServer.connect()
                    await appServer.initialize({
                        clientInfo: { name: 'hapi-native-session-rename', title: 'SHAPI Native Session Rename', version: '1.0.0' },
                        capabilities: { experimentalApi: true }
                    })
                    // Metadata-only API: do not resume a thread or acquire its writer.
                    await appServer.setThreadName({ threadId: sessionId, name: request.data.name })
                    this.nativeCodexSessionTitleCache.resolve([sessionId], { forceRefresh: true })
                    this.nativeCodexSessionListCache.invalidate()
                    this.reportNativeCodexSessionUpdated(sessionId, summary.modifiedAt, undefined, { ...summary, title: request.data.name })
                    return { success: true, name: request.data.name }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    const unsupported = /method not found|unknown method|-32601/i.test(message)
                    return {
                        success: false,
                        code: unsupported ? 'rename_unsupported' : 'rename_failed',
                        error: unsupported ? 'This Codex version does not support renaming native sessions' : message
                    }
                } finally {
                    await appServer.disconnect().catch(() => {})
                }
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

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.GetMachineGitBranches,
            async (params) => {
                const parsed = MachineGitBranchesRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git branch request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await getGitBranchesForCwd(cwd)
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.SwitchMachineGitBranch,
            async (params) => {
                const parsed = MachineGitBranchSwitchRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git branch switch request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await switchGitBranchForCwd(cwd, {
                    target: parsed.data.target,
                    confirmDirty: parsed.data.confirmDirty
                })
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.CreateMachineGitBranch,
            async (params) => {
                const parsed = MachineGitBranchCreateRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git branch creation request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await createGitBranchForCwd(cwd, { name: parsed.data.name })
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.CommitMachineGitChanges,
            async (params) => {
                const parsed = MachineGitBranchCommitRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git commit request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await commitGitChangesForCwd(cwd, { message: parsed.data.message })
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.PushMachineGitBranch,
            async (params) => {
                const parsed = MachineGitBranchPushRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git push request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await pushGitBranchForCwd(cwd)
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.FetchMachineGitBranches,
            async (params) => {
                const parsed = MachineGitBranchFetchRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git fetch request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await fetchGitBranchesForCwd(cwd)
            }
        )

        this.rpcHandlerManager.registerHandler<unknown, GitBranchesResponse>(
            RPC_METHODS.UpdateMachineGitBranch,
            async (params) => {
                const parsed = MachineGitBranchUpdateRequestSchema.safeParse(params)
                if (!parsed.success) {
                    return { success: false, error: 'Invalid Git update request' }
                }

                const cwd = await this.resolveForWorkspaceCheck(parsed.data.cwd)
                return await updateGitBranchForCwd(cwd)
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
            transcriptChanged = this.observeNativeCodexLifecycleEvents(
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
            ? this.observeNativeCodexLifecycleEvents(event.codexSessionId, initialSummary.lifecycleEvents)
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

        const lifecycleChanged = this.observeNativeCodexLifecycleEvents(
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
        const read = lifecycleChanged || userInputChanged
            ? this.nativeCodexTranscriptCache.readCached(sessionId, options) ?? initialRead
            : initialRead
        this.nativeCodexSessionDirectSender.notifyTranscriptChanged(
            sessionId,
            getNativeCodexTranscriptUserMessageEvidence(read.data.importedMessages)
        )
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

        const lifecycleChanged = this.observeNativeCodexLifecycleEvents(
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

    /**
     * Refreshes the optional Desktop SSH owner list. A change emits the same
     * native-session invalidation used for transcript updates, including an
     * explicit `controlledByCodexSsh: false` when SSH releases a thread.
     */
    private async refreshNativeCodexSshOwnership(
        options: { forceRefresh?: boolean } = {}
    ): Promise<ReadonlySet<string>> {
        const previous = this.nativeCodexSshOwnership.getCachedHeldSessionIds()
        const current = await this.nativeCodexSshOwnership.getHeldSessionIds(options)
        const changedSessionIds = new Set<string>()
        for (const sessionId of previous) {
            if (!current.has(sessionId)) changedSessionIds.add(sessionId)
        }
        for (const sessionId of current) {
            if (!previous.has(sessionId)) changedSessionIds.add(sessionId)
        }

        for (const sessionId of changedSessionIds) {
            // Populate the small summary when it is still available. This is
            // deliberately bounded to changed thread ids, not a global scan.
            this.reportNativeCodexSessionUpdated(
                sessionId,
                Date.now(),
                undefined,
                this.getNativeCodexSessionSummary(sessionId)
            )
        }
        return current
    }

    /** Fresh send/archive gate. HAPI-originated app-server threads are never claimed. */
    private async isNativeCodexSessionControlledBySsh(
        sessionId: string,
        options: { forceRefresh?: boolean } = {}
    ): Promise<boolean> {
        const session = this.getNativeCodexSessionSummary(sessionId)
        if (!session || isHapiInitiatedCodexSession(session)) return false
        return (await this.refreshNativeCodexSshOwnership(options)).has(sessionId)
    }

    private withNativeCodexSshControl(
        session: CodexLocalSessionSummary,
        heldSessionIds = this.nativeCodexSshOwnership.getCachedHeldSessionIds()
    ): CodexLocalSessionSummary {
        const controlledByCodexSsh = !isHapiInitiatedCodexSession(session) && heldSessionIds.has(session.id)
        return session.controlledByCodexSsh === controlledByCodexSsh
            ? session
            : { ...session, controlledByCodexSsh }
    }

    private withNativeCodexSshControlForRead(read: NativeCodexTranscriptRead): NativeCodexTranscriptRead {
        const session = this.withNativeCodexSshControl(read.data.session)
        if (session === read.data.session) return read
        return {
            ...read,
            data: {
                ...read.data,
                session
            }
        }
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
        const read = cachedRead
            ? this.withNativeCodexSshControlForRead(this.withNativeCodexTitle(cachedRead))
            : null
        // The watcher also monitors recently active local transcripts that no
        // browser has opened. Do not turn those lightweight invalidations
        // into a full cross-directory session lookup merely to construct a
        // status payload; an open detail already has a hot cache entry.
        const status = read
            ? this.getNativeCodexSessionStatus(codexSessionId, read.data.session)
            : null
        // Every matching browser receives this global event. Send an
        // invalidation version plus status only; an opened detail asks for
        // transcript bodies through its conditional snapshot RPC.
        const snapshot = read && status?.success === true
            ? buildNativeCodexRealtimeSnapshot(read, status)
            : undefined
        const rawSummary = read?.data.session ?? listSession
        const summary = rawSummary
            ? this.withNativeCodexSshControl(this.maskRunnerOwnedNativeUserInput(rawSummary))
            : null
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
        summary?: CodexLocalSessionSummary | null
    ): CodexLocalSessionStatusRpcResponse {
        const resolvedSummary = summary === undefined ? this.getNativeCodexSessionSummary(sessionId) : summary
        const status = this.nativeCodexSessionDirectSender.getStatus(sessionId, resolvedSummary)
        if (status.success !== true) return status
        const controlledByCodexSsh = Boolean(
            resolvedSummary
            && !isHapiInitiatedCodexSession(resolvedSummary)
            && this.nativeCodexSshOwnership.getCachedHeldSessionIds().has(sessionId)
        )
        const privateDelivery = this.nativeCodexSessionDirectSender.hasPrivateActiveDelivery(sessionId)
        const activeTurnId = status.status === 'processing'
            ? privateDelivery
                ? this.nativeCodexSessionDirectSender.getActiveTurnId(sessionId)
                // A cached plan belongs to a prior observed turn and is not
                // sufficient evidence for an interrupt target. Shared SSH
                // stop stays disabled until the lifecycle tracker has an
                // exact active turn id.
                : this.nativeCodexTurnLifecycle.getActiveTurnId(sessionId) ?? null
            : null
        const controls = this.nativeCodexSessionDirectSender.getControls(sessionId, {
            controlledByCodexSsh,
            activeTurnId
        })
        return {
            ...status,
            ...(activeTurnId ? { activeTurnId } : {}),
            controlledByCodexSsh,
            controls
        }
    }

    private async getNativeCodexModelCatalog(): Promise<CodexModelSummary[]> {
        const now = Date.now()
        if (this.nativeCodexModelCatalog && now - this.nativeCodexModelCatalog.loadedAt < 60_000) {
            return this.nativeCodexModelCatalog.models
        }
        const models = await listCodexModels()
        this.nativeCodexModelCatalog = { loadedAt: now, models }
        return models
    }

    private async validateNativeCodexConfiguration(
        sessionId: string,
        nativeConfiguration: NativeCodexSessionConfiguration
    ): Promise<{ success: true } | { success: false; error: string }> {
        const hasModel = nativeConfiguration.model !== undefined && nativeConfiguration.model !== null
        const hasEffort = nativeConfiguration.modelReasoningEffort !== undefined && nativeConfiguration.modelReasoningEffort !== null
        const hasFast = nativeConfiguration.serviceTier === 'fast'
        if (!hasModel && !hasEffort && !hasFast) return { success: true }

        let models: CodexModelSummary[]
        try {
            models = await this.getNativeCodexModelCatalog()
        } catch {
            return { success: false, error: 'The Codex model catalog is unavailable' }
        }
        const summary = this.getNativeCodexSessionSummary(sessionId)
        const modelId = hasModel
            ? nativeConfiguration.model!
            : summary?.model ?? models.find((model) => model.isDefault)?.id
        const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined
        if (hasModel && !model) {
            return { success: false, error: `Codex model '${nativeConfiguration.model}' is not available` }
        }
        if (hasEffort) {
            const supported = model?.supportedReasoningEfforts
            if (!supported || !supported.some((effort) => effort.toLowerCase() === nativeConfiguration.modelReasoningEffort!.toLowerCase())) {
                return { success: false, error: `Reasoning effort '${nativeConfiguration.modelReasoningEffort}' is not supported by the selected Codex model` }
            }
        }
        if (hasFast) {
            const tiers = model?.serviceTiers?.map((tier) => tier.toLowerCase()) ?? []
            if (!tiers.includes('fast') && !tiers.includes('priority')) {
                return { success: false, error: 'Fast mode is not available for the selected Codex model' }
            }
        }
        return { success: true }
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

    private observeNativeCodexLifecycleEvents(
        sessionId: string,
        events: readonly CodexTranscriptLifecycleEvent[]
    ): boolean {
        const changed = this.nativeCodexTurnLifecycle.observeTranscriptEvents(sessionId, events)
        this.nativeCodexSessionDirectSender.notifyTranscriptLifecycle(sessionId, events)
        return changed
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
            this.localServiceTunnels.attach(localServiceSocketWire(this.socket))
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
            this.startCodexSshOwnershipMonitor()
        })

        this.socket.on('disconnect', () => {
            this.localServiceTunnels.dispose()
            logger.debug('[API MACHINE] Disconnected from bot')
            this.rpcHandlerManager.onSocketDisconnect()
            this.stopKeepAlive()
            this.stopCodexSshOwnershipMonitor()
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

        this.socket.on(
            'native-codex-attachment:stage',
            (data: NativeCodexAttachmentStageRequest, callback: (response: NativeCodexAttachmentStageResponse) => void) => {
                const sessionId = typeof data?.codexSessionId === 'string' ? data.codexSessionId.trim() : ''
                const summary = sessionId ? this.getNativeCodexSessionSummary(sessionId) : null
                if (!summary || isHapiInitiatedCodexSession(summary)) {
                    callback({ success: false, error: 'Only an original native Codex session may receive attachments' })
                    return
                }
                this.cleanupNativeCodexAttachments()
                callback(this.nativeCodexAttachmentStore.stage({ ...data, codexSessionId: sessionId }))
            }
        )

        this.socket.on(
            'native-codex-attachment:delete',
            (data: NativeCodexAttachmentDeleteRequest, callback: (response: NativeCodexAttachmentDeleteResponse) => void) => {
                const sessionId = typeof data?.codexSessionId === 'string' ? data.codexSessionId.trim() : ''
                const summary = sessionId ? this.getNativeCodexSessionSummary(sessionId) : null
                if (!summary || isHapiInitiatedCodexSession(summary)) {
                    callback({ success: false, error: 'Only an original native Codex session may delete attachments' })
                    return
                }
                callback(this.nativeCodexAttachmentStore.delete({ ...data, codexSessionId: sessionId }))
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

    /**
     * The Desktop control endpoint never starts on our behalf: an absent
     * socket is a cheap explicit release. Polling only while the runner is
     * connected makes SSH acquire/release immediately invalidate list/detail
     * views instead of waiting for a transcript write.
     */
    private startCodexSshOwnershipMonitor(): void {
        if (this.codexSshOwnershipMonitor) return
        const refresh = () => {
            void this.refreshNativeCodexSshOwnership({ forceRefresh: true }).catch((error) => {
                logger.debug('[API MACHINE] Failed to refresh Codex SSH ownership', error)
            })
        }
        refresh()
        this.codexSshOwnershipMonitor = setInterval(refresh, CODEX_SSH_OWNERSHIP_MONITOR_INTERVAL_MS)
        this.codexSshOwnershipMonitor.unref?.()
    }

    private stopCodexSshOwnershipMonitor(): void {
        if (!this.codexSshOwnershipMonitor) return
        clearInterval(this.codexSshOwnershipMonitor)
        this.codexSshOwnershipMonitor = null
    }

    private cleanupNativeCodexAttachments(): void {
        this.nativeCodexAttachmentStore.cleanupExpired(
            this.nativeCodexSessionDirectSender.getRetainedNativeAttachmentIds()
        )
    }

    private startNativeCodexAttachmentCleanup(): void {
        if (this.nativeCodexAttachmentCleanupTimer) return
        this.cleanupNativeCodexAttachments()
        this.nativeCodexAttachmentCleanupTimer = setInterval(
            () => this.cleanupNativeCodexAttachments(),
            NATIVE_CODEX_ATTACHMENT_CLEANUP_INTERVAL_MS
        )
        this.nativeCodexAttachmentCleanupTimer.unref?.()
    }

    private stopNativeCodexAttachmentCleanup(): void {
        if (!this.nativeCodexAttachmentCleanupTimer) return
        clearInterval(this.nativeCodexAttachmentCleanupTimer)
        this.nativeCodexAttachmentCleanupTimer = null
    }

    shutdown(): void {
        this.localServiceTunnels.dispose()
        this.stopKeepAlive()
        this.stopCodexSshOwnershipMonitor()
        this.stopNativeCodexAttachmentCleanup()
        this.nativeCodexSessionWatcher.stop()
        this.nativeCodexSessionDirectSender.dispose()
        this.nativeCodexTurnLifecycle.dispose()
        if (this.socket) {
            this.socket.close()
        }
    }
}
