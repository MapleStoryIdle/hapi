import { Hono } from 'hono'
import { basename } from 'node:path'
import { z } from 'zod'
import {
    CreateOrLoadMachineRequestSchema,
    CreateOrLoadSessionRequestSchema,
    CursorMigrateToAcpRequestSchema,
    PROTOCOL_VERSION,
    VerifyRemoteServerCandidateRequestSchema
} from '@hapi/protocol'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import { ArtifactService, MAX_ARTIFACT_BYTES } from '../../artifacts/service'
import type { Store } from '../../store'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const MAX_ARTIFACT_FILENAME_BYTES = 255

export function decodeArtifactFilename(raw: string | undefined): string | null {
    if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
    try {
        const bytes = Buffer.from(raw, 'base64url')
        if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_FILENAME_BYTES || bytes.toString('base64url') !== raw) return null
        const filename = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
        if (filename !== basename(filename) || filename === '.' || filename === '..' || /[\/\\\u0000-\u001f\u007f]/.test(filename)) return null
        return filename
    } catch {
        return null
    }
}

export async function readArtifactBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
    if (!body) return new Uint8Array()
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > MAX_ARTIFACT_BYTES) {
                await reader.cancel()
                return null
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

type CliEnv = {
    Variables: {
        namespace: string
    }
}

function resolveSessionForNamespace(
    engine: SyncEngine,
    sessionId: string,
    namespace: string
): { ok: true; session: Session; sessionId: string } | { ok: false; status: 403 | 404; error: string } {
    const access = engine.resolveSessionAccess(sessionId, namespace)
    if (access.ok) {
        return { ok: true, session: access.session, sessionId: access.sessionId }
    }
    return {
        ok: false,
        status: access.reason === 'access-denied' ? 403 : 404,
        error: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found'
    }
}

function resolveMachineForNamespace(
    engine: SyncEngine,
    machineId: string,
    namespace: string
): { ok: true; machine: Machine } | { ok: false; status: 403 | 404; error: string } {
    const machine = engine.getMachineByNamespace(machineId, namespace)
    if (machine) {
        return { ok: true, machine }
    }
    if (engine.getMachine(machineId)) {
        return { ok: false, status: 403, error: 'Machine access denied' }
    }
    return { ok: false, status: 404, error: 'Machine not found' }
}

export function createCliRoutes(getSyncEngine: () => SyncEngine | null, store?: Store): Hono<CliEnv> {
    const artifacts = store ? new ArtifactService(store, getConfiguration().dataDir) : null
    const app = new Hono<CliEnv>()

    app.use('*', async (c, next) => {
        c.header('X-Hapi-Protocol-Version', String(PROTOCOL_VERSION))

        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }

        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }

        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const configuration = getConfiguration()
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', parsedToken.namespace)
        return await next()
    })

    app.post('/artifacts', async (c) => {
        if (!artifacts) return c.json({ error: 'Not ready' }, 503)
        const filename = decodeArtifactFilename(c.req.header('x-hapi-artifact-filename'))
        const expires = Number(c.req.header('x-hapi-artifact-expires'))
        const length = Number(c.req.header('content-length'))
        if (!filename || !Number.isInteger(expires) || expires < 300 || expires > 604800 || (!Number.isNaN(length) && (length < 0 || length > MAX_ARTIFACT_BYTES))) {
            return c.json({ error: 'Invalid artifact upload' }, 400)
        }
        const bytes = await readArtifactBody(c.req.raw.body)
        if (!bytes) return c.json({ error: 'Artifact exceeds 10 MiB' }, 413)
        try {
            const published = artifacts.publish({ namespace: c.get('namespace'), filename, expiresSeconds: expires, bytes })
            const base = getConfiguration().publicUrl.replace(/\/+$/, '')
            return c.json({ id: published.artifact.id, expiresAt: published.artifact.expiresAt, url: `${base}/a/${published.token}` }, 201)
        } catch {
            return c.json({ error: 'Could not store artifact' }, 500)
        }
    })

    app.delete('/artifacts/:id', (c) => {
        if (!artifacts) return c.json({ error: 'Not ready' }, 503)
        return artifacts.revoke(c.req.param('id'), c.get('namespace')) ? c.json({ ok: true }) : c.json({ error: 'Artifact not found' }, 404)
    })

    app.post('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = CreateOrLoadSessionRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const session = engine.getOrCreateSession(
            parsed.data.tag,
            parsed.data.metadata,
            parsed.data.agentState ?? null,
            namespace,
            parsed.data.model,
            parsed.data.effort,
            parsed.data.modelReasoningEffort
        )
        return c.json({ session })
    })

    app.get('/sessions/resumable', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const machineId = c.req.query('machineId') || undefined
        const sessions = engine.listLocalResumableSessions(namespace, { machineId })
        return c.json({ sessions })
    })

    app.get('/sessions/:id/resume-target', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const result = engine.resolveLocalResumeTarget(c.req.param('id'), namespace)
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403
                : result.code === 'session_not_found' ? 404
                    : 409
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ target: result.target })
    })

    app.post('/sessions/:id/handoff-local', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }

        const namespace = c.get('namespace')
        const result = await engine.handoffSessionToLocal(c.req.param('id'), namespace)
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403
                : result.code === 'session_not_found' ? 404
                    : result.code === 'already_local' ? 409
                        : 500
            return c.json({ error: result.message, code: result.code }, status)
        }

        return c.json({ ok: true })
    })

    app.get('/sessions/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? 200
        // Future-scheduled rows are excluded from CLI backfill — see
        // messages.ts:getDeliverableMessagesAfter for the rationale.  The
        // mature-scan path (releaseMatureScheduledMessages) is the sole
        // emit channel for scheduled rows.
        const messages = engine.getDeliverableMessagesAfter(resolved.sessionId, {
            afterSeq: parsed.data.afterSeq,
            limit,
            now: Date.now()
        })
        return c.json({ messages })
    })

    app.post('/sessions/:id/remote-server-candidates/verify', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = VerifyRemoteServerCandidateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const result = engine.verifyRemoteServerCandidate(resolved.sessionId, namespace, parsed.data)
        if (result.type === 'error') {
            const status = result.code === 'access_denied' ? 403 : 404
            return c.json({ error: result.message, code: result.code }, status)
        }
        if (result.type === 'already-recorded') {
            return c.json({ status: 'already-recorded', server: result.server })
        }
        return c.json({ status: 'candidate-created', candidate: result.candidate })
    })

    app.post('/sessions/:id/migrate-to-acp', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveSessionForNamespace(engine, sessionId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        // Codex #34 P2 (round 13): mirror the sessions.ts route hardening —
        // distinguish "no body" from "malformed JSON". A silent fallback to
        // {} would run the migration with destructive defaults even when
        // the operator's intended body was mangled in transit.
        const rawBody = await c.req.text()
        let body: unknown = {}
        if (rawBody.trim().length > 0) {
            try {
                body = JSON.parse(rawBody)
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400)
            }
        }
        const parsed = CursorMigrateToAcpRequestSchema.safeParse(body ?? {})
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.issues }, 400)
        }
        const outcome = await engine.migrateLegacyCursorSession(resolved.sessionId, namespace, parsed.data)
        const status = outcome.ok ? 200
            : outcome.reason === 'already_acp' || outcome.reason === 'not_cursor_session' || outcome.reason === 'no_cursor_session_id' ? 409
                : outcome.reason === 'running_refused' ? 409
                    : outcome.reason === 'target_already_exists' ? 409
                        : outcome.reason === 'no_legacy_store_on_disk' ? 404
                            : 500
        return c.json(outcome, status)
    })

    app.post('/machines', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = CreateOrLoadMachineRequestSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const existing = engine.getMachine(parsed.data.id)
        if (existing && existing.namespace !== namespace) {
            return c.json({ error: 'Machine access denied' }, 403)
        }
        const machine = engine.getOrCreateMachine(parsed.data.id, parsed.data.metadata, parsed.data.runnerState ?? null, namespace)
        return c.json({ machine })
    })

    app.get('/machines/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const namespace = c.get('namespace')
        const resolved = resolveMachineForNamespace(engine, machineId, namespace)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ machine: resolved.machine })
    })

    return app
}
