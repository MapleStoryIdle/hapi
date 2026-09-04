import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ioMock = vi.hoisted(() => vi.fn())
const listOpencodeModelsForCwdMock = vi.hoisted(() => vi.fn())

vi.mock('socket.io-client', () => ({
    io: ioMock
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

vi.mock('../modules/common/opencodeModels', () => ({
    listOpencodeModelsForCwd: listOpencodeModelsForCwdMock
}))

import { ApiMachineClient } from './apiMachine'
import type { Machine, MachineMetadata } from './types'

function makeMachine(id: string): Machine {
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        runnerState: null,
        runnerStateVersion: 0
    }
}

async function callListOpencodeModels(client: ApiMachineClient, machineId: string, cwd: string): Promise<unknown> {
    // Reach into the private rpc handler manager to dispatch a request.
    // Mirrors how the on-socket 'rpc-request' listener invokes handleRequest.
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:listOpencodeModelsForCwd`,
        params: JSON.stringify({ cwd })
    })
    return JSON.parse(raw) as unknown
}

async function callMachineRpc(client: ApiMachineClient, machineId: string, method: string, params: unknown): Promise<unknown> {
    const manager = (client as unknown as { rpcHandlerManager: { handleRequest: (req: { method: string; params: string }) => Promise<string> } }).rpcHandlerManager
    const raw = await manager.handleRequest({
        method: `${machineId}:${method}`,
        params: JSON.stringify(params)
    })
    return JSON.parse(raw) as unknown
}

describe('ApiMachineClient listOpencodeModelsForCwd handler', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        listOpencodeModelsForCwdMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('allows model discovery in a cwd outside the optional browser roots', async () => {
        const machine = makeMachine('machine-1')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const outsideCwd = mkdtempSync(join(tmpdir(), 'hapi-outside-'))
        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [],
            currentModelId: null
        })
        try {
            const result = await callListOpencodeModels(client, machine.id, outsideCwd)
            expect(result).toEqual({
                success: true,
                availableModels: [],
                currentModelId: null
            })
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(realpathSync(outsideCwd))
        } finally {
            rmSync(outsideCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })

    it('rejects empty cwd with cwd-required error', async () => {
        const machine = makeMachine('machine-2')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        try {
            const result = await callListOpencodeModels(client, machine.id, '')
            expect(result).toEqual({ success: false, error: 'cwd is required' })
            expect(listOpencodeModelsForCwdMock).not.toHaveBeenCalled()
        } finally {
            client.shutdown()
        }
    })

    it('forwards a workspace-internal cwd to listOpencodeModelsForCwd', async () => {
        const machine = makeMachine('machine-3')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])

        const innerDir = join(workspaceRoot, 'inner-project')
        mkdirSync(innerDir)

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'a/b' }],
            currentModelId: 'a/b'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, innerDir)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'a/b' }],
                currentModelId: 'a/b'
            })
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledTimes(1)
            // The handler should pass the resolved (realpath'd) cwd to the lower layer.
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(expect.stringContaining('inner-project'))
        } finally {
            client.shutdown()
        }
    })

    it('accepts cwd inside any configured workspace root', async () => {
        const machine = makeMachine('machine-4')
        const secondWorkspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-2-'))
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot, secondWorkspaceRoot])

        listOpencodeModelsForCwdMock.mockResolvedValueOnce({
            success: true,
            availableModels: [{ modelId: 'x/y' }],
            currentModelId: 'x/y'
        })

        try {
            const result = await callListOpencodeModels(client, machine.id, secondWorkspaceRoot)
            expect(result).toEqual({
                success: true,
                availableModels: [{ modelId: 'x/y' }],
                currentModelId: 'x/y'
            })
            // The handler realpaths the cwd (security: prevents symlink escape),
            // so on macOS /var/folders/... resolves to /private/var/folders/...
            expect(listOpencodeModelsForCwdMock).toHaveBeenCalledWith(realpathSync(secondWorkspaceRoot))
        } finally {
            rmSync(secondWorkspaceRoot, { recursive: true, force: true })
            client.shutdown()
        }
    })
})

describe('ApiMachineClient native file handler', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-ws-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('reads only files contained by the native Codex working directory', async () => {
        const machine = makeMachine('machine-native-file')
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])
        const nativeCwd = mkdtempSync(join(tmpdir(), 'hapi-native-codex-file-'))
        const sourceDir = join(nativeCwd, 'src')
        mkdirSync(sourceDir)
        writeFileSync(join(sourceDir, 'example.ts'), 'export const native = true\n')

        try {
            const result = await callMachineRpc(client, machine.id, 'readMachineFile', {
                cwd: nativeCwd,
                path: 'src/example.ts'
            }) as { success: boolean; content?: string }
            expect(result).toEqual({
                success: true,
                content: Buffer.from('export const native = true\n').toString('base64')
            })

            const traversal = await callMachineRpc(client, machine.id, 'readMachineFile', {
                cwd: nativeCwd,
                path: '../outside.ts'
            }) as { success: boolean; error?: string }
            expect(traversal.success).toBe(false)
            expect(traversal.error).toContain('outside the working directory')
        } finally {
            rmSync(nativeCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })

    it('serves runner-owned file bytes for historical HAPI sessions', async () => {
        const machine = makeMachine('machine-native-file-bytes')
        const nativeCwd = mkdtempSync(join(tmpdir(), 'hapi-native-codex-file-bytes-'))
        const sourceDir = join(nativeCwd, 'src')
        mkdirSync(sourceDir)
        writeFileSync(join(sourceDir, 'example.ts'), 'export const bytes = true\n')
        const listeners = new Map<string, (...args: unknown[]) => void>()
        const socket = {
            on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
                listeners.set(event, listener)
            }),
            emit: vi.fn(),
            close: vi.fn()
        }
        ioMock.mockReturnValue(socket)
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])
        client.connect()

        try {
            const listener = listeners.get('file:read-bytes')
            expect(listener).toBeDefined()
            const response = await new Promise<unknown>((resolve) => {
                listener?.({ type: 'machine-file', cwd: nativeCwd, path: 'src/example.ts' }, resolve)
            }) as { success: boolean; bytes?: Uint8Array; fileName?: string; mimeType?: string | null }

            expect(response.success).toBe(true)
            expect(response.fileName).toBe('example.ts')
            expect(response.mimeType).toBeNull()
            expect(response.bytes).toEqual(Buffer.from('export const bytes = true\n'))
        } finally {
            rmSync(nativeCwd, { recursive: true, force: true })
            client.shutdown()
        }
    })
})

describe('ApiMachineClient session spawning', () => {
    let workspaceRoot: string

    beforeEach(() => {
        ioMock.mockReset()
        workspaceRoot = mkdtempSync(join(tmpdir(), 'hapi-machine-spawn-root-'))
    })

    afterEach(() => {
        rmSync(workspaceRoot, { recursive: true, force: true })
    })

    it('allows an explicitly requested directory outside the browser roots', async () => {
        const machine = makeMachine('machine-spawn')
        const outsideDirectory = mkdtempSync(join(tmpdir(), 'hapi-machine-spawn-outside-'))
        const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'spawned-session' }))
        const client = new ApiMachineClient('cli-token', machine, [workspaceRoot])
        client.setRPCHandlers({
            spawnSession,
            stopSession: () => true,
            requestShutdown: () => {}
        })

        try {
            const result = await callMachineRpc(client, machine.id, 'spawn-happy-session', {
                directory: outsideDirectory,
                agent: 'claude'
            })
            expect(result).toEqual({ type: 'success', sessionId: 'spawned-session' })
            expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ directory: outsideDirectory }))
        } finally {
            rmSync(outsideDirectory, { recursive: true, force: true })
            client.shutdown()
        }
    })
})

describe('ApiMachineClient Codex local transcript handlers', () => {
    const originalCodexHome = process.env.CODEX_HOME
    let codexHome: string

    beforeEach(() => {
        codexHome = mkdtempSync(join(tmpdir(), 'hapi-machine-codex-home-'))
        process.env.CODEX_HOME = codexHome
    })

    afterEach(() => {
        rmSync(codexHome, { recursive: true, force: true })
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = originalCodexHome
    })

    it('reads summaries and context from the runner-local CODEX_HOME', async () => {
        const machine = makeMachine('machine-codex')
        const sessionId = '12345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '13')
        mkdirSync(transcriptDir, { recursive: true })
        const transcript = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(transcript, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer instruction that must stay hidden' }] } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>Injected context</INSTRUCTIONS>' }] } }),
            JSON.stringify({ timestamp: '2026-08-13T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'runner-local prompt' }] } }),
            JSON.stringify({ timestamp: '2026-08-13T10:00:00.001Z', type: 'event_msg', payload: { type: 'user_message', message: 'runner-local prompt' } }),
            JSON.stringify({ timestamp: '2026-08-13T10:00:01.001Z', type: 'event_msg', payload: { type: 'agent_message', message: 'runner-local answer' } }),
            JSON.stringify({ timestamp: '2026-08-13T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'runner-local answer' }] } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'))
        const client = new ApiMachineClient('cli-token', machine)

        try {
            const listed = await callMachineRpc(client, machine.id, 'listCodexLocalSessions', { limit: 5 }) as { success: boolean; sessions?: Array<{ id: string; runState?: string }> }
            expect(listed).toMatchObject({ success: true, sessions: [{ id: sessionId, runState: 'idle' }] })

            const hapiSessionId = '87654321-4321-4321-8321-210987654321'
            writeFileSync(join(transcriptDir, `rollout-${hapiSessionId}.jsonl`), JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: hapiSessionId,
                    cwd: '/workspace/project',
                    originator: 'hapi-codex-client'
                }
            }))
            const externalOnly = await callMachineRpc(client, machine.id, 'listCodexLocalSessions', {
                limit: 5,
                excludeHapiInitiated: true
            }) as { success: boolean; sessions?: Array<{ id: string }> }
            expect(externalOnly).toMatchObject({ success: true, sessions: [{ id: sessionId }] })
            expect(externalOnly.sessions?.map((session) => session.id)).not.toContain(hapiSessionId)

            const read = await callMachineRpc(client, machine.id, 'readCodexLocalSession', { sessionId }) as {
                success: boolean
                data?: { context: unknown[]; importedMessages: unknown[] }
            }
            expect(read.success).toBe(true)
            expect(read.data?.context).toEqual([
                { role: 'user', text: 'runner-local prompt' },
                { role: 'assistant', text: 'runner-local answer' }
            ])
            expect(read.data?.importedMessages).toHaveLength(2)
        } finally {
            client.shutdown()
        }
    })

    it('emits explicit SSH ownership acquire and release summaries', async () => {
        const machine = makeMachine('machine-codex-ssh-ownership')
        const sessionId = '18345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '13')
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(join(transcriptDir, `rollout-${sessionId}.jsonl`), [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'))

        let cachedHeld = new Set<string>()
        let nextHeld = new Set<string>([sessionId])
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        const internals = client as unknown as {
            socket: { emit: typeof emit; close: () => void }
            nativeCodexSshOwnership: {
                getCachedHeldSessionIds: () => ReadonlySet<string>
                getHeldSessionIds: (options?: { forceRefresh?: boolean }) => Promise<ReadonlySet<string>>
            }
            refreshNativeCodexSshOwnership: (options?: { forceRefresh?: boolean }) => Promise<ReadonlySet<string>>
        }
        internals.socket = { emit, close: () => {} }
        internals.nativeCodexSshOwnership = {
            getCachedHeldSessionIds: () => new Set(cachedHeld),
            getHeldSessionIds: async () => {
                cachedHeld = new Set(nextHeld)
                return new Set(cachedHeld)
            }
        }

        try {
            await internals.refreshNativeCodexSshOwnership({ forceRefresh: true })
            nextHeld = new Set()
            await internals.refreshNativeCodexSshOwnership({ forceRefresh: true })

            const updates = emit.mock.calls
                .filter(([event]) => event === 'codex-session-updated')
                .map(([, payload]) => payload)
            expect(updates).toHaveLength(2)
            expect(updates[0]).toEqual(expect.objectContaining({
                machineId: machine.id,
                codexSessionId: sessionId,
                summary: expect.objectContaining({ controlledByCodexSsh: true })
            }))
            expect(updates[1]).toEqual(expect.objectContaining({
                machineId: machine.id,
                codexSessionId: sessionId,
                summary: expect.objectContaining({ controlledByCodexSsh: false })
            }))
        } finally {
            client.shutdown()
        }
    })

    it('returns one cached native snapshot for context and lifecycle state', async () => {
        const machine = makeMachine('machine-codex-snapshot')
        const sessionId = '22345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const transcript = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(transcript, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ timestamp: '2026-08-28T10:00:00.000Z', type: 'response_item', payload: {
                type: 'message', role: 'user', content: [{ type: 'input_text', text: 'cached prompt' }]
            } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'), 'utf8')
        const client = new ApiMachineClient('cli-token', machine)
        let displayTitle = 'Original native title'
        ;(client as unknown as {
            nativeCodexSessionTitleCache: {
                resolve: (sessionIds: readonly string[]) => ReadonlyMap<string, string>
            }
        }).nativeCodexSessionTitleCache.resolve = () => new Map([[sessionId, displayTitle]])

        try {
            const first = await callMachineRpc(client, machine.id, 'readCodexLocalSessionSnapshot', { sessionId, limit: 50 }) as {
                success: boolean
                unchanged?: boolean
                snapshot?: {
                    revision: number
                    version: { runnerEpoch: string; revision: number }
                    timing: { cache: string }
                    status: { status: string }
                    data: { session: { title: string }; importedMessages: unknown[] }
                }
            }
            expect(first).toMatchObject({
                success: true,
                unchanged: false,
                snapshot: {
                    revision: 1,
                    version: { revision: 1 },
                    timing: { cache: 'miss' },
                    status: { status: 'idle' },
                    data: {
                        session: { title: 'Original native title' },
                        importedMessages: [{ role: 'user' }]
                    }
                }
            })

            const warm = await callMachineRpc(client, machine.id, 'readCodexLocalSessionSnapshot', { sessionId, limit: 50 }) as {
                success: boolean
                unchanged?: boolean
                snapshot?: { revision: number; timing: { cache: string } }
            }
            expect(warm).toMatchObject({
                success: true,
                unchanged: false,
                snapshot: { revision: first.snapshot?.revision, timing: { cache: 'hit' } }
            })

            displayTitle = 'Renamed without transcript change'
            const unchanged = await callMachineRpc(client, machine.id, 'readCodexLocalSessionSnapshot', {
                sessionId,
                limit: 50,
                knownVersion: first.snapshot?.version
            }) as {
                success: boolean
                unchanged?: boolean
                version?: { runnerEpoch: string; revision: number }
                revision?: number
                session?: { title: string }
                status?: { status: string }
                timing?: { cache: string }
                snapshot?: unknown
            }
            expect(unchanged).toMatchObject({
                success: true,
                unchanged: true,
                version: first.snapshot?.version,
                revision: first.snapshot?.revision,
                session: { title: 'Renamed without transcript change' },
                status: { status: 'idle' },
                timing: { cache: 'hit' }
            })
            expect(unchanged.snapshot).toBeUndefined()

            const differentPage = await callMachineRpc(client, machine.id, 'readCodexLocalSessionSnapshot', {
                sessionId,
                limit: 1,
                knownVersion: first.snapshot?.version
            }) as {
                success: boolean
                unchanged?: boolean
                snapshot?: { data: { page: { limit: number } } }
            }
            expect(differentPage).toMatchObject({
                success: true,
                unchanged: false,
                snapshot: { data: { page: { limit: 1 } } }
            })

            const emit = vi.fn()
            ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
                emit,
                close: () => {}
            }
            ;(client as unknown as {
                nativeCodexSessionDirectSender: {
                    getStatus: () => {
                        success: true
                        status: 'processing'
                        queuedMessages: Array<{
                            id: string
                            text: string
                            queuedAt: number
                            recoveryRequired?: boolean
                            recoveryReason?: 'codex_timeout'
                        }>
                    }
                }
            }).nativeCodexSessionDirectSender.getStatus = () => ({
                success: true,
                status: 'processing',
                queuedMessages: [{
                    id: 'queued-1',
                    text: 'This text must never enter global SSE',
                    queuedAt: 42,
                    recoveryRequired: true,
                    recoveryReason: 'codex_timeout'
                }]
            })
            const report = (client as unknown as {
                reportNativeCodexSessionUpdated: (id: string, modifiedAt?: number) => boolean
            }).reportNativeCodexSessionUpdated.bind(client)
            expect(report(sessionId, 1)).toBe(true)
            const update = emit.mock.calls[0]?.[1] as { snapshot?: Record<string, unknown> } | undefined
            expect(update?.snapshot).toMatchObject({
                version: first.snapshot?.version,
                revision: first.snapshot?.revision,
                status: {
                    status: 'processing',
                    queuedMessageRefs: [{
                        id: 'queued-1',
                        recoveryRequired: true,
                        recoveryReason: 'codex_timeout'
                    }]
                },
                timing: { cache: 'hit' }
            })
            expect(update?.snapshot).not.toHaveProperty('importedMessages')
            expect(update?.snapshot).not.toHaveProperty('session')
            expect(update?.snapshot?.status).not.toHaveProperty('queuedMessages')
        } finally {
            client.shutdown()
        }
    })

    it('keeps native plan steps in the full snapshot and sends only the active turn through realtime', async () => {
        const machine = makeMachine('machine-codex-plan-snapshot')
        const sessionId = '32345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(join(transcriptDir, `rollout-${sessionId}.jsonl`), [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-plan' } }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'update_plan',
                    call_id: 'call-plan',
                    arguments: JSON.stringify({
                        plan: [{ step: 'Show the native plan', status: 'in_progress' }]
                    })
                }
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'function_call_output',
                    call_id: 'call-plan',
                    output: 'Plan updated'
                }
            })
        ].join('\n'), 'utf8')
        const client = new ApiMachineClient('cli-token', machine)

        try {
            const snapshot = await callMachineRpc(client, machine.id, 'readCodexLocalSessionSnapshot', {
                sessionId,
                limit: 1
            }) as {
                success: boolean
                unchanged?: boolean
                snapshot?: {
                    plan?: unknown
                    status: { status: string; activeTurnId?: string }
                }
            }
            expect(snapshot).toMatchObject({
                success: true,
                unchanged: false,
                snapshot: {
                    status: { status: 'processing', activeTurnId: 'turn-plan' },
                    plan: {
                        turnId: 'turn-plan',
                        callId: 'call-plan',
                        steps: [{ text: 'Show the native plan', status: 'in_progress' }]
                    }
                }
            })

            const emit = vi.fn()
            ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
                emit,
                close: () => {}
            }
            const report = (client as unknown as {
                reportNativeCodexSessionUpdated: (id: string, modifiedAt?: number) => boolean
            }).reportNativeCodexSessionUpdated.bind(client)
            expect(report(sessionId, 1)).toBe(true)
            const update = emit.mock.calls[0]?.[1] as { snapshot?: Record<string, unknown> } | undefined
            expect(update?.snapshot).toMatchObject({
                status: { status: 'processing', activeTurnId: 'turn-plan' }
            })
            expect(update?.snapshot).not.toHaveProperty('plan')
            expect(update?.snapshot?.status).not.toHaveProperty('steps')
        } finally {
            client.shutdown()
        }
    })

    it('overlays a UserPromptSubmit start across native list, detail, snapshot, and status before emitting', async () => {
        const machine = makeMachine('machine-codex-hook-lifecycle')
        const sessionId = '92345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        const transcript = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(transcript, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'old-turn' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old-turn' } })
        ].join('\n'), 'utf8')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        const observedAt = Date.now()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = { emit, close: () => {} }

        try {
            expect(client.observeExternalCodexLifecycle({
                codexSessionId: sessionId,
                turnId: 'turn-a',
                event: 'turn_started',
                observedAt
            })).toBe(true)

            const listed = await callMachineRpc(client, machine.id, 'listCodexLocalSessions', { limit: 5 }) as {
                success: boolean
                sessions?: Array<{ runState?: string }>
            }
            const detail = await callMachineRpc(client, machine.id, 'readCodexLocalSession', { sessionId }) as {
                success: boolean
                data?: { session: { runState?: string } }
            }
            const snapshot = await callMachineRpc(client, machine.id, 'readCodexLocalSessionSnapshot', { sessionId }) as {
                success: boolean
                snapshot?: { data: { session: { runState?: string } }; status: { status: string } }
            }
            const status = await callMachineRpc(client, machine.id, 'getCodexLocalSessionStatus', { sessionId }) as {
                success: boolean
                status?: string
            }

            expect(listed.sessions?.[0]?.runState).toBe('processing')
            expect(detail.data?.session.runState).toBe('processing')
            expect(snapshot.snapshot?.data.session.runState).toBe('processing')
            expect(snapshot.snapshot?.status.status).toBe('processing')
            expect(status.status).toBe('processing')
            expect(emit).toHaveBeenCalledWith('codex-session-updated', expect.objectContaining({
                codexSessionId: sessionId,
                summary: expect.objectContaining({ runState: 'processing' })
            }))

            const emissions = emit.mock.calls.length
            expect(client.observeExternalCodexLifecycle({
                codexSessionId: sessionId,
                turnId: 'turn-a',
                event: 'turn_started',
                observedAt: observedAt + 100
            })).toBe(false)
            expect(emit).toHaveBeenCalledTimes(emissions)

            appendFileSync(transcript, [
                '',
                JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-a' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-a' } })
            ].join('\n'), 'utf8')
            const readNative = (client as unknown as {
                readNativeCodexTranscript: (id: string, options: { limit: number }) => { data: { session: { runState?: string } } } | null
            }).readNativeCodexTranscript.bind(client)
            expect(readNative(sessionId, { limit: 1 })?.data.session.runState).toBe('idle')
            expect((await callMachineRpc(client, machine.id, 'getCodexLocalSessionStatus', { sessionId }) as {
                success: boolean
                status?: string
            }).status).toBe('idle')
        } finally {
            client.shutdown()
        }
    })

    it('keeps an unobserved watcher update lightweight', () => {
        const machine = makeMachine('machine-codex-lightweight-update')
        const sessionId = '32345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(join(transcriptDir, `rollout-${sessionId}.jsonl`), JSON.stringify({
            type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' }
        }), 'utf8')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        const internals = client as unknown as {
            socket: { emit: typeof emit; close: () => void }
            nativeCodexTranscriptCache: { has: (id: string) => boolean }
            reportNativeCodexSessionUpdated: (id: string, modifiedAt: number) => boolean
        }
        internals.socket = { emit, close: () => {} }

        try {
            expect(internals.nativeCodexTranscriptCache.has(sessionId)).toBe(false)
            expect(internals.reportNativeCodexSessionUpdated(sessionId, 42)).toBe(true)
            // Recent-window watcher events must not scan and cache every
            // transcript just to produce status for a page nobody opened.
            expect(internals.nativeCodexTranscriptCache.has(sessionId)).toBe(false)
            expect(emit).toHaveBeenCalledWith('codex-session-updated', {
                machineId: machine.id,
                codexSessionId: sessionId,
                modifiedAt: 42
            })
        } finally {
            client.shutdown()
        }
    })

    it('archives an idle native thread through Codex, evicts caches, and emits an invalidation', async () => {
        const machine = makeMachine('machine-codex-archive')
        const sessionId = '42345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        const transcript = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(transcript, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: codexHome } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'), 'utf8')
        const connect = vi.fn(async () => {})
        const initialize = vi.fn(async () => ({}))
        const archiveThread = vi.fn(async () => {
            rmSync(transcript)
            return {}
        })
        const disconnect = vi.fn(async () => {})
        const client = new ApiMachineClient('cli-token', machine, undefined, undefined, () => ({
            connect,
            initialize,
            archiveThread,
            disconnect
        }))
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = { emit, close: () => {} }

        try {
            const result = await callMachineRpc(client, machine.id, 'archiveCodexLocalSession', { sessionId })
            expect(result).toEqual({ success: true })
            expect(connect).toHaveBeenCalledTimes(1)
            expect(initialize).toHaveBeenCalledWith(expect.objectContaining({
                clientInfo: expect.objectContaining({ name: 'hapi-native-session-archive' })
            }))
            expect(archiveThread).toHaveBeenCalledWith({ threadId: sessionId })
            expect(disconnect).toHaveBeenCalledTimes(1)
            expect(emit).toHaveBeenCalledWith('codex-session-updated', expect.objectContaining({
                machineId: machine.id,
                codexSessionId: sessionId
            }))
            expect(await callMachineRpc(client, machine.id, 'listCodexLocalSessions', { limit: 5 })).toEqual({
                success: true,
                sessions: []
            })
        } finally {
            client.shutdown()
        }
    })

    it('reports an unsupported native archive without clearing its transcript', async () => {
        const machine = makeMachine('machine-codex-archive-unsupported')
        const sessionId = '52345678-1234-4234-8234-123456789012'
        const transcriptDir = join(codexHome, 'sessions', '2026', '08', '28')
        const transcript = join(transcriptDir, `rollout-${sessionId}.jsonl`)
        mkdirSync(transcriptDir, { recursive: true })
        writeFileSync(transcript, [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: codexHome } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
        ].join('\n'), 'utf8')
        const disconnect = vi.fn(async () => {})
        const client = new ApiMachineClient('cli-token', machine, undefined, undefined, () => ({
            connect: async () => {},
            initialize: async () => ({}),
            archiveThread: async () => { throw new Error('Method not found: thread/archive') },
            disconnect
        }))

        try {
            expect(await callMachineRpc(client, machine.id, 'archiveCodexLocalSession', { sessionId })).toEqual({
                success: false,
                code: 'archive_unsupported',
                error: 'This Codex app-server does not support native session archive'
            })
            expect(disconnect).toHaveBeenCalledTimes(1)
            expect(await callMachineRpc(client, machine.id, 'listCodexLocalSessions', { limit: 5 })).toMatchObject({
                success: true,
                sessions: [{ id: sessionId }]
            })
        } finally {
            client.shutdown()
        }
    })
})

describe('ApiMachineClient runner metadata sync', () => {
    beforeEach(() => {
        ioMock.mockReset()
    })

    it('backfills the runner Codex home when an existing machine reconnects', async () => {
        const machine = makeMachine('machine-metadata')
        machine.metadataVersion = 6
        machine.metadata = {
            host: 'Mac-mini.local',
            platform: 'darwin',
            happyCliVersion: '0.20.2',
            homeDir: '/Users/alice',
            happyHomeDir: '/Users/alice/.hapi',
            happyLibDir: '/opt/hapi',
            workspaceRoots: ['/Users/alice/Projects'],
            displayName: 'My runner'
        }
        const advertisedMetadata: MachineMetadata = {
            host: 'Mac-mini.local',
            platform: 'darwin',
            happyCliVersion: '0.20.2',
            homeDir: '/Users/alice',
            codexHome: '/Users/alice/.codex',
            happyHomeDir: '/Users/alice/.hapi',
            happyLibDir: '/opt/hapi',
            workspaceRoots: ['/Users/alice/Projects']
        }
        const listeners = new Map<string, (...args: unknown[]) => void>()
        const socket = {
            on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
                listeners.set(event, listener)
            }),
            emit: vi.fn(),
            emitWithAck: vi.fn(async (event: string, data: { runnerState?: unknown; metadata?: MachineMetadata }) => {
                if (event === 'machine-update-state') {
                    return { result: 'success', version: 2, runnerState: data.runnerState }
                }
                return { result: 'success', version: 7, metadata: data.metadata }
            }),
            close: vi.fn()
        }
        ioMock.mockReturnValue(socket)
        const client = new ApiMachineClient('cli-token', machine, advertisedMetadata.workspaceRoots, advertisedMetadata)

        client.connect()
        listeners.get('connect')?.()
        await vi.waitFor(() => {
            expect(socket.emitWithAck).toHaveBeenCalledWith('machine-update-metadata', expect.objectContaining({
                machineId: machine.id,
                expectedVersion: 6,
                metadata: expect.objectContaining(advertisedMetadata)
            }))
        })

        expect(machine.metadata).toMatchObject({
            codexHome: '/Users/alice/.codex',
            displayName: 'My runner'
        })
        client.shutdown()
    })
})

describe('ApiMachineClient keepAlive lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('clears priming timeout on shutdown before first machine-alive emit', () => {
        const machine = makeMachine('machine-keepalive')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn(),
        } as never

        const priv = client as unknown as {
            startKeepAlive: () => void
            keepAliveInterval: NodeJS.Timeout | null
            keepAliveStartTimeout: ReturnType<typeof setTimeout> | null
        }

        priv.startKeepAlive()
        client.shutdown()
        vi.advanceTimersByTime(100)

        expect(emit).not.toHaveBeenCalled()
        expect(priv.keepAliveInterval).toBeNull()
        expect(priv.keepAliveStartTimeout).toBeNull()
    })

    it('clears running keepAlive interval on shutdown', () => {
        const machine = makeMachine('machine-keepalive-2')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn(),
        } as never

        const priv = client as unknown as {
            startKeepAlive: () => void
            keepAliveInterval: NodeJS.Timeout | null
        }

        priv.startKeepAlive()
        vi.advanceTimersByTime(50)
        expect(emit).toHaveBeenCalledTimes(1)

        client.shutdown()
        vi.advanceTimersByTime(20_000)

        expect(emit).toHaveBeenCalledTimes(1)
        expect(priv.keepAliveInterval).toBeNull()
    })
})

describe('ApiMachineClient external Codex requests', () => {
    it('emits external Codex requests through the authenticated machine socket', () => {
        const machine = makeMachine('machine-external-codex')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn()
        } as never

        expect(client.reportExternalCodexRequest({
            codexSessionId: 'codex-thread-1',
            requestId: 'turn-1:Bash',
            kind: 'permission',
            phase: 'requested',
            toolName: 'Bash'
        })).toBe(true)

        expect(emit).toHaveBeenCalledWith('external-codex-request', {
            machineId: 'machine-external-codex',
            codexSessionId: 'codex-thread-1',
            requestId: 'turn-1:Bash',
            kind: 'permission',
            phase: 'requested',
            toolName: 'Bash'
        })
    })

    it('does not emit a late local-input request after that request was resolved', () => {
        const machine = makeMachine('machine-external-codex-late-input')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn()
        } as never

        expect(client.reportExternalCodexRequest({
            codexSessionId: 'codex-thread-late-input',
            requestId: 'call-1',
            kind: 'user-input',
            phase: 'resolved',
            turnId: 'turn-a'
        })).toBe(true)
        expect(client.reportExternalCodexRequest({
            codexSessionId: 'codex-thread-late-input',
            requestId: 'call-1',
            kind: 'user-input',
            phase: 'requested',
            turnId: 'turn-a'
        })).toBe(true)

        expect(emit).not.toHaveBeenCalledWith('external-codex-request', expect.anything())
        client.shutdown()
    })

    it('emits native transcript invalidations through the authenticated machine socket', () => {
        const machine = makeMachine('machine-native-codex')
        const client = new ApiMachineClient('cli-token', machine)
        const emit = vi.fn()
        ;(client as unknown as { socket: { emit: typeof emit; close: () => void } }).socket = {
            emit,
            close: vi.fn()
        } as never

        const report = (client as unknown as {
            reportNativeCodexSessionUpdated: (sessionId: string, modifiedAt?: number) => boolean
        }).reportNativeCodexSessionUpdated.bind(client)

        expect(report('12345678-1234-4234-8234-123456789012', 1_725_000_000_000)).toBe(true)
        expect(emit).toHaveBeenCalledWith('codex-session-updated', {
            machineId: 'machine-native-codex',
            codexSessionId: '12345678-1234-4234-8234-123456789012',
            modifiedAt: 1_725_000_000_000
        })
        client.shutdown()
    })
})
