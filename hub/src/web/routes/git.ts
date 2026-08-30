import { Hono } from 'hono'
import { z } from 'zod'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import { RpcTargetMissingError } from '../../sync/rpcGateway'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const directorySchema = z.object({
    path: z.string().optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

const generatedImageSchema = z.object({
    imageId: z.string().min(1)
})

function parseBooleanParam(value: string | undefined): boolean | undefined {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
}

async function runRpc<T>(fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
    try {
        return await fn()
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

function getOwningMachine(engine: SyncEngine, session: Session, namespace: string) {
    const machineId = session.metadata?.machineId
    const machine = machineId ? engine.getMachine(machineId) : null
    return machine?.namespace === namespace ? machine : null
}

/**
 * A finished HAPI session removes its session-scoped RPC handler, but its
 * runner remains able to read the same project directory. Prefer that durable
 * runner path so message links still work after a session ends. Older runners
 * fall back to the session handler while it is still connected.
 */
async function readSessionFileFromAvailableTarget(
    engine: SyncEngine,
    sessionId: string,
    session: Session,
    namespace: string,
    cwd: string,
    path: string
) {
    const machine = getOwningMachine(engine, session, namespace)
    if (machine) {
        try {
            return await engine.readMachineFile(machine.id, cwd, path)
        } catch (error) {
            if (!(error instanceof RpcTargetMissingError)) {
                throw error
            }
        }
    }

    return await engine.readSessionFile(sessionId, path)
}

async function readSessionFileBytesFromAvailableTarget(
    engine: SyncEngine,
    sessionId: string,
    session: Session,
    namespace: string,
    cwd: string,
    path: string
) {
    const machine = getOwningMachine(engine, session, namespace)
    if (machine) {
        try {
            const result = await engine.readMachineFileBytes(machine.id, cwd, path)
            // Pre-upgrade runners do not know the machine-file binary request.
            // An active session can still serve it through the old handler.
            if (result.success || result.error !== 'Unsupported machine file read') {
                return result
            }
        } catch (error) {
            if (!(error instanceof RpcTargetMissingError)) {
                throw error
            }
        }
    }

    return await engine.readSessionFileBytes(sessionId, path)
}

// Generated images are copied to durable hub storage. Keep browser caching enabled because an
// image id is immutable and remounts should not require a storage read or CLI round-trip.
const GENERATED_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable'
const SESSION_FILE_BYTES_CACHE_CONTROL = 'private, max-age=0, must-revalidate'

function inlineContentDisposition(fileName: string | null | undefined, fallback: string): string {
    const resolved = fileName || fallback
    const asciiFallback = resolved
        .replace(/[^\x20-\x7E]+/g, '_')
        .replace(/["\\;]/g, '_')
        .trim() || fallback
    return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(resolved)}`
}

// Weak comparison of an If-None-Match header against our ETag (handles lists, `*`, and W/ prefixes).
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
    if (!header) {
        return false
    }
    const normalized = etag.replace(/^W\//, '')
    return header.split(',').some((candidate) => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed.replace(/^W\//, '') === normalized
    })
}

export function createGitRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/git-status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const result = await runRpc(() => engine.getGitStatus(sessionResult.sessionId, sessionPath))
        return c.json(result)
    })

    app.get('/sessions/:id/git-branch', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const machineId = sessionResult.session.metadata?.machineId
        const machine = machineId ? engine.getMachine(machineId) : null
        // A project-group row can outlive its original session process. Query
        // the runner by directory when it belongs to this namespace instead
        // of routing through an inactive session-scoped RPC handler.
        const result = machine?.namespace === c.get('namespace')
            ? await runRpc(() => engine.getMachineGitBranch(machine.id, sessionPath))
            : await runRpc(() => engine.getGitStatus(sessionResult.sessionId, sessionPath))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-numstat', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffNumstat(sessionResult.sessionId, { cwd: sessionPath, staged }))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffFile(sessionResult.sessionId, {
            cwd: sessionPath,
            filePath: parsed.data.path,
            staged
        }))
        return c.json(result)
    })

    app.get('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const result = await runRpc(() => readSessionFileFromAvailableTarget(
            engine,
            sessionResult.sessionId,
            sessionResult.session,
            c.get('namespace'),
            sessionPath,
            parsed.data.path
        ))
        return c.json(result)
    })

    app.get('/sessions/:id/file-blob', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const result = await runRpc(() => readSessionFileBytesFromAvailableTarget(
            engine,
            sessionResult.sessionId,
            sessionResult.session,
            c.get('namespace'),
            sessionPath,
            parsed.data.path
        ))
        if (!result.success) {
            const status = /invalid/i.test(result.error) ? 400 : 404
            return c.json({ success: false, error: result.error }, status)
        }

        return c.body(Uint8Array.from(result.bytes), 200, {
            'Content-Type': result.mimeType ?? 'application/octet-stream',
            'Content-Disposition': inlineContentDisposition(result.fileName, 'file'),
            'Cache-Control': SESSION_FILE_BYTES_CACHE_CONTROL
        })
    })

    app.get('/sessions/:id/generated-images/:imageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }

        // The id is stable for a displayed file snapshot, so it doubles as the ETag. If the
        // client already holds the bytes, answer 304 before the RPC to skip the CLI round-trip.
        const etag = `"${parsed.data.imageId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        const result = await runRpc(() => engine.readGeneratedImageBytes(sessionResult.sessionId, parsed.data.imageId))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Generated image not found' }, 404)
        }

        // Cache aggressively in the browser: persisted generated-image ids are immutable.
        return c.body(Uint8Array.from(result.bytes), 200, {
            'Content-Type': result.mimeType ?? 'application/octet-stream',
            'Content-Disposition': inlineContentDisposition(result.fileName, 'generated-image'),
            'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
            ETag: etag
        })
    })

    app.get('/sessions/:id/files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = fileSearchSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const query = parsed.data.query?.trim() ?? ''
        const limit = parsed.data.limit ?? 200
        const args = ['--files']
        if (query) {
            args.push('--iglob', `*${query}*`)
        }

        const result = await runRpc(() => engine.runRipgrep(sessionResult.sessionId, args, sessionPath))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const files = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .slice(0, limit)
            .map((fullPath) => {
                const parts = fullPath.split('/')
                const fileName = parts[parts.length - 1] || fullPath
                const filePath = parts.slice(0, -1).join('/')
                return {
                    fileName,
                    filePath,
                    fullPath,
                    fileType: 'file' as const
                }
            })

        return c.json({ success: true, files })
    })

    app.get('/sessions/:id/directory', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = directorySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const path = parsed.data.path ?? ''
        const result = await runRpc(() => engine.listDirectory(sessionResult.sessionId, path))
        return c.json(result)
    })

    return app
}
