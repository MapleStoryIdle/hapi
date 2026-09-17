import { Hono } from 'hono'
import { z } from 'zod'
import { MonitorConfigSchema, MonitorTargetSessionSchema, type MonitorConfig } from '@hapi/protocol/monitoring'
import { createHash } from 'node:crypto'
import { isObject } from '@hapi/protocol'
import { nextMonitorRun } from '../../monitoring/schedule'
import type { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { MonitoringService } from '../../monitoring/service'
import { parseMonitorCurl, validateProbeRequest } from '../../monitoring/probe'
import type { WebAppEnv } from '../middleware/auth'

// Bound actual streamed bytes, not just a forgeable Content-Length header.
async function readJson(request: Request, limit = 32768): Promise<unknown> {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Use application/json')
    const length = Number(request.headers.get('content-length') ?? 0)
    if (!Number.isFinite(length) || length > limit) throw new Error('Request is too large')
    const reader = request.body?.getReader()
    if (!reader) throw new Error('Request body required')
    let size = 0
    const chunks: Uint8Array[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            (async () => {
                while (true) {
                    const chunk = await reader.read()
                    if (chunk.done) break
                    size += chunk.value.byteLength
                    if (size > limit) throw new Error('Request is too large')
                    chunks.push(chunk.value)
                }
                return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Request timed out')), 5000)
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
        void reader.cancel().catch(() => undefined)
    }
}

function matchesWebhookIgnoreKeyword(keywords: string | undefined, content: string): boolean {
    const haystack = content.toLocaleLowerCase()
    return (keywords ?? '')
        .split(/[;；]/)
        .map((keyword) => keyword.trim().toLocaleLowerCase())
        .filter(Boolean)
        .some((keyword) => haystack.includes(keyword))
}

export function createMonitorWebhookRoutes(getService: () => MonitoringService | null, store: Store): Hono {
    const app = new Hono()
    let inflight = 0
    const inflightByMonitor = new Map<string, number>()
    const attempts = new Map<string, { since: number; count: number }>()
    // Hono normally falls HEAD through to GET. Metadata requests must never
    // execute a task, even when the URL contains a valid credential.
    app.on(['GET', 'HEAD'], '/events', (c) => c.json({ error: 'Use POST with a JSON body' }, 405))
    app.post('/events', async (c) => {
        c.header('Cache-Control', 'no-store')
        if (c.req.raw.method === 'HEAD') return c.body(null, 405)
        c.header('Referrer-Policy', 'no-referrer')
        if (/prefetch|prerender/i.test(`${c.req.header('purpose') ?? ''} ${c.req.header('sec-purpose') ?? ''}`)) return c.json({ error: 'Prefetch is not a trigger' }, 400)
        const token = /^[A-Za-z0-9_-]{43}$/.test(c.req.query('token') ?? '') ? c.req.query('token') : undefined
        const service = getService()
        const monitor = token ? store.monitors.byToken(token) : null
        if (!service || !monitor || !monitor.config.enabled || monitor.config.kind !== 'webhook' || (monitor.config.expiresAt !== null && monitor.config.expiresAt <= Date.now())) return c.json({ error: 'Service unavailable' }, 503)
        const now = Date.now()
        const prior = attempts.get(monitor.id)
        const attempt = prior && now - prior.since < 60_000 ? prior : { since: now, count: 0 }
        attempts.set(monitor.id, attempt)
        attempt.count++
        if (inflight >= 16 || (inflightByMonitor.get(monitor.id) ?? 0) >= 2 || attempt.count > 60) {
            c.header('Retry-After', '60')
            return c.json({ error: 'Service busy' }, 429)
        }
        inflight++
        inflightByMonitor.set(monitor.id, (inflightByMonitor.get(monitor.id) ?? 0) + 1)
        try {
            const params = new URL(c.req.url).searchParams
            const body = z
                .object({
                    prompt: z.string().trim().min(1).max(8000),
                    data: z.unknown().optional()
                })
                .strict()
                .safeParse(await readJson(c.req.raw))
            if ([...params.keys()].some((key) => key !== 'token') || params.getAll('token').length !== 1 || !body.success) return c.json({ error: 'Expected token query and JSON prompt (1–8000 characters)' }, 400)
            const prompt = body.data.prompt
            const details = JSON.stringify({ prompt, data: body.data.data ?? {} })
            if (details.length > 12000) return c.json({ error: 'Webhook data is too large' }, 400)
            const event = {
                eventId: '',
                summary: prompt.slice(0, 500),
                details
            }
            if (matchesWebhookIgnoreKeyword(monitor.config.webhookIgnoreKeywords, details)) {
                if (!service.ignore(token!, event)) return c.json({ error: 'Service unavailable' }, 503)
                return c.json({ accepted: true, ignored: true }, 202)
            }
            // Retried requests must not create duplicate agent work.
            // Identical prompt/data payloads coalesce within a minute; an open incident also
            // coalesces subsequent requests until it has been handled.
            const eventId = createHash('sha256')
                .update(`${Math.floor(now / 60000)}:${details}`)
                .digest('hex')
            const result = service.accept(token!, { ...event, eventId })
            if (!result) return c.json({ error: 'Service unavailable' }, 503)
            // External callers do not learn private session/monitor identities.
            return c.json({ accepted: true, duplicate: result.duplicate }, 202)
        } catch (error) {
            if (error instanceof Error && error.message === 'Webhook rate limit reached') {
                c.header('Retry-After', '60')
                return c.json({ error: 'Service busy' }, 429)
            }
            return c.json({ error: 'Invalid webhook request' }, 400)
        } finally {
            inflight--
            const remaining = (inflightByMonitor.get(monitor.id) ?? 1) - 1
            if (remaining) inflightByMonitor.set(monitor.id, remaining)
            else inflightByMonitor.delete(monitor.id)
            for (const [id, entry] of attempts) if (now - entry.since > 60000) attempts.delete(id)
        }
    })
    return app
}

export function createMonitorRoutes(store: Store, getEngine: () => SyncEngine | null, getService: () => MonitoringService | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const resolveTarget = (body: unknown, namespace: string) => resolveMonitorTarget(body, namespace, store, getEngine)
    const preserveTargetBinding = (body: Record<string, unknown>, monitor: MonitorConfig): Record<string, unknown> => monitor.targetSession
        ? {
              ...body,
              targetSession: monitor.targetSession,
              machineId: monitor.machineId,
              directory: monitor.directory,
              agent: monitor.agent,
              model: monitor.model,
              reasoningEffort: monitor.reasoningEffort,
              permissionMode: monitor.permissionMode
          }
        : body
    app.use('/monitors/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        await next()
    })

    const validateConfig = async (config: MonitorConfig, namespace: string): Promise<string | null> => {
        if (!store.machines.getMachineByNamespace(config.machineId, namespace)) return 'Machine not found'
        if (!/^(\/|[A-Za-z]:[\\/])/.test(config.directory) || /[\0\r\n]/.test(config.directory)) return 'Use an absolute directory path'
        if (config.expiresAt !== null && config.expiresAt <= Date.now()) return 'Choose a future expiry date'
        if (config.schedule) {
            try {
                nextMonitorRun(config.schedule, Date.now())
            } catch {
                return 'Invalid schedule, timezone, or five-field cron expression'
            }
        }
        if (config.request) {
            try {
                validateProbeRequest(config.request)
            } catch (e) {
                return e instanceof Error ? e.message : 'Invalid request'
            }
        }
        const engine = getEngine()
        if (!engine?.getOnlineMachinesByNamespace(namespace).some((m) => m.id === config.machineId)) return 'Connect the selected Runner before saving'
        try {
            const paths = await engine.checkPathsExist(config.machineId, [config.directory])
            if (!paths[config.directory]) return 'Directory not found on the selected Runner'
        } catch {
            return 'Unable to verify directory on the selected Runner'
        }
        return null
    }

    app.get('/monitors', (c) => {
        c.header('Cache-Control', 'no-store')
        return c.json({ monitors: store.monitors.list(c.get('namespace')) })
    })
    app.get('/monitors/session-target', async (c) => {
        try {
            const target = MonitorTargetSessionSchema.parse({
                type: c.req.query('type'),
                sessionId: c.req.query('sessionId')
            })
            const config = await resolveTarget(
                {
                    name: 'Monitor',
                    kind: 'webhook',
                    machineId: c.req.query('machineId') ?? '',
                    targetSession: target
                },
                c.get('namespace')
            )
            const engine = getEngine()
            let title = target.sessionId
            if (target.type === 'managed') {
                const session = engine?.getSessionByNamespace(target.sessionId, c.get('namespace'))
                title = session?.metadata?.name
                    || session?.metadata?.summary?.text
                    || session?.metadata?.path?.split('/').filter(Boolean).at(-1)
                    || target.sessionId
            } else if (engine) {
                // A native Codex thread may also have a SHAPI session wrapper.
                // Prefer that user-facing name so the monitor does not expose a
                // raw first-prompt title after switching by native thread ID.
                const linked = engine.getSessionsByNamespace(c.get('namespace')).find((session) =>
                    session.metadata?.flavor === 'codex'
                    && session.metadata.codexSessionId === target.sessionId
                    && (!c.req.query('machineId') || session.metadata.machineId === c.req.query('machineId'))
                )
                title = linked?.metadata?.name
                    || linked?.metadata?.summary?.text
                    || title
                if (!linked) {
                    const source = await engine.readCodexLocalSession(c.req.query('machineId') ?? '', target.sessionId, { limit: 1 })
                    if (source.success) title = source.data.session.title || target.sessionId
                }
            }
            return c.json({ config: MonitorConfigSchema.parse(config), target: { ...target, title } })
        } catch {
            return c.json({ error: 'Source session is unavailable in this workspace' }, 404)
        }
    })
    app.post('/monitors/parse-curl', async (c) => {
        try {
            const body = z
                .object({ curl: z.string().max(16000) })
                .strict()
                .parse(await readJson(c.req.raw))
            return c.json({ request: parseMonitorCurl(body.curl) })
        } catch {
            return c.json(
                {
                    error: 'Unsupported curl. Use one HTTP(S) URL, method, headers and inline body; shell commands and file reads are not supported.'
                },
                400
            )
        }
    })
    app.post('/monitors', async (c) => {
        try {
            const config = MonitorConfigSchema.safeParse(await resolveTarget(await readJson(c.req.raw), c.get('namespace')))
            if (!config.success) return c.json({ error: 'Invalid monitor configuration' }, 400)
            const error = await validateConfig(config.data, c.get('namespace'))
            if (error) return c.json({ error }, 400)
            const created = store.monitors.create(c.get('namespace'), config.data)
            c.header('Cache-Control', 'no-store')
            return c.json(
                {
                    monitor: store.monitors.detail(created.id, c.get('namespace')),
                    token: created.token
                },
                201
            )
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error && error.message === 'Monitor limit reached' ? error.message : 'Unable to save monitor configuration'
                },
                400
            )
        }
    })
    app.get('/monitors/:id', (c) => {
        const monitor = store.monitors.detail(c.req.param('id'), c.get('namespace'))
        return monitor ? c.json({ monitor }) : c.json({ error: 'Monitor not found' }, 404)
    })
    app.patch('/monitors/:id', async (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        try {
            const body = await readJson(c.req.raw)
            if (!isObject(body) || JSON.stringify(body.targetSession) !== JSON.stringify(monitor.config.targetSession)) return c.json({ error: 'The source session cannot be changed' }, 400)
            if (monitor.config.targetSession && body.machineId !== monitor.config.machineId) return c.json({ error: 'The source machine cannot be changed' }, 400)
            const pause = MonitorConfigSchema.safeParse(body)
            if (pause.success && JSON.stringify({ ...pause.data, name: monitor.config.name }) === JSON.stringify(monitor.config)) {
                store.monitors.update(monitor.id, monitor.namespace, pause.data)
                return c.json({
                    monitor: store.monitors.detail(monitor.id, monitor.namespace)
                })
            }
            if (pause.success && JSON.stringify({ ...pause.data, notificationsEnabled: undefined }) === JSON.stringify({ ...monitor.config, notificationsEnabled: undefined })) {
                store.monitors.setNotificationsEnabled(monitor.id, monitor.namespace, pause.data.notificationsEnabled !== false)
                return c.json({
                    monitor: store.monitors.detail(monitor.id, monitor.namespace)
                })
            }
            if (pause.success && JSON.stringify({ ...pause.data, enabled: monitor.config.enabled }) === JSON.stringify(monitor.config)) {
                if (pause.data.enabled && pause.data.expiresAt !== null && pause.data.expiresAt <= Date.now()) return c.json({ error: 'Renew the expired monitor before enabling it' }, 409)
                store.monitors.update(monitor.id, monitor.namespace, pause.data)
                return c.json({
                    monitor: store.monitors.detail(monitor.id, monitor.namespace)
                })
            }
            // A bound source can later be archived or deleted. Editing the rule
            // must not depend on resolving that old session again; target changes
            // use the dedicated endpoint and refresh the server-owned binding.
            const parsed = MonitorConfigSchema.safeParse(preserveTargetBinding(body, monitor.config))
            if (!parsed.success || parsed.data.kind !== monitor.config.kind) return c.json({ error: 'Invalid configuration; monitor type cannot be changed' }, 400)
            // Pausing must work even when the Runner is offline or rule expired.
            const onlyPausing = !parsed.data.enabled && JSON.stringify({ ...parsed.data, enabled: monitor.config.enabled }) === JSON.stringify(monitor.config)
            if (!onlyPausing) {
                const error = await validateConfig(parsed.data, c.get('namespace'))
                if (error) return c.json({ error }, 400)
            }
            store.monitors.update(monitor.id, monitor.namespace, parsed.data)
            return c.json({
                monitor: store.monitors.detail(monitor.id, monitor.namespace)
            })
        } catch {
            return c.json({ error: 'Invalid configuration' }, 400)
        }
    })
    app.put('/monitors/:id/target-session', async (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        try {
            const body = z
                .object({ sessionId: z.string().trim().min(1).max(256) })
                .strict()
                .parse(await readJson(c.req.raw))
            const namespace = c.get('namespace')
            const managedSession = getEngine()?.getSessionByNamespace(body.sessionId, namespace)
            if (managedSession && managedSession.metadata?.flavor !== 'codex') {
                throw new Error('Only Codex sessions can receive monitor messages')
            }
            // Accept either the SHAPI session ID or its native Codex thread ID.
            // Switching changes future incident snapshots, never an already-queued incident.
            const targetSession = managedSession
                ? { type: 'managed' as const, sessionId: body.sessionId }
                : { type: 'native-codex' as const, sessionId: body.sessionId }
            const resolved = await resolveTarget(
                {
                    ...monitor.config,
                    targetSession,
                    machineId: monitor.config.machineId
                },
                namespace
            )
            const config = MonitorConfigSchema.parse(resolved)
            const error = await validateConfig(config, c.get('namespace'))
            if (error) return c.json({ error }, 400)
            store.monitors.update(monitor.id, monitor.namespace, config)
            return c.json({
                monitor: store.monitors.detail(monitor.id, monitor.namespace)
            })
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'Unable to switch the target session'
                },
                400
            )
        }
    })
    app.post('/monitors/:id/token', (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        if (monitor.config.kind !== 'webhook') return c.json({ error: 'Only webhook monitors have tokens' }, 400)
        return c.json({
            token: store.monitors.rotateToken(monitor.id, monitor.namespace)
        })
    })
    app.get('/monitors/:id/token', (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        if (monitor.config.kind !== 'webhook') return c.json({ error: 'Only webhook monitors have tokens' }, 400)
        try {
            return c.json({
                token: store.monitors.readToken(monitor.id, monitor.namespace)
            })
        } catch {
            return c.json({ error: 'Monitor token key unavailable' }, 503)
        }
    })
    app.delete('/monitors/:id', (c) => {
        if (!store.monitors.delete(c.req.param('id'), c.get('namespace'))) return c.json({ error: 'Monitor not found' }, 404)
        return c.json({ success: true })
    })
    app.post('/monitors/:id/check', (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        const service = getService()
        if (!service) return c.json({ error: 'Monitoring unavailable' }, 503)
        try {
            return c.json({ accepted: true, ...service.requestTest(monitor) }, 202)
        } catch {
            return c.json({ error: 'Enable or renew this monitor before testing it' }, 409)
        }
    })
    app.post('/monitors/:id/activities/:activityId/retrigger', (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        return getService()?.retrigger(monitor, c.req.param('activityId')) ? c.json({ accepted: true }, 202) : c.json({ error: 'Finish the current task before triggering this event' }, 409)
    })
    app.post('/monitors/:id/incidents/:incidentId/approve', async (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        try {
            const body = z
                .object({ planHash: z.string().regex(/^[a-f0-9]{64}$/) })
                .strict()
                .parse(await readJson(c.req.raw))
            const accepted = getService()?.approve(monitor, c.req.param('incidentId'), body.planHash)
            return accepted
                ? c.json({ accepted: true }, 202)
                : c.json(
                      {
                          error: 'The plan changed, was already handled, or the rule is unavailable. Refresh before confirming.'
                      },
                      409
                  )
        } catch {
            return c.json({ error: 'Invalid plan confirmation' }, 400)
        }
    })
    app.post('/monitors/:id/incidents/:incidentId/close', (c) => {
        const monitor = store.monitors.get(c.req.param('id'), c.get('namespace'))
        if (!monitor) return c.json({ error: 'Monitor not found' }, 404)
        return getService()?.close(monitor, c.req.param('incidentId')) ? c.json({ accepted: true }) : c.json({ error: 'This incident was already closed or changed. Refresh and try again.' }, 409)
    })
    return app
}
async function resolveMonitorTarget(body: unknown, namespace: string, store: Store, getEngine: () => SyncEngine | null): Promise<unknown> {
    if (!isObject(body) || !body.targetSession) return body
    const target = MonitorTargetSessionSchema.parse(body.targetSession)
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Investigate the trigger in this session; propose a plan and wait for owner confirmation before making changes.'
    const engine = getEngine()
    if (!engine) throw new Error('The selected Runner is unavailable')
    if (target.type === 'managed') {
        const session = engine.getSessionByNamespace(target.sessionId, namespace)
        if (!session?.metadata?.machineId || !session.metadata.path) throw new Error('Session not found')
        const agent = session.metadata.flavor === 'claude' ? 'claude' : 'codex'
        if (!['codex', 'claude'].includes(session.metadata.flavor ?? '')) throw new Error('Unsupported session agent')
        return {
            ...body,
            targetSession: target,
            machineId: session.metadata.machineId,
            directory: session.metadata.path,
            agent,
            model: session.model ?? '',
            reasoningEffort: agent === 'claude' ? session.effort ?? '' : session.modelReasoningEffort ?? '',
            permissionMode: session.permissionMode === 'read-only' && agent === 'codex' ? 'read-only' : session.permissionMode === 'plan' && agent === 'claude' ? 'plan' : 'default',
            prompt
        }
    }
    const machineId = typeof body.machineId === 'string' ? body.machineId : ''
    if (namespace !== 'default') throw new Error('Codex native sessions are unavailable outside this workspace')
    if (!store.machines.getMachineByNamespace(machineId, namespace)) throw new Error('The monitor Runner is unavailable in this workspace')
    const result = await engine.readCodexLocalSession(machineId, target.sessionId, { limit: 1 })
    if (!result.success) throw new Error('Codex session was not found on this Runner, or cannot receive monitor messages')
    return {
        ...body,
        targetSession: target,
        machineId,
        directory: result.data.session.cwd,
        agent: 'codex',
        model: result.data.session.model ?? '',
        reasoningEffort: result.data.session.modelReasoningEffort ?? '',
        permissionMode: 'default',
        prompt
    }
}
