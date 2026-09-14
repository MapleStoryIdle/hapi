import { z } from 'zod'

export const MonitorTargetSessionSchema = z.object({
    type: z.enum(['managed', 'native-codex']),
    sessionId: z.string().trim().min(1).max(256)
}).strict()
export const MonitorScheduleSchema = z.object({
    mode: z.enum(['daily', 'weekly', 'cron']),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
    dayOfWeek: z.number().int().min(0).max(6).default(1),
    cron: z.string().trim().max(120).default('0 9 * * *'),
    timeZone: z.string().trim().min(1).max(100)
}).strict()
export type MonitorSchedule = z.infer<typeof MonitorScheduleSchema>

export const MonitorRequestSchema = z.object({
    url: z.string().trim().url().max(2048),
    method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
    headers: z.record(z.string().max(128), z.string().max(4096)).default({}),
    body: z.string().max(8192).default(''),
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    timeoutSeconds: z.number().int().min(1).max(30).default(10),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    bodyIncludes: z.string().max(1000).default(''),
    allowPrivateNetwork: z.boolean().default(false),
    allowPost: z.boolean().default(false)
}).strict().refine(v => Object.keys(v.headers).length <= 20, 'Too many headers')

export const MonitorConfigSchema = z.object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['webhook', 'http', 'scheduled']),
    targetSession: MonitorTargetSessionSchema.optional(),
    schedule: MonitorScheduleSchema.optional(),
    machineId: z.string().min(1).max(256),
    directory: z.string().trim().min(1).max(2048),
    agent: z.enum(['codex', 'claude']).default('codex'),
    model: z.string().trim().max(128).default(''),
    reasoningEffort: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default(''),
    permissionMode: z.enum(['default', 'read-only', 'plan']).default('default'),
    prompt: z.string().trim().min(1).max(8000),
    webhookIgnoreKeywords: z.string().max(2000).default(''),
    expiresAt: z.number().int().positive().nullable().default(null),
    enabled: z.boolean().default(true),
    notificationsEnabled: z.boolean().optional(),
    request: MonitorRequestSchema.nullable().default(null)
}).strict().superRefine((v, ctx) => {
    if (v.kind === 'http' && !v.request) ctx.addIssue({ code: 'custom', path: ['request'], message: 'HTTP request required' })
    if (v.kind === 'webhook' && v.request) ctx.addIssue({ code: 'custom', path: ['request'], message: 'Webhook cannot configure a probe' })
    if (v.kind === 'scheduled' && (!v.schedule || v.request)) ctx.addIssue({ code: 'custom', path: ['schedule'], message: 'Schedule required; probes are not supported' })
    if (v.kind !== 'scheduled' && v.schedule) ctx.addIssue({ code: 'custom', path: ['schedule'], message: 'Only scheduled monitors can have a schedule' })
    if (v.agent === 'claude' && v.permissionMode === 'read-only' || v.agent === 'codex' && v.permissionMode === 'plan') {
        ctx.addIssue({ code: 'custom', path: ['permissionMode'], message: 'Permission mode does not match agent' })
    }
})

export type MonitorConfig = z.infer<typeof MonitorConfigSchema>
export type MonitorRequest = z.infer<typeof MonitorRequestSchema>
export type MonitorHealth = 'unknown' | 'up' | 'down'
export type MonitorApprovalContext = Pick<MonitorConfig, 'machineId' | 'directory' | 'agent' | 'model' | 'reasoningEffort' | 'permissionMode'>
export type MonitorIncidentState = 'queued' | 'starting' | 'investigating' | 'review' | 'repair_queued' | 'repair_starting' | 'repairing' | 'completed' | 'needs_attention' | 'closed'
export type MonitorIncident = {
    id: string
    monitorId: string
    createdAt: number
    updatedAt: number
    state: MonitorIncidentState
    summary: string
    sessionId: string | null
    repairSessionId: string | null
    plan: string | null
    planHash: string | null
    error: string | null
    deliveredAt?: number
    deliverySession?: { type: 'managed' | 'native-codex'; sessionId: string; machineId: string }
    approvalContext?: MonitorApprovalContext
}
export type MonitorBucket = { at: number; total: number; ok: number; failures: number; latencyMs: number }
export type MonitorActivitySource = 'probe' | 'webhook' | 'scheduled' | 'manual'
export type MonitorActivityOutcome = 'ok' | 'failed' | 'dispatched' | 'deferred' | 'duplicate' | 'ignored'
export type MonitorActivity = {
    id: string
    monitorId: string
    createdAt: number
    source: MonitorActivitySource
    outcome: MonitorActivityOutcome
    summary: string
    details: string
    incidentId?: string
}
export type MonitorCallStats = {
    total: number
    ok: number
    failed: number
    dispatched: number
    deferred: number
    duplicate: number
    ignored: number
}
export type Monitor = {
    id: string
    config: MonitorConfig
    createdAt: number
    updatedAt: number
    health: MonitorHealth
    lastCheckedAt: number | null
    lastLatencyMs: number | null
    lastError: string | null
    nextCheckAt: number
    buckets: MonitorBucket[]
    incident: MonitorIncident | null
    callStats: MonitorCallStats
    relatedSession?: { type: 'managed' | 'native-codex'; sessionId: string; machineId?: string }
}
export type MonitorDetail = Monitor & { incidents: MonitorIncident[]; activities: MonitorActivity[] }
export const MonitorWebhookSchema = z.object({
    eventId: z.string().trim().min(1).max(128),
    summary: z.string().trim().min(1).max(500),
    details: z.string().max(12000).default('')
}).strict()
export type MonitorWebhook = z.infer<typeof MonitorWebhookSchema>
