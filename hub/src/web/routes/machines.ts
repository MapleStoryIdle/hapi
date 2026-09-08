import {
    MachineGitBranchCreateRequestSchema,
    MachineGitBranchCommitRequestSchema,
    MachineGitBranchesRequestSchema,
    MachineGitBranchFetchRequestSchema,
    MachineGitBranchPushRequestSchema,
    MachineGitBranchSwitchRequestSchema,
    MachineGitBranchUpdateRequestSchema,
    MachineListDirectoryRequestSchema,
    MachinePathsExistsRequestSchema,
    SpawnSessionRequestSchema
} from '@hapi/protocol'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireMachine } from './guards'

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = engine.getOnlineMachinesByNamespace(namespace)
        return c.json({ machines })
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = SpawnSessionRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.modelReasoningEffort,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            undefined,
            parsed.data.effort
        )
        if (result.type === 'success') {
            const session = engine.getSessionByNamespace(result.sessionId, c.get('namespace'))
            if (session) {
                return c.json({ ...result, session })
            }
        }
        return c.json(result)
    })

    app.post('/machines/:id/list-directory', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineListDirectoryRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.listMachineDirectory(machineId, parsed.data.path)
            return c.json(result)
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to list directory' }, 500)
        }
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachinePathsExistsRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            const exists = await engine.checkPathsExist(machineId, uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    app.get('/machines/:id/codex-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCodexModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Codex models'
            }, 500)
        }
    })

    app.get('/machines/:id/codex-subscription-limits', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const model = c.req.query('model')?.trim() || null
        try {
            const result = await engine.getCodexSubscriptionLimitsForMachine(machineId, model)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read Codex subscription limits'
            }, 500)
        }
    })

    app.get('/machines/:id/opencode-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.listOpencodeModelsForCwd(machineId, cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list OpenCode models'
            }, 500)
        }
    })

    app.get('/machines/:id/git-branch', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const cwd = (c.req.query('cwd') ?? '').trim()
        if (!cwd) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.getMachineGitBranch(machineId, cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to read Git branch'
            }, 500)
        }
    })

    app.get('/machines/:id/git-branches', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const parsed = MachineGitBranchesRequestSchema.safeParse({ cwd: c.req.query('cwd') })
        if (!parsed.success) {
            return c.json({ success: false, error: 'cwd query parameter is required' }, 400)
        }

        try {
            const result = await engine.getMachineGitBranches(machineId, parsed.data.cwd)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Git branches'
            }, 500)
        }
    })

    app.post('/machines/:id/git-branches/switch', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineGitBranchSwitchRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.switchMachineGitBranch(machineId, parsed.data)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to switch Git branch'
            }, 500)
        }
    })

    app.post('/machines/:id/git-branches', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineGitBranchCreateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.createMachineGitBranch(machineId, parsed.data)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create Git branch'
            }, 500)
        }
    })

    app.post('/machines/:id/git-branches/commit', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineGitBranchCommitRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.commitMachineGitChanges(machineId, parsed.data)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to commit Git changes'
            }, 500)
        }
    })

    app.post('/machines/:id/git-branches/push', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineGitBranchPushRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.pushMachineGitBranch(machineId, parsed.data)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to push Git branch'
            }, 500)
        }
    })

    app.post('/machines/:id/git-branches/fetch', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineGitBranchFetchRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.fetchMachineGitBranches(machineId, parsed.data)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch Git branches'
            }, 500)
        }
    })

    app.post('/machines/:id/git-branches/update', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = MachineGitBranchUpdateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid body' }, 400)
        }

        try {
            const result = await engine.updateMachineGitBranch(machineId, parsed.data)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update Git branch'
            }, 500)
        }
    })

    app.get('/machines/:id/cursor-models', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ success: false, error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        try {
            const result = await engine.listCursorModelsForMachine(machineId)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list Cursor models'
            }, 500)
        }
    })

    return app
}
