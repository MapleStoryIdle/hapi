import type { OpenLocalServiceRequest, OpenLocalServiceResponse } from '@hapi/protocol/localServices'
import type { NativeCodexSessionControlAction, NativeCodexSessionControlResponse } from '@hapi/protocol/codexSessionControl'
import type { Monitor, MonitorConfig, MonitorDetail, MonitorRequest } from '@hapi/protocol/monitoring'
import type { SessionGroup, SessionGroupInput, SessionGroupSource, SessionGroupsResponse } from '@hapi/protocol/sessionGroups'
import type { SessionLabelSource, SessionLabelsResponse } from '@hapi/protocol/sessionLabels'
import type { SessionPinSource, SessionPinsResponse } from '@hapi/protocol/sessionPins'
import type { KanbanOrder, KanbanOrderInput } from '@hapi/protocol/kanbanOrder'
import type { AttachmentMetadata, AuthResponse, CodexLocalSessionsResponse, CodexLocalSessionContextResponse, CodexLocalSessionComposerCapabilitiesResponse, CodexLocalSessionSnapshotReadResponse, CodexLocalSessionSnapshotVersion, CodexLocalSessionStatusResponse, ArchiveCodexLocalSessionResponse, DiscardCodexLocalSessionMessageResponse, ForkCodexLocalSessionResponse, SendCodexLocalSessionMessageResponse, CodexDuplicateSessionsResponse, CodexMergeDuplicateSessionsResponse, CodexDesktopScriptResponse, CodexDesktopSyncRequest, CodexDesktopStatusResponse, CodexControlRecoveryResponse, CodexCollaborationMode, FileSearchResponse, MachinesResponse, MessagesResponse, OpenVikingContextListResponse, OpenVikingContextReadResponse, OpenVikingStatusResponse, OpenVikingMetricsResponse, OpenVikingQualityResponse, OpenVikingSearchResponse, PermissionMode, PushSubscriptionPayload, PushUnsubscribePayload, PushVapidPublicKeyResponse, DeliverShareFeedbackResponse, RevokeShareResponse, ShareContentResponse, ShareFeedbackResponse, ShareResponse, SharesResponse, SlashCommandsResponse, SkillsResponse, SpawnResponse, VisibilityPayload, HapiSessionExport, SessionResponse, SessionsResponse } from '@/types/api'
import type { CodexSubscriptionLimitsResponse, CodexModelsResponse, CursorMigrateOutcome, CursorMigrateToAcpRequest, CursorModelsResponse, DeleteUploadResponse, FileReadResponse, GitBranchResponse, GitBranchesResponse, GitCommandResponse, ListDirectoryResponse, MachineListDirectoryResponse, MachinePathsExistsResponse, MachineGitBranchCreateRequest, MachineGitBranchCommitRequest, MachineGitBranchFetchRequest, MachineGitBranchPushRequest, MachineGitBranchSwitchRequest, MachineGitBranchUpdateRequest, OpencodeModelsResponse, OpencodeReasoningEffortResponse, CreateSideSessionResponse, ReopenSessionResponse, RenameNativeCodexSessionResponse, UploadFileResponse } from '@hapi/protocol/apiTypes'
import type { AgentFlavor, NativeCodexAttachmentDeleteResponse, NativeCodexAttachmentStageResponse } from '@hapi/protocol'
import type { CancelMessageResponse } from '@hapi/protocol/schemas'

