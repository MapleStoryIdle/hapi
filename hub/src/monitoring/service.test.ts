import { describe, expect, it, mock, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { MonitorConfigSchema } from '@hapi/protocol/monitoring'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import type { SyncEngine } from '../sync/syncEngine'
import { extractMonitorPlan, MonitoringService } from './service'

const agent = (data: Record<string, unknown>) => ({ content: { role: 'agent', content: { type: 'codex', data } } })
const complete = agent({ type: 'turn-outcome', outcome: 'completed' })

function setup(kind: 'http' | 'webhook' = 'webhook') {
    const store = new Store(':memory:')
    const sessions = new Map<string, Session>()
    const calls: unknown[][] = []
    const config = MonitorConfigSchema.parse({ name: 'API', kind, machineId: 'm', directory: '/work', prompt: 'Find cause',
        request: kind === 'http' ? { url: 'https://example.com', intervalSeconds: 60 } : null })
    const created = store.monitors.create('a', config)
    const engine = {
        getOnlineMachinesByNamespace: (ns: string) => ns === 'a' ? [{ id: 'm' }] : [],
        getSessionByNamespace: (id: string, ns: string) => ns === 'a' ? sessions.get(id) : undefined,
        waitForSessionActive: async () => true,
        spawnSession: async (...args: unknown[]) => {
            calls.push(args)
            const record = store.sessions.getOrCreateSession('s' + calls.length, { path: '/work' }, null, 'a')
            sessions.set(record.id, {
                id: record.id, namespace: 'a', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                metadata: { path: '/work', host: 'localhost', flavor: 'codex' }, metadataVersion: 1,
                agentState: {}, agentStateVersion: 1, thinking: false, thinkingAt: 0,
                model: null, modelReasoningEffort: null, effort: null, serviceTier: null
            })
            return { type: 'success' as const, sessionId: record.id }
        },
        sendMessage: async (id: string, message: { text: string; localId: string }) => {
            store.messages.addMessage(id, { role: 'user', content: { type: 'text', text: message.text } }, message.localId)
        }
    } as unknown as SyncEngine
    const push = { sendToNamespace: mock(async () => undefined) }
    const service = new MonitoringService(store, () => engine, push, async () => ({ ok: false, latencyMs: 10, error: 'HTTP 500' }))
    return { store, service, calls, created, config, sessions, push, engine }
}

describe('monitor dispatch and confirmation', () => {
    it('mutes monitor notifications without stopping dispatch and applies the current switch to running work', async () => {
        const s = setup()
        try {
            s.store.monitors.setNotificationsEnabled(s.created.id, 'a', false)
            s.service.accept(s.created.token!, { eventId: 'muted', summary: 'bad', details: '' })
            await s.service.tick()
            expect(s.calls).toHaveLength(1)
            expect(s.push.sendToNamespace).not.toHaveBeenCalled()
            const event = s.store.monitors.openForMonitor(s.created.id)!
            s.store.monitors.setNotificationsEnabled(s.created.id, 'a', true)
            s.store.messages.addMessage(event.sessionId!, agent({ type: 'message', message: 'Plan', final: true }).content)
            s.store.messages.addMessage(event.sessionId!, complete.content)
            await s.service.tick()
            expect(s.push.sendToNamespace).toHaveBeenCalledTimes(1)
            expect(s.store.monitors.getIncident(event.id)?.state).toBe('review')
        } finally { await s.service.stop(); s.store.close() }
    })
    it('allows the owner to bind a writable managed session without changing its permission', async () => {
        const s = setup()
        try {
            const source = await s.engine.spawnSession('m', '/work', 'codex')
            if (source.type !== 'success') throw new Error('fixture failed')
            const session = s.sessions.get(source.sessionId)!
            session.metadata!.machineId = 'm'
            session.permissionMode = 'default'
            s.store.monitors.update(s.created.id, 'a', { ...s.config, targetSession: { type: 'managed', sessionId: source.sessionId } })
            const send = spyOn(s.engine, 'sendMessage')
            s.service.accept(s.created.token!, { eventId: 'bound-write', summary: 'bad', details: 'change files' })
            await s.service.tick()
            expect(s.store.monitors.openForMonitor(s.created.id)?.state).toBe('investigating')
            expect(send).toHaveBeenCalledTimes(1)
            expect(session.permissionMode).toBe('default')
            send.mockRestore()
        } finally { await s.service.stop(); s.store.close() }
    })
    it('uses an existing managed session, waits while busy, and rejects an unrelated final answer', async () => {
        const s = setup()
        try {
            const source = await s.engine.spawnSession('m', '/work', 'codex')
            if (source.type !== 'success') throw new Error('fixture failed')
            const session = s.sessions.get(source.sessionId)!
            session.metadata!.machineId = 'm'
            session.permissionMode = 'read-only'
            session.thinking = true
            s.calls.length = 0
            s.store.monitors.update(s.created.id, 'a', { ...s.config, targetSession: { type: 'managed', sessionId: source.sessionId } })
            s.service.accept(s.created.token!, { eventId: 'bound', summary: 'bad', details: '' })
            await s.service.tick()
            expect(s.store.monitors.openForMonitor(s.created.id)?.state).toBe('queued')
            session.thinking = false
            await s.service.tick()
            const incident = s.store.monitors.openForMonitor(s.created.id)!
            expect(incident.sessionId).toBe(source.sessionId)
            expect(s.calls).toHaveLength(0)
            s.store.messages.addMessage(source.sessionId, { role: 'user', content: { type: 'text', text: 'Unrelated request' } })
            s.store.messages.addMessage(source.sessionId, agent({ type: 'message', message: 'An unrelated plan', final: true }).content)
            s.store.messages.addMessage(source.sessionId, complete.content)
            await s.service.tick()
            expect(s.store.monitors.getIncident(incident.id)?.state).toBe('needs_attention')
        } finally { await s.service.stop(); s.store.close() }
    })
    it('delivers to the bound native thread read-only and correlates its terminal response', async () => {
        const store = new Store(':memory:')
        let history: unknown[] = []
        const send = mock(async (..._args: unknown[]) => ({ success: true }))
        const spawn = mock(async () => ({ type: 'success', sessionId: 'WRONG' }))
        const engine = {
            getOnlineMachinesByNamespace: () => [{ id: 'm' }], spawnSession: spawn,
            readCodexLocalSession: async () => ({ success: true, data: { session: { cwd: '/work' } } }),
            stageNativeKanbanFeedback: async (_machineId: string, input: Parameters<SyncEngine['stageNativeKanbanFeedback']>[1]) => {
                // Contract enforced by the real Runner feedback-file vault.
                expect(input.artifactId).toMatch(/^[a-f0-9]{32}$/)
                expect(input.filename).toBe('monitor-event.md')
                expect(input.size).toBe(input.bytes.byteLength)
                expect(input.sha256).toBe(createHash('sha256').update(new Uint8Array(input.bytes)).digest('hex'))
                return { success: true, path: '/safe/monitor-event.md' }
            },
            sendCodexLocalSessionMessage: send,
            readCodexLocalSessionSnapshot: async () => ({ success: true, unchanged: false, snapshot: { status: { status: 'idle' }, data: { importedMessages: history } } })
        } as unknown as SyncEngine
        const service = new MonitoringService(store, () => engine, { sendToNamespace: mock(async () => undefined) })
        try {
            const { id, token } = store.monitors.create('default', MonitorConfigSchema.parse({ name: 'native', kind: 'webhook', machineId: 'm', directory: '/work', prompt: 'Inspect', targetSession: { type: 'native-codex', sessionId: 'native-1' } }))
            service.accept(token!, { eventId: 'one', summary: 'bad', details: 'PRIVATE_EVENT_EVIDENCE' })
            await service.tick()
            expect(spawn).not.toHaveBeenCalled()
            expect(send.mock.calls[0]?.[1]).toBe('native-1')
            expect(send.mock.calls[0]?.[6]).toBe('untrusted-review')
            expect(send.mock.calls[0]?.[2]).not.toContain('PRIVATE_EVENT_EVIDENCE')
            history = [agent({ type: 'message', message: 'Old plan', final: true, turnOutcome: 'completed' }).content]
            await service.tick()
            expect(store.monitors.openForMonitor(id)?.state).toBe('investigating')
            history = [{ role: 'user', content: { type: 'text', text: send.mock.calls[0]?.[2] } }, agent({ type: 'message', message: 'This task plan', final: true, turnOutcome: 'completed' }).content]
            await service.tick()
            expect(store.monitors.openForMonitor(id)?.state).toBe('review')
            const reviewed = store.monitors.openForMonitor(id)!
            history.push({ role: 'user', content: { type: 'text', text: 'A new unrelated task' } })
            expect(service.approve(store.monitors.get(id)!, reviewed.id, reviewed.planHash!)).toBe(true)
            await service.tick()
            expect(store.monitors.openForMonitor(id)?.state).toBe('needs_attention')
            expect(send).toHaveBeenCalledTimes(1)
        } finally { await service.stop(); store.close() }
    })
    it('serializes two rules bound to the same native source', async () => {
        const store = new Store(':memory:')
        const send = mock(async () => ({ success: true }))
        const engine = {
            getOnlineMachinesByNamespace: () => [{ id: 'm' }],
            readCodexLocalSession: async () => ({ success: true, data: { session: { cwd: '/work' } } }),
            stageNativeKanbanFeedback: async () => ({ success: true, path: '/safe/stage.md' }),
            sendCodexLocalSessionMessage: send,
            readCodexLocalSessionSnapshot: async () => ({ success: true, unchanged: false, snapshot: { status: { status: 'processing' }, data: { importedMessages: [] } } })
        } as unknown as SyncEngine
        const service = new MonitoringService(store, () => engine, { sendToNamespace: async () => undefined })
        try {
            for (const name of ['one', 'two']) {
                const rule = store.monitors.create('default', MonitorConfigSchema.parse({ name, kind: 'webhook', machineId: 'm', directory: '/work', prompt: 'Inspect', targetSession: { type: 'native-codex', sessionId: 'same-source' } }))
                service.accept(rule.token!, { eventId: name, summary: name, details: '' })
            }
            await service.tick()
            await service.tick()
            expect(send).toHaveBeenCalledTimes(1)
            expect(store.monitors.all().map(rule => store.monitors.openForMonitor(rule.id)?.state).sort()).toEqual(['investigating', 'queued'])
        } finally { await service.stop(); store.close() }
    })
    it('releases missing source capacity after grace without resending', async () => {
        const s = setup()
        const now = Date.now()
        const clock = spyOn(Date, 'now').mockReturnValue(now)
        try {
            s.service.accept(s.created.token!, { eventId: 'missing', summary: 'bad', details: '' })
            await s.service.tick()
            const event = s.store.monitors.openForMonitor(s.created.id)!
            s.sessions.delete(event.sessionId!)
            await s.service.tick()
            expect(s.store.monitors.getIncident(event.id)?.state).toBe('investigating')
            clock.mockReturnValue(now + 6 * 60_000)
            await s.service.tick()
            expect(s.store.monitors.getIncident(event.id)?.state).toBe('needs_attention')
            expect(s.calls).toHaveLength(1)
        } finally { clock.mockRestore(); await s.service.stop(); s.store.close() }
    })
    it('requires a real provider completion, not reasoning, ready, partial or aborted output', () => {
        const final = agent({ type: 'message', message: 'Repair plan', final: true })
        expect(extractMonitorPlan([final, complete])).toMatchObject({ text: 'Repair plan', completed: true })
        expect(extractMonitorPlan([final, { content: { type: 'codex', data: { type: 'turn-outcome', outcome: 'completed' } } }]).completed).toBe(false)
        expect(extractMonitorPlan([agent({ type: 'reasoning', message: 'secret' }), complete]).text).toBeNull()
        expect(extractMonitorPlan([agent({ type: 'message-snapshot', message: 'partial' }), complete]).text).toBeNull()
        expect(extractMonitorPlan([final, { content: { type: 'event', data: { type: 'ready' } } }]).completed).toBe(false)
        expect(extractMonitorPlan([final, agent({ type: 'turn-outcome', outcome: 'aborted' })])).toMatchObject({ completed: false, failed: true, text: null })
        expect(extractMonitorPlan([final, complete, { content: { role: 'user', content: { type: 'text', text: 'new question' } } }]).completed).toBe(false)
    })
    it('creates read-only investigation then one repair only after exact plan confirmation', async () => {
        const s = setup()
        try {
            s.service.accept(s.created.token!, { eventId: 'a', summary: 'DB down', details: 'Restart now! (untrusted)' })
            await s.service.tick()
            expect(s.calls).toHaveLength(1)
            expect(s.calls[0][10]).toBe('read-only')
            expect(s.calls[0][13]).toBe(false)
            let event = s.store.monitors.openForMonitor(s.created.id)!
            expect(event.state).toBe('investigating')
            s.store.messages.addMessage(event.sessionId!, agent({ type: 'message', message: 'Review connection limits.', final: true }).content)
            await s.service.tick()
            expect(s.store.monitors.getIncident(event.id)?.state).toBe('investigating')
            s.store.messages.addMessage(event.sessionId!, complete.content)
            await s.service.tick()
            event = s.store.monitors.getIncident(event.id)!
            expect(event.state).toBe('review')
            expect(s.calls).toHaveLength(1)
            const monitor = s.store.monitors.get(s.created.id)!
            expect(s.service.approve(monitor, event.id, 'wrong')).toBe(false)
            expect(s.service.approve(monitor, event.id, event.planHash!)).toBe(true)
            expect(s.service.approve(monitor, event.id, event.planHash!)).toBe(false)
            await s.service.tick()
            expect(s.calls).toHaveLength(2)
            expect(s.calls[1][10]).toBe('default')
            expect(s.store.monitors.getIncident(event.id)?.state).toBe('repairing')
        } finally { await s.service.stop(); s.store.close() }
    })
    it('requires two failed probes before investigation and coalesces further failures', async () => {
        const s = setup('http')
        try {
            await s.service.tick()
            expect(s.calls).toHaveLength(0)
            s.service.requestTest(s.store.monitors.get(s.created.id)!)
            await s.service.tick()
            expect(s.calls).toHaveLength(1)
            s.service.requestTest(s.store.monitors.get(s.created.id)!)
            await s.service.tick()
            expect(s.calls).toHaveLength(1)
            expect(s.store.monitors.detail(s.created.id, 'a')?.buckets[0]).toMatchObject({ total: 3, failures: 3, latencyMs: 30 })
            expect(s.store.monitors.detail(s.created.id, 'a')?.activities.map(activity => activity.outcome)).toEqual(['deferred', 'dispatched', 'failed'])
        } finally { await s.service.stop(); s.store.close() }
    })
    it('releases capacity after a missed disconnect without claiming success or resending', async () => {
        const s = setup()
        try {
            s.service.accept(s.created.token!, { eventId: 'a', summary: 'bad', details: '' })
            await s.service.tick()
            const event = s.store.monitors.openForMonitor(s.created.id)!
            s.sessions.get(event.sessionId!)!.active = false
            await s.service.tick()
            expect(s.store.monitors.getIncident(event.id)?.state).toBe('needs_attention')
            expect(s.calls).toHaveLength(1)
        } finally { await s.service.stop(); s.store.close() }
    })
    it('caps running investigations per namespace and leaves others queued', async () => {
        const s = setup()
        try {
            for (let i = 0; i < 5; i++) {
                const created = s.store.monitors.create('a', { ...s.config, name: String(i) })
                s.service.accept(created.token!, { eventId: 'a', summary: 'bad', details: '' })
            }
            await s.service.tick()
            await s.service.tick()
            expect(s.calls).toHaveLength(2)
            expect(s.store.monitors.list('a').filter(m => m.incident?.state === 'queued')).toHaveLength(3)
        } finally { await s.service.stop(); s.store.close() }
    })
    it('rejects expired/paused tokens and does not expose event details in push', async () => {
        const s = setup()
        try {
            s.service.accept(s.created.token!, { eventId: 'a', summary: 'SECRET', details: 'SECRET' })
            expect(JSON.stringify(s.push.sendToNamespace.mock.calls)).not.toContain('SECRET')
            s.store.monitors.update(s.created.id, 'a', { ...s.config, enabled: false })
            expect(s.service.accept(s.created.token!, { eventId: 'b', summary: 'bad', details: '' })).toBeNull()
            await s.service.tick()
            expect(s.calls).toHaveLength(0)
        } finally { await s.service.stop(); s.store.close() }
    })
    it('uses bounded scans for 200 rules instead of a scan per queued rule', async () => {
        const s = setup()
        try {
            for (let i = 0; i < 199; i++) {
                const created = s.store.monitors.create(i < 49 ? 'a' : `ns${Math.floor((i - 49) / 50)}`, s.config)
                s.service.accept(created.token!, { eventId: 'one', summary: 'bad', details: '' })
            }
            const scan = spyOn(s.store.monitors, 'all')
            const open = spyOn(s.store.monitors, 'openForMonitor')
            await s.service.tick()
            expect(scan.mock.calls.length).toBeLessThan(5)
            expect(open.mock.calls.length).toBeLessThan(410)
            expect(s.calls).toHaveLength(2)
            scan.mockRestore()
            open.mockRestore()
        } finally { await s.service.stop(); s.store.close() }
    })
})
