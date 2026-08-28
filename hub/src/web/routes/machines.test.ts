import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { Session } from '@hapi/protocol/types'
import type { WebAppEnv } from '../middleware/auth'
import { createMachinesRoutes } from './machines'

function createMachine(overrides?: Partial<Machine>): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: '1.0.0'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1,
        ...overrides
    }
}

describe('machines routes', () => {
    it('returns the spawned session so web can seed selected model and reasoning state', async () => {
        const machine = createMachine()
        const session: Session = {
            id: 'session-1',
            namespace: 'default',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: { path: '/work/project', host: 'localhost', flavor: 'codex' },
            metadataVersion: 1,
            agentState: { controlledByUser: false },
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            model: 'gpt-5.5',
            modelReasoningEffort: 'xhigh',
            effort: null,
            serviceTier: null,
            permissionMode: 'yolo',
            collaborationMode: 'default',
        }
        const calls: Array<{
            machineId: string
            directory: string
            agent: string | undefined
            model: string | undefined
            modelReasoningEffort: string | undefined
        }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            spawnSession: async (
                machineId: string,
                directory: string,
                agent?: string,
                model?: string,
                modelReasoningEffort?: string
            ) => {
                calls.push({ machineId, directory, agent, model, modelReasoningEffort })
                return { type: 'success' as const, sessionId: session.id }
            },
            getSessionByNamespace: () => session,
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/spawn', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                directory: '/work/project',
                agent: 'codex',
                model: 'gpt-5.5',
                modelReasoningEffort: 'xhigh',
            }),
        })

        expect(response.status).toBe(200)
        expect(calls).toEqual([{
            machineId: 'machine-1',
            directory: '/work/project',
            agent: 'codex',
            model: 'gpt-5.5',
            modelReasoningEffort: 'xhigh',
        }])
        expect(await response.json()).toEqual({
            type: 'success',
            sessionId: 'session-1',
            session,
        })
    })

    it('returns Codex models for an online machine', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCodexModelsForMachine: async () => ({
                success: true,
                models: [
                    { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
                ]
            })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/codex-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            models: [
                { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: true }
            ]
        })
    })

    it('returns Codex subscription limits for an online machine and forwards the native model', async () => {
        const machine = createMachine()
        const calls: Array<{ machineId: string; model: string | null }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            getCodexSubscriptionLimitsForMachine: async (machineId: string, model: string | null) => {
                calls.push({ machineId, model })
                return {
                    success: true,
                    limits: {
                        limitId: 'codex',
                        limitName: 'Codex',
                        planType: 'plus',
                        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_762_000_000 },
                        secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_762_500_000 },
                        updatedAt: 1_762_000_000_000
                    }
                }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/codex-subscription-limits?model=gpt-5.6-terra')

        expect(response.status).toBe(200)
        expect(calls).toEqual([{ machineId: 'machine-1', model: 'gpt-5.6-terra' }])
        expect(await response.json()).toEqual({
            success: true,
            limits: {
                limitId: 'codex',
                limitName: 'Codex',
                planType: 'plus',
                primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_762_000_000 },
                secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_762_500_000 },
                updatedAt: 1_762_000_000_000
            }
        })
    })

    it('returns 400 when /opencode-models is called without cwd', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listOpencodeModelsForCwd: async () => ({ success: true, availableModels: [] })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/opencode-models')

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            success: false,
            error: 'cwd query parameter is required'
        })
    })

    it('forwards cwd to listOpencodeModelsForCwd and returns availableModels', async () => {
        const machine = createMachine()
        const calls: Array<{ machineId: string; cwd: string }> = []
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listOpencodeModelsForCwd: async (machineId: string, cwd: string) => {
                calls.push({ machineId, cwd })
                return {
                    success: true,
                    availableModels: [
                        { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama/EXAONE 4.5 33B Q8' }
                    ],
                    currentModelId: 'ollama/exaone:4.5-33b-q8'
                }
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request(
            '/api/machines/machine-1/opencode-models?cwd=' + encodeURIComponent('/home/user/proj')
        )

        expect(response.status).toBe(200)
        expect(calls).toEqual([{ machineId: 'machine-1', cwd: '/home/user/proj' }])
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'ollama/exaone:4.5-33b-q8', name: 'Ollama/EXAONE 4.5 33B Q8' }
            ],
            currentModelId: 'ollama/exaone:4.5-33b-q8'
        })
    })

    it('returns 503 when cursor-models is requested without a sync engine', async () => {
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => null))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
            success: false,
            error: 'Not connected'
        })
    })

    it('returns 500 when listing Cursor models fails', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCursorModelsForMachine: async () => {
                throw new Error('rpc offline')
            }
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({
            success: false,
            error: 'rpc offline'
        })
    })

    it('returns Cursor models for an online machine', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCursorModelsForMachine: async () => ({
                success: true,
                availableModels: [
                    { modelId: 'composer-2.5', name: 'Composer 2.5' },
                    { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
                ],
                currentModelId: 'composer-2.5'
            })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' }
            ],
            currentModelId: 'composer-2.5'
        })
    })

    it('returns ACP wire ids from the machine RPC for New Session model pickers', async () => {
        const machine = createMachine()
        const engine = {
            getMachine: () => machine,
            getMachineByNamespace: () => machine,
            listCursorModelsForMachine: async () => ({
                success: true,
                availableModels: [
                    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                    { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
                ],
                currentModelId: 'composer-2.5[fast=true]'
            })
        } as Partial<SyncEngine>

        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => {
            c.set('namespace', 'default')
            await next()
        })
        app.route('/api', createMachinesRoutes(() => engine as SyncEngine))

        const response = await app.request('/api/machines/machine-1/cursor-models')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            availableModels: [
                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
            ],
            currentModelId: 'composer-2.5[fast=true]'
        })
    })
})