type ApiClientOptions = {
    baseUrl?: string
    getToken?: () => string | null
    onUnauthorized?: () => Promise<string | null>
    requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

type MonitorsResponse = { monitors: Monitor[] }
type MonitorResponse = { monitor: MonitorDetail }
type CreateMonitorResponse = MonitorResponse & { token: string | null }
type RotateMonitorTokenResponse = { token: string }
type MonitorAcceptedResponse = { accepted: true; deferred?: boolean }
type ParseMonitorCurlResponse = { request: MonitorRequest }
type MonitorSessionTargetResponse = { config: MonitorConfig }

type ErrorPayload = {
    error?: unknown
    code?: unknown
}

function parseErrorCode(bodyText: string): string | undefined {
    try {
        const parsed = JSON.parse(bodyText) as ErrorPayload
        if (typeof parsed.code === 'string') return parsed.code
        if (typeof parsed.error === 'string') return parsed.error
        return undefined
    } catch {
        return undefined
    }
}

function parseErrorMessage(bodyText: string): string | undefined {
    try {
        const parsed = JSON.parse(bodyText) as ErrorPayload
        return typeof parsed.error === 'string' ? parsed.error : undefined
    } catch {
        return undefined
    }
}

export class ApiError extends Error {
    status: number
    code?: string
    body?: string

    constructor(message: string, status: number, code?: string, body?: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.body = body
    }
}

export class ApiClient {
    async readWebPage(url: string): Promise<import('@hapi/protocol/webReader').WebReaderResponse> {
        return this.request('/api/web-reader', {
            method: 'POST',
            body: JSON.stringify({ url })
        })
    }
    async openLocalService(request: OpenLocalServiceRequest): Promise<OpenLocalServiceResponse> {
        return await this.request(
            '/api/local-services/open',
            {
                method: 'POST',
                body: JSON.stringify(request)
            },
            0,
            undefined,
            60_000
        )
    }
    private token: string
    private readonly baseUrl: string | null
    private readonly getToken: (() => string | null) | null
    private readonly onUnauthorized: (() => Promise<string | null>) | null
    private readonly requestTimeoutMs: number

    constructor(token: string, options?: ApiClientOptions) {
        this.token = token
        this.baseUrl = options?.baseUrl ?? null
        this.getToken = options?.getToken ?? null
        this.onUnauthorized = options?.onUnauthorized ?? null
        this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    }

    private buildUrl(path: string): string {
        if (!this.baseUrl) {
            return path
        }
        try {
            return new URL(path, this.baseUrl).toString()
        } catch {
            return path
        }
    }

    private async request<T>(path: string, init?: RequestInit, attempt: number = 0, overrideToken?: string | null, timeoutMs: number = this.requestTimeoutMs): Promise<T> {
        const headers = new Headers(init?.headers)
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined ? (overrideToken ?? liveToken ?? this.token) : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const isFormDataBody = typeof FormData !== 'undefined' && init?.body instanceof FormData
        if (init?.body !== undefined && !headers.has('content-type') && !isFormDataBody) {
            headers.set('content-type', 'application/json')
        }

        const controller = new AbortController()
        let timedOut = false
        const timeoutId = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, timeoutMs)
        const callerSignal = init?.signal
        const abortFromCaller = () => controller.abort()
        if (callerSignal) {
            if (callerSignal.aborted) {
                controller.abort()
            } else {
                callerSignal.addEventListener('abort', abortFromCaller, { once: true })
            }
        }

        try {
            const res = await fetch(this.buildUrl(path), {
                ...init,
                headers,
                signal: controller.signal
            })

            if (res.status === 401) {
                if (attempt === 0 && this.onUnauthorized) {
                    const refreshed = await this.onUnauthorized()
                    if (refreshed) {
                        this.token = refreshed
                        const retryResult = await this.request<T>(path, init, attempt + 1, refreshed, timeoutMs)
                        if (timedOut) {
                            throw new ApiError('Request timed out. Please try again.', 408, 'request_timeout')
                        }
                        return retryResult
                    }
                }
                throw new Error('Session expired. Please sign in again.')
            }

            if (!res.ok) {
                const body = await res.text().catch(() => '')
                const code = parseErrorCode(body)
                throw new ApiError(parseErrorMessage(body) ?? 'Request could not be completed.', res.status, code, body || undefined)
            }

            return (await res.json()) as T
        } catch (error) {
            if (timedOut) {
                throw new ApiError('Request timed out. Please try again.', 408, 'request_timeout')
            }
            throw error
        } finally {
            clearTimeout(timeoutId)
            callerSignal?.removeEventListener('abort', abortFromCaller)
        }
    }

    async authenticate(auth: { initData: string } | { accessToken: string }): Promise<AuthResponse> {
        const res = await fetch(this.buildUrl('/api/auth'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Auth failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return (await res.json()) as AuthResponse
    }

    async bind(auth: { initData: string; accessToken: string }): Promise<AuthResponse> {
        const res = await fetch(this.buildUrl('/api/bind'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Bind failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return (await res.json()) as AuthResponse
    }

    async getSessions(): Promise<SessionsResponse> {
        return await this.request<SessionsResponse>('/api/sessions')
    }

    async getPushVapidPublicKey(): Promise<PushVapidPublicKeyResponse> {
        return await this.request<PushVapidPublicKeyResponse>('/api/push/vapid-public-key')
    }

    async getBarkSettings(): Promise<{ configured: boolean; enabled: boolean }> {
        return this.request('/api/push/bark')
    }

    async testBarkPush(): Promise<{ ok: boolean }> {
        return this.request('/api/push/bark/test', { method: 'POST' })
    }

    async saveBarkSettings(url?: string, enabled?: boolean): Promise<{ configured: boolean; enabled: boolean }> {
        return this.request('/api/push/bark', {
            method: 'PUT',
            body: JSON.stringify({ url, enabled })
        })
    }

    async subscribePushNotifications(payload: PushSubscriptionPayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async syncCodexSession(payload?: CodexDesktopSyncRequest): Promise<CodexDesktopScriptResponse> {
        // 中文注释：当前按钮语义已改为“从 Codex 导入到 SHAPI”；这里提交的是本地 transcript 对应的 Codex thread ID 列表。
        return await this.request<CodexDesktopScriptResponse>('/api/codex/sync-session', {
            method: 'POST',
            ...(payload ? { body: JSON.stringify(payload) } : {})
        })
    }

    async getCodexSessions(options?: { limit?: number; machineId?: string; excludeHapiInitiated?: boolean; forceRefresh?: boolean }): Promise<CodexLocalSessionsResponse> {
        const queryParams = new URLSearchParams()
        if (options?.machineId) queryParams.set('machineId', options.machineId)
        if (options?.limit) queryParams.set('limit', String(options.limit))
        if (options?.excludeHapiInitiated) queryParams.set('excludeHapiInitiated', 'true')
        if (options?.forceRefresh) queryParams.set('forceRefresh', 'true')
        const query = queryParams.size > 0 ? `?${queryParams.toString()}` : ''
        return await this.request<CodexLocalSessionsResponse>(`/api/codex/sessions${query}`)
    }

    async getCodexSessionContext(sessionId: string, machineId: string, options: { before?: number; limit?: number } = {}): Promise<CodexLocalSessionContextResponse> {
        const queryParams = new URLSearchParams({ machineId })
        if (options.before !== undefined) queryParams.set('before', String(options.before))
        if (options.limit !== undefined) queryParams.set('limit', String(options.limit))
        return await this.request<CodexLocalSessionContextResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/context?${queryParams.toString()}`)
    }

    async readCodexSessionFile(sessionId: string, machineId: string, path: string): Promise<FileReadResponse> {
        const queryParams = new URLSearchParams({ machineId, path })
        return await this.request<FileReadResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/file?${queryParams.toString()}`)
    }

    async browseCodexSessionFiles(sessionId: string, machineId: string, request: import('@hapi/protocol/apiTypes').SessionFileBrowserRequest): Promise<import('@hapi/protocol/apiTypes').SessionFileBrowserResponse> {
        return this.request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/files?machineId=${encodeURIComponent(machineId)}`, {
            method: 'POST',
            body: JSON.stringify(request)
        })
    }

    async getCodexSessionSnapshot(
        sessionId: string,
        machineId: string,
        options: {
            before?: number
            limit?: number
            knownVersion?: CodexLocalSessionSnapshotVersion
        } = {}
    ): Promise<CodexLocalSessionSnapshotReadResponse> {
        const queryParams = new URLSearchParams({ machineId })
        if (options.before !== undefined) queryParams.set('before', String(options.before))
        if (options.limit !== undefined) queryParams.set('limit', String(options.limit))
        if (options.knownVersion) {
            queryParams.set('knownRunnerEpoch', options.knownVersion.runnerEpoch)
            queryParams.set('knownRevision', String(options.knownVersion.revision))
        }
        return await this.request<CodexLocalSessionSnapshotReadResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/snapshot?${queryParams.toString()}`)
    }

    async getCodexSessionStatus(sessionId: string, machineId: string): Promise<CodexLocalSessionStatusResponse> {
        const queryParams = new URLSearchParams({ machineId })
        return await this.request<CodexLocalSessionStatusResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/status?${queryParams.toString()}`)
    }

    async renameCodexSession(sessionId: string, machineId: string, name: string): Promise<RenameNativeCodexSessionResponse> {
        return await this.request<RenameNativeCodexSessionResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: 'PATCH', body: JSON.stringify({ machineId, name }) }, 0, undefined, 65_000)
    }

    async archiveCodexSession(sessionId: string, payload: { machineId: string }): Promise<ArchiveCodexLocalSessionResponse> {
        return await this.request<ArchiveCodexLocalSessionResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async controlCodexSession(sessionId: string, machineId: string, action: NativeCodexSessionControlAction): Promise<NativeCodexSessionControlResponse> {
        return await this.request<NativeCodexSessionControlResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/control`, { method: 'POST', body: JSON.stringify({ machineId, ...action }) })
    }

    async getCodexSessionComposerCapabilities(sessionId: string, machineId: string): Promise<CodexLocalSessionComposerCapabilitiesResponse> {
        const queryParams = new URLSearchParams({ machineId })
        return await this.request<CodexLocalSessionComposerCapabilitiesResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/composer-capabilities?${queryParams.toString()}`)
    }

    async sendCodexSessionMessage(
        sessionId: string,
        payload: {
            machineId: string
            message: string
            displayMessage?: string
            clientMessageId?: string
            /** Explicit user-confirmed retry after a stale/uncertain native hand-off. */
            forceRecovery?: boolean
            /** Opaque Runner-local attachment references. */
            attachmentIds?: string[]
        },
        options?: { signal?: AbortSignal }
    ): Promise<SendCodexLocalSessionMessageResponse> {
        return await this.request<SendCodexLocalSessionMessageResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify(payload),
            signal: options?.signal
        })
    }

    async discardCodexSessionMessage(
        sessionId: string,
        payload: {
            machineId: string
            clientMessageId: string
        }
    ): Promise<DiscardCodexLocalSessionMessageResponse> {
        return await this.request<DiscardCodexLocalSessionMessageResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/messages/discard`, {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async uploadCodexSessionAttachment(sessionId: string, machineId: string, filename: string, file: Blob, mimeType: string): Promise<NativeCodexAttachmentStageResponse> {
        const form = new FormData()
        form.set('machineId', machineId)
        form.set('file', file, filename)
        form.set('filename', filename)
        form.set('mimeType', mimeType)
        return await this.request<NativeCodexAttachmentStageResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/uploads`, { method: 'POST', body: form }, 0, undefined, UPLOAD_REQUEST_TIMEOUT_MS)
    }

    async deleteCodexSessionAttachment(sessionId: string, machineId: string, attachmentId: string): Promise<NativeCodexAttachmentDeleteResponse> {
        return await this.request<NativeCodexAttachmentDeleteResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(attachmentId)}/delete`, { method: 'POST', body: JSON.stringify({ machineId }) })
    }

    async forkCodexSession(sessionId: string, payload?: { machineId?: string }): Promise<ForkCodexLocalSessionResponse> {
        return await this.request<ForkCodexLocalSessionResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/fork`, {
            method: 'POST',
            body: JSON.stringify(payload ?? {})
        })
    }

    async recoverCodexSessionControl(
        sessionId: string,
        payload: {
            machineId: string
            recoveryRequestId: string
            expectedVersion: CodexLocalSessionSnapshotVersion
        }
    ): Promise<CodexControlRecoveryResponse> {
        return await this.request<CodexControlRecoveryResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/recover-control`, { method: 'POST', body: JSON.stringify(payload) })
    }

    async getCodexSessionControlRecovery(sessionId: string, machineId: string): Promise<CodexControlRecoveryResponse> {
        return await this.request<CodexControlRecoveryResponse>(`/api/codex/sessions/${encodeURIComponent(sessionId)}/recover-control?machineId=${encodeURIComponent(machineId)}`)
    }

    async getCodexDesktopStatus(): Promise<CodexDesktopStatusResponse> {
        return await this.request<CodexDesktopStatusResponse>('/api/codex/status')
    }

    async getCodexDuplicateSessions(payload: CodexDesktopSyncRequest): Promise<CodexDuplicateSessionsResponse> {
        // 中文注释：重复会话检测只传本次用户勾选导入的 codexSessionId，避免把未选中的历史会话也纳入提示。
        return await this.request<CodexDuplicateSessionsResponse>('/api/codex/duplicate-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async mergeCodexDuplicateSessions(payload: CodexDesktopSyncRequest): Promise<CodexMergeDuplicateSessionsResponse> {
        // 中文注释：真正执行合并时沿用同一批选中 codexSessionId，保证检测范围与执行范围一致。
        return await this.request<CodexMergeDuplicateSessionsResponse>('/api/codex/merge-duplicate-sessions', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async restartCodexDesktop(): Promise<CodexDesktopScriptResponse> {
        return await this.request<CodexDesktopScriptResponse>('/api/codex/restart-desktop', {
            method: 'POST'
        })
    }

    async unsubscribePushNotifications(payload: PushUnsubscribePayload): Promise<void> {
        await this.request('/api/push/subscribe', {
            method: 'DELETE',
            body: JSON.stringify(payload)
        })
    }

    async setVisibility(payload: VisibilityPayload): Promise<void> {
        await this.request('/api/visibility', {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async getSession(sessionId: string): Promise<SessionResponse> {
        return await this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    }

    async getSessionExport(sessionId: string, options?: { signal?: AbortSignal }): Promise<HapiSessionExport> {
        return await this.request<HapiSessionExport>(`/api/sessions/${encodeURIComponent(sessionId)}/export`, { signal: options?.signal })
    }

    async getMessages(
        sessionId: string,
        options: {
            beforeSeq?: number | null
            beforeAt?: number | null
            limit?: number
        }
    ): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.beforeAt !== undefined && options.beforeAt !== null) {
            params.set('beforeAt', `${options.beforeAt}`)
        }
        if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }

        const qs = params.toString()
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
        // Message pages are the authoritative reconciliation source after an
        // SSE gap. Never let a browser/service-worker cache satisfy this read.
        return await this.request<MessagesResponse>(url, { cache: 'no-store' })
    }

    async getGitStatus(sessionId: string): Promise<GitCommandResponse> {
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-status`)
    }

    async getGitBranch(sessionId: string): Promise<GitCommandResponse> {
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-branch`)
    }

    async getGitDiffNumstat(sessionId: string, staged: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('staged', staged ? 'true' : 'false')
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`)
    }

    async getGitDiffFile(sessionId: string, path: string, staged?: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (staged !== undefined) {
            params.set('staged', staged ? 'true' : 'false')
        }
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`)
    }

    async searchSessionFiles(sessionId: string, query: string, limit?: number): Promise<FileSearchResponse> {
        const params = new URLSearchParams()
        if (query) {
            params.set('query', query)
        }
        if (limit !== undefined) {
            params.set('limit', `${limit}`)
        }
        const qs = params.toString()
        return await this.request<FileSearchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ''}`)
    }

    async getGeneratedImageBlob(sessionId: string, imageId: string, attempt: number = 0, overrideToken?: string | null): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined ? (overrideToken ?? liveToken ?? this.token) : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const res = await fetch(this.buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/generated-images/${encodeURIComponent(imageId)}`), {
            headers
        })
        if (res.status === 401 && attempt === 0 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                return await this.getGeneratedImageBlob(sessionId, imageId, attempt + 1, refreshed)
            }
        }
        if (!res.ok) {
            throw new ApiError(`HTTP ${res.status}`, res.status, undefined, await res.text().catch(() => undefined))
        }
        return await res.blob()
    }

    async getSessionFileBlob(sessionId: string, path: string, attempt: number = 0, overrideToken?: string | null): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined ? (overrideToken ?? liveToken ?? this.token) : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const params = new URLSearchParams()
        params.set('path', path)
        const res = await fetch(this.buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/file-blob?${params.toString()}`), {
            headers
        })
        if (res.status === 401 && attempt === 0 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                return await this.getSessionFileBlob(sessionId, path, attempt + 1, refreshed)
            }
        }
        if (!res.ok) {
            throw new ApiError(`HTTP ${res.status}`, res.status, undefined, await res.text().catch(() => undefined))
        }
        return await res.blob()
    }

    async getUploadedFileBlob(sessionId: string, path: string, attempt: number = 0, overrideToken?: string | null): Promise<Blob> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined ? (overrideToken ?? liveToken ?? this.token) : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const params = new URLSearchParams()
        params.set('path', path)
        const res = await fetch(this.buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/upload/blob?${params.toString()}`), {
            headers
        })
        if (res.status === 401 && attempt === 0 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                return await this.getUploadedFileBlob(sessionId, path, attempt + 1, refreshed)
            }
        }
        if (!res.ok) {
            throw new ApiError(`HTTP ${res.status}`, res.status, undefined, await res.text().catch(() => undefined))
        }
        return await res.blob()
    }

    async readSessionFile(sessionId: string, path: string): Promise<FileReadResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        return await this.request<FileReadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`)
    }

    async listSessionDirectory(sessionId: string, path?: string): Promise<ListDirectoryResponse> {
        const params = new URLSearchParams()
        if (path) {
            params.set('path', path)
        }

        const qs = params.toString()
        return await this.request<ListDirectoryResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/directory${qs ? `?${qs}` : ''}`)
    }

    async uploadFile(sessionId: string, filename: string, file: Blob, mimeType: string): Promise<UploadFileResponse> {
        const form = new FormData()
        form.set('file', file, filename)
        form.set('filename', filename)
        form.set('mimeType', mimeType)
        return await this.request<UploadFileResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/upload`,
            {
                method: 'POST',
                body: form
            },
            0,
            undefined,
            UPLOAD_REQUEST_TIMEOUT_MS
        )
    }

    async deleteUploadFile(sessionId: string, path: string): Promise<DeleteUploadResponse> {
        return await this.request<DeleteUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload/delete`, {
            method: 'POST',
            body: JSON.stringify({ path })
        })
    }

    async resumeSession(sessionId: string, opts?: { permissionMode?: string }): Promise<string> {
        const response = await this.request<{ sessionId: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
            method: 'POST',
            ...(opts?.permissionMode !== undefined && {
                body: JSON.stringify({ permissionMode: opts.permissionMode })
            })
        })
        return response.sessionId
    }

    async createSideSession(sessionId: string): Promise<CreateSideSessionResponse> {
        return await this.request<CreateSideSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/side-session`, { method: 'POST', body: JSON.stringify({}) })
    }

    async getSessionGroups(): Promise<SessionGroupsResponse> {
        return this.request('/api/session-groups')
    }

    async getKanbanOrder(): Promise<KanbanOrder> {
        return this.request('/api/kanban-order')
    }

    async setKanbanOrder(input: KanbanOrderInput): Promise<KanbanOrder> {
        return this.request('/api/kanban-order', {
            method: 'PUT',
            body: JSON.stringify(input)
        })
    }

    async getSessionPins(): Promise<SessionPinsResponse> {
        return this.request('/api/session-pins')
    }

    async setSessionPin(source: SessionPinSource, pinned: boolean): Promise<SessionPinsResponse> {
        return this.request('/api/session-pins', {
            method: 'PUT',
            body: JSON.stringify({ source, pinned })
        })
    }

    async migrateSessionPins(sources: SessionPinSource[]): Promise<SessionPinsResponse> {
        return this.request('/api/session-pins/migrate', {
            method: 'POST',
            body: JSON.stringify({ sources })
        })
    }

    async createSessionGroup(input: SessionGroupInput): Promise<{ group: SessionGroup }> {
        return this.request('/api/session-groups', {
            method: 'POST',
            body: JSON.stringify(input)
        })
    }

    async updateSessionGroup(id: string, input: SessionGroupInput): Promise<{ group: SessionGroup }> {
        return this.request(`/api/session-groups/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify(input)
        })
    }

    async assignSessionGroup(source: SessionGroupSource, groupId: string | null): Promise<{ ok: true }> {
        return this.request('/api/session-groups/assignment', {
            method: 'PUT',
            body: JSON.stringify({ source, groupId })
        })
    }

    async getSessionLabels(): Promise<SessionLabelsResponse> {
        return this.request('/api/session-labels')
    }

    async setSessionLabel(source: SessionLabelSource, label: string | null): Promise<{ ok: true }> {
        return this.request('/api/session-labels', {
            method: 'PUT',
            body: JSON.stringify({ source, label })
        })
    }

    async getMonitors(): Promise<MonitorsResponse> {
        return await this.request<MonitorsResponse>('/api/monitors')
    }

    async getMonitor(monitorId: string): Promise<MonitorResponse> {
        return await this.request<MonitorResponse>(`/api/monitors/${encodeURIComponent(monitorId)}`)
    }

    async getMonitorSessionTarget(target: { type: 'managed' | 'native-codex'; sessionId: string; machineId?: string }): Promise<MonitorSessionTargetResponse> {
        const query = new URLSearchParams({
            type: target.type,
            sessionId: target.sessionId
        })
        if (target.machineId) query.set('machineId', target.machineId)
        return await this.request<MonitorSessionTargetResponse>(`/api/monitors/session-target?${query.toString()}`)
    }

    async createMonitor(config: MonitorConfig): Promise<CreateMonitorResponse> {
        return await this.request<CreateMonitorResponse>('/api/monitors', {
            method: 'POST',
            body: JSON.stringify(config)
        })
    }

    async updateMonitor(monitorId: string, config: MonitorConfig): Promise<MonitorResponse> {
        return await this.request<MonitorResponse>(`/api/monitors/${encodeURIComponent(monitorId)}`, {
            method: 'PATCH',
            body: JSON.stringify(config)
        })
    }

    async switchMonitorTargetSession(monitorId: string, sessionId: string): Promise<MonitorResponse> {
        return await this.request<MonitorResponse>(`/api/monitors/${encodeURIComponent(monitorId)}/target-session`, {
            method: 'PUT',
            body: JSON.stringify({ sessionId })
        })
    }

    async getMonitorToken(monitorId: string): Promise<{ token: string | null }> {
        return await this.request(`/api/monitors/${encodeURIComponent(monitorId)}/token`)
    }

    async deleteMonitor(monitorId: string): Promise<{ success: boolean }> {
        return await this.request(`/api/monitors/${encodeURIComponent(monitorId)}`, { method: 'DELETE' })
    }

    async rotateMonitorToken(monitorId: string): Promise<RotateMonitorTokenResponse> {
        return await this.request<RotateMonitorTokenResponse>(`/api/monitors/${encodeURIComponent(monitorId)}/token`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async checkMonitor(monitorId: string): Promise<MonitorAcceptedResponse> {
        return await this.request<MonitorAcceptedResponse>(`/api/monitors/${encodeURIComponent(monitorId)}/check`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async retriggerMonitorActivity(monitorId: string, activityId: string): Promise<MonitorAcceptedResponse> {
        return await this.request<MonitorAcceptedResponse>(`/api/monitors/${encodeURIComponent(monitorId)}/activities/${encodeURIComponent(activityId)}/retrigger`, { method: 'POST', body: JSON.stringify({}) })
    }

    async approveMonitorIncident(monitorId: string, incidentId: string, planHash: string): Promise<MonitorAcceptedResponse> {
        return await this.request<MonitorAcceptedResponse>(`/api/monitors/${encodeURIComponent(monitorId)}/incidents/${encodeURIComponent(incidentId)}/approve`, { method: 'POST', body: JSON.stringify({ planHash }) })
    }

    async closeMonitorIncident(monitorId: string, incidentId: string): Promise<MonitorAcceptedResponse> {
        return await this.request<MonitorAcceptedResponse>(`/api/monitors/${encodeURIComponent(monitorId)}/incidents/${encodeURIComponent(incidentId)}/close`, { method: 'POST', body: JSON.stringify({}) })
    }

    async parseMonitorCurl(curl: string): Promise<ParseMonitorCurlResponse> {
        return await this.request<ParseMonitorCurlResponse>('/api/monitors/parse-curl', {
            method: 'POST',
            body: JSON.stringify({ curl })
        })
    }

    async getShares(): Promise<SharesResponse> {
        return await this.request<SharesResponse>('/api/shares')
    }

    async getShare(shareId: string): Promise<ShareResponse> {
        return await this.request<ShareResponse>(`/api/shares/${encodeURIComponent(shareId)}`)
    }

    async revokeShare(shareId: string): Promise<RevokeShareResponse> {
        return await this.request<RevokeShareResponse>(`/api/shares/${encodeURIComponent(shareId)}`, {
            method: 'DELETE'
        })
    }

    async getShareFeedback(shareId: string): Promise<ShareFeedbackResponse> {
        return await this.request<ShareFeedbackResponse>(`/api/shares/${encodeURIComponent(shareId)}/feedback`)
    }

    async getShareContent(shareId: string): Promise<ShareContentResponse> {
        return await this.request<ShareContentResponse>(`/api/shares/${encodeURIComponent(shareId)}/content`)
    }

    async deliverShareFeedback(shareId: string): Promise<DeliverShareFeedbackResponse> {
        return await this.request<DeliverShareFeedbackResponse>(`/api/shares/${encodeURIComponent(shareId)}/feedback/deliver`, {
            method: 'POST'
        })
    }

    async sendMessage(sessionId: string, text: string, localId?: string | null, attachments?: AttachmentMetadata[], scheduledAt?: number | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                text,
                localId: localId ?? undefined,
                attachments: attachments ?? undefined,
                scheduledAt: scheduledAt ?? undefined
            })
        })
    }

    async cancelMessage(sessionId: string, messageId: string): Promise<CancelMessageResponse> {
        const response = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' })
        return response as CancelMessageResponse
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async archiveSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async releaseSessionControl(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/release-control`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async reopenSession(sessionId: string): Promise<ReopenSessionResponse> {
        return await this.request<ReopenSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/reopen`, { method: 'POST', body: JSON.stringify({}) })
    }

    /**
     * Migrate a legacy stream-json Cursor session to ACP. See tiann/hapi#824.
     *
     * Refusals (e.g. running session, missing on-disk store, target collision)
     * are returned as structured `{ok: false, reason, message}` outcomes
     * rather than thrown - the UI surfaces the reason to the operator and the
     * underlying state on disk is unchanged.
     *
     * 401s trigger the same onUnauthorized refresh path as the shared
     * `request()` helper so an expired JWT silently re-auths instead of
     * hard-failing the migration dialog (Codex review #34 P2).
     */
    async migrateCursorSessionToAcp(sessionId: string, body: CursorMigrateToAcpRequest = {}): Promise<CursorMigrateOutcome> {
        const path = `/api/sessions/${encodeURIComponent(sessionId)}/migrate-to-acp`
        const tryOnce = async (overrideToken: string | null): Promise<Response> => {
            const headers = new Headers({ 'content-type': 'application/json' })
            const liveToken = this.getToken ? this.getToken() : null
            const authToken = overrideToken ?? liveToken ?? this.token
            if (authToken) {
                headers.set('authorization', `Bearer ${authToken}`)
            }
            return fetch(this.buildUrl(path), {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            })
        }

        let res = await tryOnce(null)
        if (res.status === 401 && this.onUnauthorized) {
            const refreshed = await this.onUnauthorized()
            if (refreshed) {
                this.token = refreshed
                res = await tryOnce(refreshed)
            }
        }
        if (res.status === 401) {
            throw new Error('Session expired. Please sign in again.')
        }
        const text = await res.text()
        let parsed: CursorMigrateOutcome | null = null
        try {
            parsed = text ? (JSON.parse(text) as CursorMigrateOutcome) : null
        } catch {
            parsed = null
        }
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            return parsed
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`)
    }

    async switchSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/switch`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setCollaborationMode(sessionId: string, mode: CodexCollaborationMode): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/collaboration-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setModel(sessionId: string, model: { provider: string; modelId: string } | string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify({ model })
        })
    }

    async setModelReasoningEffort(sessionId: string, modelReasoningEffort: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model-reasoning-effort`, {
            method: 'POST',
            body: JSON.stringify({ modelReasoningEffort })
        })
    }

    async setEffort(sessionId: string, effort: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/effort`, {
            method: 'POST',
            body: JSON.stringify({ effort })
        })
    }

    async setServiceTier(sessionId: string, serviceTier: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/service-tier`, {
            method: 'POST',
            body: JSON.stringify({ serviceTier })
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        modeOrOptions?:
            | 'default'
            | 'acceptEdits'
            | 'auto'
            | 'bypassPermissions'
            | 'plan'
            | {
                  mode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan'
                  allowTools?: string[]
                  decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
                  answers?: Record<string, string[]> | Record<string, { answers: string[] }>
              }
    ): Promise<void> {
        const body = typeof modeOrOptions === 'string' || modeOrOptions === undefined ? { mode: modeOrOptions } : modeOrOptions
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`, {
            method: 'POST',
            body: JSON.stringify(body)
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        options?: {
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
        }
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`, {
            method: 'POST',
            body: JSON.stringify(options ?? {})
        })
    }

    async getMachines(): Promise<MachinesResponse> {
        return await this.request<MachinesResponse>('/api/machines')
    }

    async getOpenVikingStatus(machineId: string): Promise<OpenVikingStatusResponse> {
        return await this.request<OpenVikingStatusResponse>(`/api/openviking/machines/${encodeURIComponent(machineId)}/status`)
    }

    async getOpenVikingPluginSettings(): Promise<{ enabled: boolean }> {
        return await this.request<{ enabled: boolean }>('/api/plugins/openviking')
    }

    async setOpenVikingPluginEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
        return await this.request<{ enabled: boolean }>('/api/plugins/openviking', {
            method: 'PUT',
            body: JSON.stringify({ enabled })
        })
    }

    async listOpenVikingContext(machineId: string, uri = 'viking://'): Promise<OpenVikingContextListResponse> {
        return await this.request<OpenVikingContextListResponse>(`/api/openviking/machines/${encodeURIComponent(machineId)}/context?uri=${encodeURIComponent(uri)}`)
    }

    async readOpenVikingContext(machineId: string, uri: string): Promise<OpenVikingContextReadResponse> {
        return await this.request<OpenVikingContextReadResponse>(`/api/openviking/machines/${encodeURIComponent(machineId)}/context/read?uri=${encodeURIComponent(uri)}`)
    }

    async getOpenVikingMetrics(machineId: string): Promise<OpenVikingMetricsResponse> {
        return await this.request<OpenVikingMetricsResponse>(`/api/openviking/machines/${encodeURIComponent(machineId)}/metrics`)
    }

    async searchOpenViking(machineId: string, query: string, limit = 8): Promise<OpenVikingSearchResponse> {
        return await this.request<OpenVikingSearchResponse>(`/api/openviking/machines/${encodeURIComponent(machineId)}/search`, { method: 'POST', body: JSON.stringify({ query, limit }) })
    }

    async getOpenVikingQuality(machineId: string): Promise<OpenVikingQualityResponse> {
        return await this.request<OpenVikingQualityResponse>(`/api/openviking/machines/${encodeURIComponent(machineId)}/quality`, { method: 'POST' })
    }

    async listMachineDirectory(machineId: string, path: string): Promise<MachineListDirectoryResponse> {
        return await this.request<MachineListDirectoryResponse>(`/api/machines/${encodeURIComponent(machineId)}/list-directory`, {
            method: 'POST',
            body: JSON.stringify({ path })
        })
    }

    async checkMachinePathsExists(machineId: string, paths: string[]): Promise<MachinePathsExistsResponse> {
        return await this.request<MachinePathsExistsResponse>(`/api/machines/${encodeURIComponent(machineId)}/paths/exists`, {
            method: 'POST',
            body: JSON.stringify({ paths })
        })
    }

    async spawnSession(machineId: string, directory: string, agent?: AgentFlavor, model?: string, modelReasoningEffort?: string, yolo?: boolean, sessionType?: 'simple' | 'worktree', worktreeName?: string, effort?: string): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({
                directory,
                agent,
                model,
                modelReasoningEffort,
                yolo,
                sessionType,
                worktreeName,
                effort
            })
        })
    }

    async getMachineCodexModels(machineId: string): Promise<CodexModelsResponse> {
        return await this.request<CodexModelsResponse>(`/api/machines/${encodeURIComponent(machineId)}/codex-models`)
    }

    async getMachineCodexSubscriptionLimits(machineId: string, model?: string | null, cwd?: string | null, provider?: string | null): Promise<CodexSubscriptionLimitsResponse> {
        const normalizedModel = model?.trim()
        const params = new URLSearchParams()
        if (normalizedModel) params.set('model', normalizedModel)
        if (cwd) params.set('cwd', cwd)
        if (provider) params.set('provider', provider)
        const query = params.size ? `?${params}` : ''
        return await this.request<CodexSubscriptionLimitsResponse>(`/api/machines/${encodeURIComponent(machineId)}/codex-subscription-limits${query}`)
    }

    async getSessionCodexModels(sessionId: string): Promise<CodexModelsResponse> {
        return await this.request<CodexModelsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/codex-models`)
    }

    async getSessionCodexSubscriptionLimits(sessionId: string): Promise<CodexSubscriptionLimitsResponse> {
        return await this.request<CodexSubscriptionLimitsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/codex-subscription-limits`)
    }

    async getSessionOpencodeModels(sessionId: string): Promise<OpencodeModelsResponse> {
        return await this.request<OpencodeModelsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/opencode-models`)
    }

    async getSessionOpencodeReasoningEffortOptions(sessionId: string): Promise<OpencodeReasoningEffortResponse> {
        return await this.request<OpencodeReasoningEffortResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/opencode-reasoning-effort-options`)
    }

    async getSessionCursorModels(sessionId: string): Promise<CursorModelsResponse> {
        return await this.request<CursorModelsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/cursor-models`)
    }

    /** Generic Pi session endpoint — replaces per-method wrappers. */
    async callPiEndpoint<T = unknown>(sessionId: string, path: string, init?: RequestInit): Promise<T> {
        return await this.request<T>(`/api/sessions/${encodeURIComponent(sessionId)}/pi-${path}`, init)
    }

    async getMachineCursorModels(machineId: string): Promise<CursorModelsResponse> {
        return await this.request<CursorModelsResponse>(`/api/machines/${encodeURIComponent(machineId)}/cursor-models`)
    }

    async getMachineOpencodeModelsForCwd(machineId: string, cwd: string): Promise<OpencodeModelsResponse> {
        return await this.request<OpencodeModelsResponse>(`/api/machines/${encodeURIComponent(machineId)}/opencode-models?cwd=${encodeURIComponent(cwd)}`)
    }

    async getMachineGitBranch(machineId: string, cwd: string): Promise<GitBranchResponse> {
        return await this.request<GitBranchResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branch?cwd=${encodeURIComponent(cwd)}`)
    }

    async getMachineGitBranches(machineId: string, cwd: string): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches?cwd=${encodeURIComponent(cwd)}`)
    }

    async switchMachineGitBranch(machineId: string, request: MachineGitBranchSwitchRequest): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches/switch`, { method: 'POST', body: JSON.stringify(request) })
    }

    async createMachineGitBranch(machineId: string, request: MachineGitBranchCreateRequest): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches`, { method: 'POST', body: JSON.stringify(request) })
    }

    async commitMachineGitChanges(machineId: string, request: MachineGitBranchCommitRequest): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches/commit`, { method: 'POST', body: JSON.stringify(request) }, 0, undefined, 75_000)
    }

    async pushMachineGitBranch(machineId: string, request: MachineGitBranchPushRequest): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches/push`, { method: 'POST', body: JSON.stringify(request) }, 0, undefined, 75_000)
    }

    async fetchMachineGitBranches(machineId: string, request: MachineGitBranchFetchRequest): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches/fetch`, { method: 'POST', body: JSON.stringify(request) }, 0, undefined, 75_000)
    }

    async updateMachineGitBranch(machineId: string, request: MachineGitBranchUpdateRequest): Promise<GitBranchesResponse> {
        return await this.request<GitBranchesResponse>(`/api/machines/${encodeURIComponent(machineId)}/git-branches/update`, { method: 'POST', body: JSON.stringify(request) }, 0, undefined, 75_000)
    }

    async getSlashCommands(sessionId: string): Promise<SlashCommandsResponse> {
        return await this.request<SlashCommandsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`)
    }

    async getSkills(sessionId: string): Promise<SkillsResponse> {
        return await this.request<SkillsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/skills`)
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ name })
        })
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE'
        })
    }

    async fetchVoiceToken(options?: { customAgentId?: string; customApiKey?: string; voiceId?: string }): Promise<{
        allowed: boolean
        token?: string
        agentId?: string
        error?: string
    }> {
        return await this.request('/api/voice/token', {
            method: 'POST',
            body: JSON.stringify(options || {})
        })
    }

    async fetchVoices(): Promise<{
        voices: Array<{
            id: string
            name: string
            previewUrl: string
            category: string
        }>
    }> {
        return await this.request('/api/voice/voices')
    }

    async sendVoiceTelemetry(event: { stage: string; message: string; sessionId?: string; voiceId?: string; language?: string; details?: Record<string, unknown> }): Promise<void> {
        await this.request('/api/voice/telemetry', {
            method: 'POST',
            body: JSON.stringify(event)
        })
    }

    /** Return the current auth token (for WebSocket query-param auth). */
    getAuthToken(): string | null {
        return this.getToken ? this.getToken() : this.token
    }

    async fetchVoiceBackend(): Promise<{ backend: string; backends: string[] }> {
        return await this.request('/api/voice/backend')
    }

    async fetchQwenToken(): Promise<{
        allowed: boolean
        wsUrl?: string
        error?: string
    }> {
        return await this.request('/api/voice/qwen-token', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async fetchGeminiToken(): Promise<{
        allowed: boolean
        apiKey?: string
        wsUrl?: string
        baseUrl?: string
        error?: string
    }> {
        return await this.request('/api/voice/gemini-token', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }
}
