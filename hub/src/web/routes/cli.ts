import { Hono } from 'hono'
import { basename } from 'node:path'
import { z } from 'zod'
import {
    CreateOrLoadMachineRequestSchema,
    CreateOrLoadSessionRequestSchema,
    CursorMigrateToAcpRequestSchema,
    PROTOCOL_VERSION
} from '@hapi/protocol'
import type { ShareSource, ShareSourceContext } from '@hapi/protocol/apiTypes'
import { isHapiInitiatedCodexSession } from '@hapi/protocol/codexTranscript'
import { getConfiguration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import { ArtifactService, isMarkdownShare, MAX_ARTIFACT_BYTES } from '../../artifacts/service'
import { revokeShareWithNativeCleanup } from '../../kanban/nativeFeedbackRevoke'
import type { Store } from '../../store'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const MAX_SHARE_FILENAME_BYTES = 255

export function decodeShareHeaderText(raw: string | undefined, maxBytes: number): string | null {
    if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
    try {
        const bytes = Buffer.from(raw, 'base64url')
        if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64url') !== raw) return null
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
        return Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/.test(value) ? null : value
    } catch {
        return null
    }
}

export function decodeShareFilename(raw: string | undefined): string | null {
    const filename = decodeShareHeaderText(raw, MAX_SHARE_FILENAME_BYTES)
    if (!filename || filename !== basename(filename) || filename === '.' || filename === '..' || /[\\/\\\\]/.test(filename)) return null
    return filename
}

export function decodeShareSourceDirectoryName(raw: string | undefined): string | null {
    const directoryName = decodeShareHeaderText(raw, MAX_SHARE_FILENAME_BYTES)
    if (!directoryName || directoryName === '.' || directoryName === '..' || /[\\/]/.test(directoryName)) return null
    return directoryName
}

export function decodeShareSourceGitBranch(raw: string | undefined): string | null {
    return decodeShareHeaderText(raw, MAX_SHARE_FILENAME_BYTES)
}

export async function readShareBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
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

type ResolvedShareSource =
    | { ok: true; source: ShareSource }
    | { ok: false; status: 400 | 403 | 404 | 409 | 503; error: string; code: string }

async function resolveNativeCodexShareSource(
    engine: SyncEngine,
    namespace: string,
    codexSessionId: string,
    explicitMachineId: string | null
): Promise<ResolvedShareSource> {
    // The native desktop API is currently intentionally scoped to default.
    // Reject rather than publishing a task that can never be delivered.
    if (namespace !== 'default') {
        return {
            ok: false,
            status: 409,
            code: 'native_source_namespace_unsupported',
            error: 'Native Codex feedback is currently available from the default workspace only'
        }
    }

    const candidates = explicitMachineId
        ? [engine.getMachineByNamespace(explicitMachineId, namespace)].filter((machine): machine is Machine => Boolean(machine))
        : engine.getOnlineMachinesByNamespace(namespace).filter((machine) => typeof machine.metadata?.codexHome === 'string')

    if (explicitMachineId && candidates.length === 0) {
        return { ok: false, status: 404, code: 'native_source_machine_not_found', error: 'Selected native Codex runner was not found' }
    }
    if (explicitMachineId && !candidates[0]?.active) {
        return { ok: false, status: 409, code: 'native_source_machine_offline', error: 'Selected native Codex runner is offline' }
    }
    if (explicitMachineId && typeof candidates[0]?.metadata?.codexHome !== 'string') {
        return { ok: false, status: 409, code: 'native_source_runner_unsupported', error: 'Selected runner cannot read native Codex sessions' }
    }

    const hapiManagedSessionIds = new Set(engine.getSessionsByNamespace(namespace).map((session) => session.id))
    const matches: Array<Extract<ShareSource, { type: 'native-codex' }>> = []
    for (const machine of candidates) {
        if (!machine.active) continue
        try {
            const read = await engine.readCodexLocalSession(machine.id, codexSessionId, { limit: 1 })
            if (read.success !== true || read.data.session.id !== codexSessionId) continue
            if (isHapiInitiatedCodexSession(read.data.session) || hapiManagedSessionIds.has(codexSessionId)) continue
            matches.push({ type: 'native-codex', machineId: machine.id, codexSessionId })
        } catch {
            // A runner can disappear while discovery is in flight. Treat that
            // as no match instead of allowing an unverified source.
        }
    }

    if (matches.length === 1) return { ok: true, source: matches[0]! }
    if (matches.length > 1) {
        return {
            ok: false,
            status: 409,
            code: 'native_source_machine_ambiguous',
            error: 'This native Codex session exists on more than one runner; publish again with --machine <machine-id>'
        }
    }
    return {
        ok: false,
        status: 404,
        code: 'native_source_not_found',
        error: 'Native Codex session was not found on an online runner'
    }
}

async function resolveShareSource(
    engine: SyncEngine,
    namespace: string,
    sourceSessionId: string,
    sourceMachineId: string | null
): Promise<ResolvedShareSource> {
    // An explicit runner is a request for a native source. Do not silently
    // fall back to an SHAPI session with a coincidentally equal id.
    if (sourceMachineId) {
        return await resolveNativeCodexShareSource(engine, namespace, sourceSessionId, sourceMachineId)
    }
    const hapi = engine.resolveSessionAccess(sourceSessionId, namespace)
    if (hapi.ok) return { ok: true, source: { type: 'hapi', sessionId: hapi.sessionId } }
    if (hapi.reason === 'access-denied') {
        return { ok: false, status: 403, code: 'source_session_access_denied', error: 'Source session access denied' }
    }
    return await resolveNativeCodexShareSource(engine, namespace, sourceSessionId, null)
}

export function createCliRoutes(getSyncEngine: () => SyncEngine | null, store?: Store, injectedShareService?: ArtifactService): Hono<CliEnv> {
    const shareService = injectedShareService ?? (store ? new ArtifactService(store, getConfiguration().dataDir) : null)
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
        const access = store?.workspaces.authenticate(token, configuration.cliApiToken, 'runner')
        const parsedToken = store || access ? null : parseAccessToken(token)
        if (!access && (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken))) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', access?.workspace.dataNamespace ?? parsedToken!.namespace)
        return await next()
    })

    app.post('/shares', async (c) => {
        if (!shareService) return c.json({ error: 'Not ready' }, 503)
        const filename = decodeShareFilename(c.req.header('x-hapi-share-filename'))
        const sourceHeader = c.req.header('x-hapi-share-source-session')
        const sourceSessionId = sourceHeader ? decodeShareHeaderText(sourceHeader, 255) : null
        const sourceMachineHeader = c.req.header('x-hapi-share-source-machine')
        const sourceMachineId = sourceMachineHeader ? decodeShareHeaderText(sourceMachineHeader, 200) : null
        const sourceDirectoryHeader = c.req.header('x-hapi-share-source-directory')
        const sourceDirectoryName = sourceDirectoryHeader === undefined ? null : decodeShareSourceDirectoryName(sourceDirectoryHeader)
        const sourceBranchHeader = c.req.header('x-hapi-share-source-branch')
        const sourceGitBranch = sourceBranchHeader === undefined ? null : decodeShareSourceGitBranch(sourceBranchHeader)
        const feedbackHeader = c.req.header('x-hapi-share-feedback')
        const feedback = feedbackHeader === '1'
        const feedbackRequestHeader = c.req.header('x-hapi-share-feedback-request')
        const feedbackRequest = feedbackRequestHeader ? decodeShareHeaderText(feedbackRequestHeader, 2000) : null
        const expires = Number(c.req.header('x-hapi-share-expires'))
        const length = Number(c.req.header('content-length'))
        if (!filename || (sourceHeader && !sourceSessionId) || (sourceMachineHeader && !sourceMachineId) || (sourceMachineId && !sourceSessionId) || (sourceDirectoryHeader !== undefined && !sourceDirectoryName) || (sourceBranchHeader !== undefined && !sourceGitBranch) || (sourceGitBranch && !sourceDirectoryName) || (feedbackHeader && !feedback) || (feedbackRequestHeader && !feedbackRequest) || !Number.isInteger(expires) || expires < 300 || expires > 604800 || (!Number.isNaN(length) && (length < 0 || length > MAX_ARTIFACT_BYTES))) {
            return c.json({ error: 'Invalid share upload' }, 400)
        }
        if (feedback && (!sourceSessionId || !isMarkdownShare(filename))) {
            return c.json({ error: 'Feedback requires a source session and a Markdown share' }, 400)
        }
        let source: ShareSource | null = null
        if (sourceSessionId) {
            const engine = getSyncEngine()
            if (!engine) return c.json({ error: 'Not ready' }, 503)
            const resolved = await resolveShareSource(engine, c.get('namespace'), sourceSessionId, sourceMachineId)
            if (!resolved.ok) return c.json({ error: resolved.error, code: resolved.code }, resolved.status)
            source = resolved.source
        }
        const sourceContext: ShareSourceContext | null = sourceDirectoryName
            ? { directoryName: sourceDirectoryName, gitBranch: sourceGitBranch }
            : null
        const bytes = await readShareBody(c.req.raw.body)
        if (!bytes) return c.json({ error: 'Share exceeds 10 MiB' }, 413)
        if (feedback) {
            try {
                new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            } catch {
                return c.json({ error: 'Feedback-enabled shares must be UTF-8 Markdown' }, 400)
            }
        }
        try {
            const base = getConfiguration().publicUrl.replace(/\/+$/, '')
            const makePublicUrl = (token: string): string => `${base}/s/${token}`
            const published = shareService.publish({
                namespace: c.get('namespace'),
                filename,
                expiresSeconds: expires,
                bytes,
                makePublicUrl,
                source,
                sourceContext,
                feedback: feedback ? {
                    request: feedbackRequest,
                    makeFeedbackUrl: (artifactId: string): string => `${base}/f/${artifactId}`
                } : undefined
            })
            return c.json({ id: published.artifact.id, expiresAt: published.artifact.expiresAt, url: makePublicUrl(published.token) }, 201)
        } catch (error) {
            const message = error instanceof Error ? error.message : ''
            if (message === 'Share exceeds 10 MiB' || message.includes('Feedback is only available')) {
                return c.json({ error: message }, 400)
            }
            return c.json({ error: 'Could not store share' }, 500)
        }
    })

    app.delete('/shares/:id', async (c) => {
        if (!shareService) return c.json({ error: 'Not ready' }, 503)
        const result = store
            ? await revokeShareWithNativeCleanup({
                store,
                shares: shareService,
                engine: getSyncEngine(),
                artifactId: c.req.param('id'),
                namespace: c.get('namespace')
            })
            : shareService.revoke(c.req.param('id'), c.get('namespace'))
        if (result.type === 'not-found') {
            return c.json({ error: 'Share not found' }, 404)
        }
        if (result.type === 'cleanup-pending') {
            return c.json({ error: result.error, code: 'native_feedback_cleanup_pending', cleanupPending: true }, 409)
        }
        if (result.type === 'delete-failed') {
            return c.json({ error: 'Could not delete share data. Please try revoking again.' }, 500)
        }
        return c.json({ ok: true })
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
                    : result.code === 'already_local' || result.code === 'externally_controlled' ? 409
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
