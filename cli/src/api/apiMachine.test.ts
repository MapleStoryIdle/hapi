import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
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
        writeFileSync(join(transcriptDir, `rollout-${sessionId}.jsonl`), [
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
            homeDir: '/Users/dev',
            happyHomeDir: '/Users/dev/.hapi',
            happyLibDir: '/opt/hapi',
            workspaceRoots: ['/Users/dev/IdeaProjects'],
            displayName: 'My runner'
        }
        const advertisedMetadata: MachineMetadata = {
            host: 'Mac-mini.local',
            platform: 'darwin',
            happyCliVersion: '0.20.2',
            homeDir: '/Users/dev',
            codexHome: '/Users/dev/.codex',
            happyHomeDir: '/Users/dev/.hapi',
            happyLibDir: '/opt/hapi',
            workspaceRoots: ['/Users/dev/IdeaProjects']
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
            codexHome: '/Users/dev/.codex',
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
            toolName: 'Bash'
        })).toBe(true)

        expect(emit).toHaveBeenCalledWith('external-codex-request', {
            machineId: 'machine-external-codex',
            codexSessionId: 'codex-thread-1',
            requestId: 'turn-1:Bash',
            kind: 'permission',
            toolName: 'Bash'
        })
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
