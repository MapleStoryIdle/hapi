import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from '../../store'
import type { Machine, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createCodexDesktopRoutes, importSelectedCodexSessions } from './codexDesktop'

const originalCodexHome = process.env.CODEX_HOME
const originalHapiHostname = process.env.HAPI_HOSTNAME

function createTranscript(codexHome: string, sessionId: string, cwd = 'C:\\work\\project'): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '04')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, `rollout-${sessionId}.jsonl`)
    const lines = [
        {
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd,
                originator: 'codex_cli_rs',
                cli_version: '0.0.0-test'
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'developer instruction that must stay hidden' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace/project\n\n<INSTRUCTIONS>Injected context</INSTRUCTIONS>' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'normal user message' }]
            }
        },
        {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'normal assistant message' }]
            }
        }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

/** 标准 rollout 会同时有 event_msg 与 response_item；导入必须只保留一份聊天正文。 */
function createDuplicatedChatTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '06', '05')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, `rollout-${sessionId}.jsonl`)
    const lines = [
        { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
        // User copies occur response_item then event_msg; assistant copies are
        // written in the opposite order by the current Codex CLI.
        { timestamp: '2026-06-05T10:00:00.499Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate user message' }] } },
        { timestamp: '2026-06-05T10:00:00.501Z', type: 'event_msg', payload: { type: 'user_message', message: 'duplicate user message' } },
        { timestamp: '2026-06-05T10:00:01.001Z', type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate assistant message' } },
        { timestamp: '2026-06-05T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'duplicate assistant message' }] } },
        // A second real turn with the same text must remain visible.
        { timestamp: '2026-06-05T10:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate user message' }] } },
        { timestamp: '2026-06-05T10:01:00.001Z', type: 'event_msg', payload: { type: 'user_message', message: 'duplicate user message' } },
        { timestamp: '2026-06-05T10:01:01.001Z', type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate assistant message' } },
        { timestamp: '2026-06-05T10:01:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'duplicate assistant message' }] } }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

function createScaffoldedChatTranscript(codexHome: string, sessionId: string): void {
    const sessionDir = join(codexHome, 'sessions', '2026', '08', '31')
    mkdirSync(sessionDir, { recursive: true })
    const transcriptPath = join(sessionDir, `rollout-${sessionId}.jsonl`)
    const wrapper = [
        '# Files mentioned by the user:',
        '## brief.txt: /private/generated/brief.txt',
        '## My request:',
        'Summarize the attachment.'
    ].join('\n')
    const lines = [
        { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
        {
            timestamp: '2026-08-31T10:00:00.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '<goal_context>internal</goal_context>' }]
            }
        },
        {
            timestamp: '2026-08-31T10:00:01.000Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapper }] }
        },
        {
            timestamp: '2026-08-31T10:00:01.001Z',
            type: 'event_msg',
            payload: { type: 'user_message', message: wrapper }
        },
        {
            timestamp: '2026-08-31T10:00:02.000Z',
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'The Files mentioned marker is generated context.' }]
            }
        }
    ]
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
}

function createMachine(id: string, workspaceRoots: string[], namespace = 'default', codexHome?: string): Machine {
    return {
        id,
        namespace,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            host: id,
            platform: 'linux',
            happyCliVersion: '0.0.0-test',
            workspaceRoots,
            ...(codexHome ? { codexHome } : {})
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 1
    }
}

function createRunnerLocalSessionData(sessionId: string, cwd = '/runner/workspace/project') {
    return {
        tokenUsage: { input: 100, output: 20, cachedInput: 80, reasoningOutput: 10, total: 120, scope: 'session' as const, updatedAt: 1 },
        modelProvider: 'openai',
        session: {
            id: sessionId,
            title: 'Runner-local Codex task',
            lastUserMessage: 'runner-local prompt',
            cwd,
            file: `/runner/.codex/sessions/rollout-${sessionId}.jsonl`,
            modifiedAt: Date.now()
        },
        context: [
            { role: 'user' as const, text: 'runner-local prompt' },
            { role: 'assistant' as const, text: 'runner-local answer' }
        ],
        startIndex: 0,
        page: { limit: 50, nextBefore: null, hasMore: false },
        importedMessages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: 'runner-local prompt' },
                meta: { sentFrom: 'cli' as const }
            },
            {
                role: 'agent' as const,
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'message', message: 'runner-local answer', id: 'runner-message' }
                },
                meta: { sentFrom: 'cli' as const }
            }
        ]
    }
}

function createImportSyncEngine(store: Store, machines: Machine[]): SyncEngine {
    return {
        getOnlineMachinesByNamespace: (namespace: string) => machines.filter((machine) => (
            machine.namespace === namespace && machine.active
        )),
        getSessionsByNamespace: (namespace: string) => (
            store.sessions.getSessionsByNamespace(namespace) as unknown as ReturnType<SyncEngine['getSessionsByNamespace']>
        ),
        getOrCreateSession: (
            tag: string,
            metadata: unknown,
            agentState: unknown,
            namespace: string
        ) => (
            store.sessions.getOrCreateSession(tag, metadata, agentState, namespace) as unknown as ReturnType<SyncEngine['getOrCreateSession']>
        ),
        handleRealtimeEvent: () => {},
        recordSessionActivity: (sessionId: string, updatedAt: number) => {
            store.sessions.touchSessionUpdatedAt(sessionId, updatedAt, 'default')
        }
    } as unknown as SyncEngine
}

function createRoutesApp(namespace: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createCodexDesktopRoutes({
        store: new Store(':memory:'),
        getSyncEngine: () => null
    }))
    return app
}

function createRoutesAppWithEngine(namespace: string, store: Store, engine: SyncEngine): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createCodexDesktopRoutes({
        store,
        getSyncEngine: () => engine
    }))
    return app
}

describe('Codex Desktop import routes', () => {
    afterEach(() => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }
        if (originalHapiHostname === undefined) {
            delete process.env.HAPI_HOSTNAME
        } else {
            process.env.HAPI_HOSTNAME = originalHapiHostname
        }
    })

    it('imports normal response_item chat messages', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '11111111-1111-4111-8111-111111111111'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session).toBeDefined()
            const messages = store.messages.getAllMessages(session.id)
            expect(messages).toHaveLength(2)
            expect(messages[0].content).toEqual({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'normal user message'
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
            expect(messages[1].content).toEqual({
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        message: 'normal assistant message',
                        id: expect.any(String)
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('deduplicates event_msg chat copies when response_item records exist', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-dedup-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '88888888-8888-4888-8888-888888888888'
        process.env.CODEX_HOME = codexHome

        try {
            createDuplicatedChatTranscript(codexHome, codexSessionId)
            const app = createRoutesApp('default')
            const contextResponse = await app.request(`/api/codex/sessions/${codexSessionId}/context`)
            const context = await contextResponse.json() as {
                messages: Array<{ id: string; createdAt: number; position: number; content: { role: string; content: unknown } }>
            }
            expect(context.messages.map(({ content }) => content)).toMatchObject([
                { role: 'user', content: { type: 'text', text: 'duplicate user message' } },
                { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: 'duplicate assistant message' } } },
                { role: 'user', content: { type: 'text', text: 'duplicate user message' } },
                { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', message: 'duplicate assistant message' } } }
            ])
            expect(context.messages.map(({ id, createdAt, position }) => ({ id, createdAt, position }))).toEqual([
                { id: `codex-local:${codexSessionId}:0`, createdAt: Date.parse('2026-06-05T10:00:00.499Z'), position: 0 },
                { id: `codex-local:${codexSessionId}:1`, createdAt: Date.parse('2026-06-05T10:00:01.000Z'), position: 1 },
                { id: `codex-local:${codexSessionId}:2`, createdAt: Date.parse('2026-06-05T10:01:00.000Z'), position: 2 },
                { id: `codex-local:${codexSessionId}:3`, createdAt: Date.parse('2026-06-05T10:01:01.000Z'), position: 3 }
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })
            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(store.messages.getAllMessages(session.id)).toHaveLength(4)
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('normalizes Codex-owned user scaffolding in the host-local parser', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-scaffold-test-'))
        const codexSessionId = '14141414-1414-4414-8414-141414141414'
        process.env.CODEX_HOME = codexHome

        try {
            createScaffoldedChatTranscript(codexHome, codexSessionId)
            const app = createRoutesApp('default')
            const response = await app.request(`/api/codex/sessions/${codexSessionId}/context`)
            const body = await response.json() as {
                session: { title: string }
                messages: Array<{ content: { role: string; content: { text?: string; data?: { message?: string } } } }>
            }

            expect(response.status).toBe(200)
            expect(body.session.title).toBe('Summarize the attachment.')
            expect(body.messages.map((message) => message.content)).toMatchObject([
                { role: 'user', content: { text: 'Summarize the attachment.' } },
                { role: 'agent', content: { data: { message: 'The Files mentioned marker is generated context.' } } }
            ])
            expect(JSON.stringify(body)).not.toContain('/private/generated/brief.txt')
            expect(JSON.stringify(body)).not.toContain('<goal_context>')
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('reuses a previously imported session whose stored user message still has the raw scaffold', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-legacy-scaffold-reconcile-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '16161616-1616-4616-8616-161616161616'
        const rawWrapper = [
            '# Files mentioned by the user:',
            '## brief.txt: /private/generated/brief.txt',
            '## My request:',
            'Summarize the attachment.'
        ].join('\n')
        process.env.CODEX_HOME = codexHome

        try {
            createScaffoldedChatTranscript(codexHome, codexSessionId)
            const existing = store.sessions.getOrCreateSession('legacy-scaffold-session', {
                path: '/workspace/project',
                flavor: 'codex',
                codexSessionId
            }, {}, 'default')
            store.messages.addMessage(existing.id, {
                role: 'user',
                content: { type: 'text', text: '<goal_context>internal</goal_context>' },
                meta: { sentFrom: 'cli' }
            })
            store.messages.addMessage(existing.id, {
                role: 'user',
                content: { type: 'text', text: rawWrapper },
                meta: { sentFrom: 'cli' }
            })
            store.messages.addMessage(existing.id, {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'message',
                        message: 'The Files mentioned marker is generated context.',
                        id: 'legacy-assistant-message'
                    }
                },
                meta: { sentFrom: 'cli' }
            })

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => null
            })

            expect(result.success).toBe(true)
            expect(result.output).toContain(`SHAPI session: ${existing.id}`)
            expect(result.output).toContain('Action: updated')
            expect(result.output).toContain('Appended messages: 0')
            expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
            expect(store.messages.getAllMessages(existing.id)).toHaveLength(3)
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('binds imported transcripts to the unique online machine that owns the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '22222222-2222-4222-8222-222222222222'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/workspace']),
                createMachine('machine-2', ['/other/workspace'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-1'
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('does not bind imported transcripts when multiple online machines own the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-ambiguous-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '33333333-3333-4333-8333-333333333333'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/workspace']),
                createMachine('machine-2', ['/home/user/workspace/project'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project'
            })
            expect(session.metadata).not.toHaveProperty('machineId')
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('does not bind imported transcripts when no online machine owns the cwd', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-miss-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '44444444-4444-4444-8444-444444444444'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-1', ['/home/user/other'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project'
            })
            expect(session.metadata).not.toHaveProperty('machineId')
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('keeps an existing machineId when updating an imported transcript', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-machine-existing-test-'))
        const store = new Store(':memory:')
        const codexSessionId = '55555555-5555-4555-8555-555555555555'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            store.sessions.getOrCreateSession(randomUUID(), {
                path: '/home/user/workspace/project',
                flavor: 'codex',
                codexSessionId,
                machineId: 'machine-existing'
            }, {}, 'default')
            const engine = createImportSyncEngine(store, [
                createMachine('machine-new', ['/home/user/workspace'])
            ])

            const result = await importSelectedCodexSessions({
                codexSessionIds: [codexSessionId],
                store,
                namespace: 'default',
                getSyncEngine: () => engine
            })

            expect(result.success).toBe(true)
            const session = store.sessions.getSessionsByNamespace('default')[0]
            expect(session.metadata).toMatchObject({
                path: '/home/user/workspace/project',
                machineId: 'machine-existing'
            })
        } finally {
            store.close()
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('rejects hub-local Codex transcripts outside the default namespace', async () => {
        const app = createRoutesApp('team-a')
        const response = await app.request('/api/codex/sessions')

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
            success: false,
            error: 'Codex transcript import is not available outside the default namespace'
        })
    })

    it('lists runner-owned Codex transcripts inside a non-default workspace', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('team-runner', ['/runner/workspace'], 'team-a', '/runner/.codex')
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            listCodexLocalSessions: async () => ({
                success: true,
                sessions: [createRunnerLocalSessionData('native-thread').session]
            })
        } as unknown as SyncEngine

        try {
            const response = await createRoutesAppWithEngine('team-a', store, engine)
                .request('/api/codex/sessions?machineId=team-runner')

            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                success: true,
                sessions: [{ id: 'native-thread' }]
            })
        } finally {
            store.close()
        }
    })

    it('allows Codex transcript endpoints in the default namespace', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-home-route-test-'))
        process.env.CODEX_HOME = codexHome

        try {
            const app = createRoutesApp('default')
            const response = await app.request('/api/codex/sessions')

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                success: true,
                sessions: []
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('returns only the requested newest recent Codex sessions', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-recent-limit-test-'))
        const sessionIds = Array.from({ length: 6 }, (_, index) => (
            `99999999-9999-4999-8999-${String(index + 1).padStart(12, '0')}`
        ))
        process.env.CODEX_HOME = codexHome

        try {
            for (const [index, sessionId] of sessionIds.entries()) {
                createTranscript(codexHome, sessionId)
                const transcriptPath = join(codexHome, 'sessions', '2026', '06', '04', `rollout-${sessionId}.jsonl`)
                const modifiedAt = new Date(Date.UTC(2026, 5, 4, 12, index, 0))
                utimesSync(transcriptPath, modifiedAt, modifiedAt)
            }

            const app = createRoutesApp('default')
            const response = await app.request('/api/codex/sessions?limit=5')
            const body = await response.json() as { sessions: Array<{ id: string }> }
            expect(response.status).toBe(200)
            expect(body.sessions.map((session) => session.id)).toEqual(sessionIds.slice(1).reverse())
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('includes the native processing state in the host-local session list', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-run-state-route-test-'))
        const codexSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId)
            const transcriptPath = join(codexHome, 'sessions', '2026', '06', '04', `rollout-${codexSessionId}.jsonl`)
            writeFileSync(transcriptPath, `${JSON.stringify({
                type: 'event_msg',
                payload: { type: 'task_started' }
            })}\n`, { encoding: 'utf-8', flag: 'a' })

            const app = createRoutesApp('default')
            const response = await app.request('/api/codex/sessions?limit=5')

            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                success: true,
                sessions: [{ id: codexSessionId, runState: 'processing' }]
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('returns displayable context for a recent local Codex session', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-context-test-'))
        const codexSessionId = '55555555-5555-4555-8555-555555555555'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const app = createRoutesApp('default')
            const response = await app.request(`/api/codex/sessions/${codexSessionId}/context?limit=1`)

            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                success: true,
                session: {
                    id: codexSessionId,
                    cwd: '/home/user/workspace/project'
                },
                messages: [
                    {
                        id: `codex-local:${codexSessionId}:1`,
                        createdAt: expect.any(Number),
                        position: 1,
                        content: {
                            role: 'agent',
                            content: {
                                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                                data: { type: 'message', message: 'normal assistant message' }
                            }
                        }
                    }
                ],
                page: { limit: 1, nextBefore: 1, hasMore: true }
            })

            const olderResponse = await app.request(`/api/codex/sessions/${codexSessionId}/context?limit=1&before=1`)
            expect(olderResponse.status).toBe(200)
            expect(await olderResponse.json()).toMatchObject({
                success: true,
                messages: [
                    {
                        id: `codex-local:${codexSessionId}:0`,
                        createdAt: expect.any(Number),
                        position: 0,
                        content: {
                            role: 'user',
                            content: { type: 'text', text: 'normal user message' }
                        }
                    }
                ],
                page: { limit: 1, nextBefore: null, hasMore: false }
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('returns native context compaction as an independent context event', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-context-compact-route-test-'))
        const codexSessionId = '45454545-4545-4545-8545-454545454545'
        process.env.CODEX_HOME = codexHome

        try {
            createTranscript(codexHome, codexSessionId, '/home/user/workspace/project')
            const transcriptPath = join(codexHome, 'sessions', '2026', '06', '04', `rollout-${codexSessionId}.jsonl`)
            writeFileSync(transcriptPath, `${JSON.stringify({
                timestamp: '2026-06-04T12:00:00.000Z',
                type: 'event_msg',
                payload: { type: 'context_compacted' }
            })}\n`, { encoding: 'utf-8', flag: 'a' })

            const app = createRoutesApp('default')
            const response = await app.request(`/api/codex/sessions/${codexSessionId}/context?limit=1`)

            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({
                success: true,
                messages: [{
                    id: `codex-local:${codexSessionId}:2`,
                    createdAt: Date.parse('2026-06-04T12:00:00.000Z'),
                    position: 2,
                    content: {
                        role: 'agent',
                        content: {
                            type: AGENT_MESSAGE_PAYLOAD_TYPE,
                            data: { type: 'context_compacted' }
                        }
                    }
                }]
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('returns native custom exec calls through the host-local context route', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-custom-tool-route-test-'))
        const codexSessionId = '77777777-7777-4777-8777-777777777777'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '26')
        mkdirSync(sessionDir, { recursive: true })
        const transcriptPath = join(sessionDir, `rollout-${codexSessionId}.jsonl`)
        const records = [
            { type: 'session_meta', payload: { id: codexSessionId, cwd: '/workspace/project' } },
            {
                timestamp: '2026-08-26T09:59:59.000Z',
                type: 'turn_context',
                payload: { model: 'gpt-5.6-terra', effort: 'high' }
            },
            {
                timestamp: '2026-08-26T10:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'inspect the project' }]
                }
            },
            {
                timestamp: '2026-08-26T10:00:01.000Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call',
                    call_id: 'call-route-terminal',
                    name: 'exec',
                    input: 'pwd',
                    status: 'completed'
                }
            },
            {
                timestamp: '2026-08-26T10:00:01.500Z',
                type: 'response_item',
                payload: {
                    type: 'custom_tool_call_output',
                    call_id: 'call-route-terminal',
                    output: [{
                        type: 'input_text',
                        text: JSON.stringify({
                            output: '/workspace/project',
                            metadata: { exit_code: 0, duration_seconds: 0.5 }
                        })
                    }]
                }
            }
        ]
        writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const app = createRoutesApp('default')
            const response = await app.request(`/api/codex/sessions/${codexSessionId}/context?limit=10`)
            const body = await response.json() as {
                session?: { model?: string | null; modelReasoningEffort?: string | null }
                messages: Array<{ content: { role: string; content: { data?: Record<string, unknown> } } }>
            }

            expect(response.status).toBe(200)
            expect(body).toMatchObject({
                session: {
                    model: 'gpt-5.6-terra',
                    modelReasoningEffort: 'high'
                }
            })
            const toolCall = body.messages.find((message) => message.content.content.data?.type === 'tool-call')
            const toolResult = body.messages.find((message) => message.content.content.data?.type === 'tool-call-result')
            expect(toolCall?.content.content.data).toMatchObject({
                name: 'CodexBash',
                callId: 'call-route-terminal',
                input: { command: 'pwd' }
            })
            expect(toolResult?.content.content.data).toMatchObject({
                callId: 'call-route-terminal',
                durationMs: 500,
                output: {
                    stdout: '/workspace/project',
                    exit_code: 0,
                    is_error: false,
                    durationMs: 500
                }
            })
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })

    it('reads recent sessions and context through the selected runner RPC', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const sessionId = '12121212-1212-4212-8212-121212121212'
        const data = {
            ...createRunnerLocalSessionData(sessionId),
            session: {
                ...createRunnerLocalSessionData(sessionId).session,
                runState: 'processing' as const
            }
        }
        const listCalls: unknown[][] = []
        const readCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            listCodexLocalSessions: async (...args: unknown[]) => {
                listCalls.push(args)
                return { success: true as const, sessions: [data.session] }
            },
            readCodexLocalSession: async (...args: unknown[]) => {
                readCalls.push(args)
                return { success: true as const, data }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const listResponse = await app.request('/api/codex/sessions?machineId=mac-runner')
            expect(listResponse.status).toBe(200)
            expect(await listResponse.json()).toMatchObject({
                success: true,
                sessions: [{ id: sessionId, title: 'Runner-local Codex task', runState: 'processing' }]
            })
            expect(listCalls).toEqual([['mac-runner', 5]])

            const forcedListResponse = await app.request('/api/codex/sessions?machineId=mac-runner&forceRefresh=true')
            expect(forcedListResponse.status).toBe(200)
            expect(listCalls).toEqual([
                ['mac-runner', 5],
                ['mac-runner', 5, { forceRefresh: true }]
            ])

            const contextResponse = await app.request(`/api/codex/sessions/${sessionId}/context?machineId=mac-runner`)
            expect(contextResponse.status).toBe(200)
            expect(await contextResponse.json()).toMatchObject({
                success: true,
                session: { id: sessionId, cwd: '/runner/workspace/project' },
                messages: [
                    {
                        id: `codex-local:${sessionId}:0`,
                        createdAt: data.session.modifiedAt,
                        position: 0,
                        content: data.importedMessages[0]
                    },
                    {
                        id: `codex-local:${sessionId}:1`,
                        createdAt: data.session.modifiedAt,
                        position: 1,
                        content: data.importedMessages[1]
                    }
                ]
            })
            expect(readCalls).toEqual([['mac-runner', sessionId, { limit: 50 }]])
        } finally {
            store.close()
        }
    })

    it('scopes native file browsing to the transcript cwd and owning namespace', async () => {
        const store = new Store(':memory:')
        const sessionId = '15151515-1515-4515-8515-151515151515'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const calls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSession: async () => ({ success: true, data: createRunnerLocalSessionData(sessionId) }),
            browseSessionFiles: async (...args: unknown[]) => { calls.push(args); return { success: true, entries: [] } }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)
        const request = (body: unknown) => app.request(`/api/codex/sessions/${sessionId}/files?machineId=mac-runner`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        })
        try {
            expect((await request({ action: 'directory', path: 'src' })).status).toBe(200)
            expect(calls).toEqual([['mac-runner', '/runner/workspace/project', { action: 'directory', path: 'src' }]])
            expect((await request({ action: 'directory', cwd: '/private' })).status).toBe(400)
            const other = createRoutesAppWithEngine('other', store, engine)
            expect((await other.request(`/api/codex/sessions/${sessionId}/files?machineId=mac-runner`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'directory' })
            })).status).not.toBe(200)
            expect(calls).toHaveLength(1)
        } finally { store.close() }
    })

    it('reads a native transcript file through its owning runner', async () => {
        const store = new Store(':memory:')
        const sessionId = '15151515-1515-4515-8515-151515151515'
        const data = createRunnerLocalSessionData(sessionId)
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const transcriptCalls: unknown[][] = []
        const fileCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSession: async (...args: unknown[]) => {
                transcriptCalls.push(args)
                return { success: true as const, data }
            },
            readMachineFile: async (...args: unknown[]) => {
                fileCalls.push(args)
                return { success: true as const, content: 'Y29uc3QgbmF0aXZlID0gdHJ1ZQo=' }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/file?machineId=mac-runner&path=web%2Fsrc%2Frouter.tsx`)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                success: true,
                content: 'Y29uc3QgbmF0aXZlID0gdHJ1ZQo='
            })
            expect(transcriptCalls).toEqual([['mac-runner', sessionId, { limit: 1 }]])
            expect(fileCalls).toEqual([['mac-runner', '/runner/workspace/project', 'web/src/router.tsx']])
        } finally {
            store.close()
        }
    })

    it('returns context and lifecycle from one selected-runner snapshot RPC', async () => {
        const store = new Store(':memory:')
        const sessionId = '13131313-1313-4313-8313-131313131313'
        const data = {
            ...createRunnerLocalSessionData(sessionId),
            subagents: [{
                id: 'native-child-1',
                parentSessionId: sessionId,
                name: 'Ada',
                model: 'gpt-5.6-terra',
                modelReasoningEffort: 'high',
                status: 'running' as const,
                statusText: 'Working',
                startedAt: 100,
                updatedAt: 101,
                traceMessages: []
            }]
        }
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const snapshotCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSessionSnapshot: async (...args: unknown[]) => {
                snapshotCalls.push(args)
                const options = args[2] as { knownVersion?: { runnerEpoch: string; revision: number } } | undefined
                if (options?.knownVersion) {
                    return {
                        success: true as const,
                        unchanged: true as const,
                        version: options.knownVersion,
                        revision: options.knownVersion.revision,
                        session: {
                            id: sessionId,
                            title: 'Renamed native task',
                            cwd: '/runner/workspace/project',
                            modifiedAt: 123,
                            file: '/must/not/reach/web.jsonl'
                        },
                        status: {
                            success: true as const,
                            status: 'processing' as const,
                            queuedMessages: [{ id: 'queued-1', text: 'next', queuedAt: 42 }]
                        },
                        timing: { cache: 'hit' as const, durationMs: 1 }
                    }
                }
                return {
                    success: true as const,
                    unchanged: false as const,
                    snapshot: {
                        data,
                        status: {
                            success: true as const,
                            status: 'processing' as const,
                            activeTurnId: 'turn-plan',
                            queuedMessages: [{ id: 'queued-1', text: 'next', queuedAt: 42 }]
                        },
                        plan: {
                            turnId: 'turn-plan',
                            callId: 'call-plan',
                            steps: [{ text: 'Render the native plan', status: 'in_progress' as const }]
                        },
                        version: { runnerEpoch: 'runner-a', revision: 7 },
                        revision: 7,
                        timing: { cache: 'hit' as const, durationMs: 3 }
                    }
                }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/snapshot?machineId=mac-runner&limit=50`)
            expect(response.status).toBe(200)
            expect(response.headers.get('server-timing')).toBe('native-cache;desc=hit;dur=3')
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(await response.json()).toMatchObject({
                success: true,
                unchanged: false,
                version: { runnerEpoch: 'runner-a', revision: 7 },
                revision: 7,
                timing: { cache: 'hit', durationMs: 3 },
                tokenUsage: { input: 100, output: 20, cachedInput: 80, total: 120 },
                modelProvider: 'openai',
                status: {
                    success: true,
                    status: 'processing',
                    activeTurnId: 'turn-plan',
                    queuedMessages: [{ text: 'next' }]
                },
                plan: {
                    turnId: 'turn-plan',
                    callId: 'call-plan',
                    steps: [{ text: 'Render the native plan', status: 'in_progress' }]
                },
                session: { id: sessionId },
                subagents: [{
                    id: 'native-child-1',
                    name: 'Ada',
                    status: 'running',
                    model: 'gpt-5.6-terra',
                    modelReasoningEffort: 'high'
                }],
                messages: [
                    { id: `codex-local:${sessionId}:0`, content: data.importedMessages[0] },
                    { id: `codex-local:${sessionId}:1`, content: data.importedMessages[1] }
                ]
            })
            expect(snapshotCalls).toEqual([['mac-runner', sessionId, { limit: 50 }]])

            const unchangedResponse = await app.request(
                `/api/codex/sessions/${sessionId}/snapshot?machineId=mac-runner&limit=50&knownRunnerEpoch=runner-a&knownRevision=7`
            )
            expect(unchangedResponse.status).toBe(200)
            expect(unchangedResponse.headers.get('cache-control')).toBe('no-store')
            expect(await unchangedResponse.json()).toEqual({
                success: true,
                unchanged: true,
                version: { runnerEpoch: 'runner-a', revision: 7 },
                revision: 7,
                session: {
                    id: sessionId,
                    title: 'Renamed native task',
                    cwd: '/runner/workspace/project',
                    modifiedAt: 123,
                    controlledByCodexSsh: false
                },
                status: {
                    success: true,
                    status: 'processing',
                    queuedMessages: [{ id: 'queued-1', text: 'next', queuedAt: 42 }]
                },
                timing: { cache: 'hit', durationMs: 1 }
            })
            expect(snapshotCalls).toEqual([
                ['mac-runner', sessionId, { limit: 50 }],
                ['mac-runner', sessionId, {
                    limit: 50,
                    knownVersion: { runnerEpoch: 'runner-a', revision: 7 }
                }]
            ])
        } finally {
            store.close()
        }
    })

    it('marks an offline snapshot runner with a retryable stable code', async () => {
        const store = new Store(':memory:')
        const machine = {
            ...createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex'),
            active: false
        }
        const engine = createImportSyncEngine(store, [machine])
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(
                '/api/codex/sessions/56565656-5656-4656-8656-565656565656/snapshot?machineId=mac-runner&limit=50'
            )
            expect(response.status).toBe(409)
            expect(await response.json()).toEqual({
                success: false,
                error: 'Selected runner is not online',
                code: 'runner_offline'
            })
        } finally {
            store.close()
        }
    })

    it('starts a direct message on the exact runner-local native Codex thread', async () => {
        const store = new Store(':memory:')
        const sessionId = '56565656-5656-4656-8656-565656565656'
        const data = createRunnerLocalSessionData(sessionId, '/runner/.codex/worktrees/direct-thread')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const sendCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSession: async () => ({ success: true as const, data }),
            getCodexLocalSessionStatus: async () => ({ success: true as const, status: 'idle' as const }),
            sendCodexLocalSessionMessage: async (...args: unknown[]) => {
                sendCalls.push(args)
                return { success: true as const, status: 'processing' as const, startedAt: 123 }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const statusResponse = await app.request(`/api/codex/sessions/${sessionId}/status?machineId=mac-runner`)
            expect(statusResponse.status).toBe(200)
            expect(await statusResponse.json()).toEqual({ success: true, status: 'idle' })

            const sendResponse = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', message: 'Continue the original thread' })
            })
            expect(sendResponse.status).toBe(202)
            expect(await sendResponse.json()).toEqual({ success: true, status: 'processing', startedAt: 123 })
            expect(sendCalls).toEqual([[
                'mac-runner',
                sessionId,
                'Continue the original thread'
            ]])
        } finally {
            store.close()
        }
    })

    it('stages a native attachment on its selected Runner and forwards only its opaque id', async () => {
        const store = new Store(':memory:')
        const sessionId = '56565656-5656-4656-8656-565656565657'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const stageCalls: unknown[][] = []
        const sendCalls: unknown[][] = []
        const attachmentId = 'a'.repeat(32)
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            stageNativeCodexAttachment: async (...args: unknown[]) => {
                stageCalls.push(args)
                return {
                    success: true as const,
                    attachment: {
                        id: attachmentId,
                        filename: 'notes.md',
                        mimeType: 'text/markdown',
                        size: 5,
                        kind: 'file' as const
                    }
                }
            },
            sendCodexLocalSessionMessage: async (...args: unknown[]) => {
                sendCalls.push(args)
                return { success: true as const, status: 'processing' as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const form = new FormData()
            form.set('machineId', 'mac-runner')
            form.set('file', new Blob(['hello'], { type: 'text/markdown' }), 'notes.md')
            const upload = await app.request(`/api/codex/sessions/${sessionId}/uploads`, {
                method: 'POST', body: form
            })
            expect(upload.status).toBe(201)
            expect(await upload.json()).toEqual({
                success: true,
                attachment: {
                    id: attachmentId,
                    filename: 'notes.md',
                    mimeType: 'text/markdown',
                    size: 5,
                    kind: 'file'
                }
            })
            expect(stageCalls).toHaveLength(1)
            expect(stageCalls[0]?.[0]).toBe('mac-runner')
            expect(stageCalls[0]?.[1]).toMatchObject({
                codexSessionId: sessionId,
                filename: 'notes.md',
                mimeType: 'text/markdown',
                size: 5
            })

            const send = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', message: '', attachmentIds: [attachmentId] })
            })
            expect(send.status).toBe(202)
            expect(sendCalls).toEqual([[
                'mac-runner',
                sessionId,
                'Please review the attached file.',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [attachmentId]
            ]])
        } finally {
            store.close()
        }
    })

    it('routes validated native control actions only to their owning runner', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const calls: unknown[][] = []
        const controls = { canStop: false, canConfigure: true, queuePaused: true, configuration: {} }
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            controlCodexLocalSession: async (...args: unknown[]) => {
                calls.push(args)
                return { success: true, controls }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)
        try {
            for (const action of [
                { action: 'stop', expectedTurnId: 'active-turn' },
                { action: 'answerUserInput', expectedTurnId: 'active-turn', requestId: 'question-1', answers: { choice: { answers: ['Continue'] } } },
                { action: 'configure', configuration: { model: 'gpt-5.6-terra', modelReasoningEffort: 'high', serviceTier: 'fast' } },
                { action: 'resumeQueue' }
            ]) {
                const response = await app.request('/api/codex/sessions/native-thread/control', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ machineId: 'mac-runner', ...action })
                })
                expect(response.status).toBe(200)
                expect(await response.json()).toEqual({ success: true, controls })
                expect(calls.at(-1)).toEqual(['mac-runner', 'native-thread', action])
            }
            const before = calls.length
            for (const body of [null, { machineId: 'mac-runner', action: 'stop' },
                { machineId: 'mac-runner', action: 'stop', expectedTurnId: 'a', kill: true },
                { machineId: 'mac-runner', action: 'configure', configuration: { cwd: '/' } },
                { machineId: 'mac-runner', action: 'configure', configuration: { serviceTier: 'turbo' } }]) {
                const response = await app.request('/api/codex/sessions/native-thread/control', {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
                })
                expect(response.status).toBe(400)
            }
            expect(calls.length).toBe(before)
        } finally { store.close() }
    })

    it('does not let an inactive historical wrapper block native control recovery', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const calls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [{
                id: 'historical-wrapper', namespace: 'default', active: false,
                metadata: { flavor: 'codex', machineId: 'mac-runner', codexSessionId: 'native-thread' }
            }],
            recoverCodexLocalSessionControl: async (...args: unknown[]) => {
                calls.push(args)
                return { success: true as const, status: 'pending' as const, recoveryRequestId: 'request-1' }
            }
        } as unknown as SyncEngine
        try {
            const response = await createRoutesAppWithEngine('default', store, engine).request('/api/codex/sessions/native-thread/recover-control', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', recoveryRequestId: 'request-1', expectedVersion: { runnerEpoch: 'runner-a', revision: 1 } })
            })
            expect(response.status).toBe(202)
            expect(calls).toEqual([['mac-runner', {
                sessionId: 'native-thread', recoveryRequestId: 'request-1', expectedVersion: { runnerEpoch: 'runner-a', revision: 1 }
            }]])
        } finally { store.close() }
    })

    it('maps a ready recovery only to the exact active managed session returned by the runner', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const stale = {
            id: 'stale-wrapper', namespace: 'default', active: false,
            metadata: { flavor: 'codex', machineId: 'mac-runner', codexSessionId: 'native-thread' }
        }
        const exact = {
            id: 'managed-exact', namespace: 'default', active: true,
            metadata: { flavor: 'codex', machineId: 'mac-runner', codexSessionId: 'native-thread' }
        }
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [stale, exact],
            getSession: (sessionId: string) => sessionId === exact.id ? exact : sessionId === stale.id ? stale : undefined,
            getCodexLocalSessionRecovery: async () => ({
                success: true as const,
                status: 'ready' as const,
                recoveryRequestId: 'request-1',
                sessionId: exact.id
            })
        } as unknown as SyncEngine
        try {
            const response = await createRoutesAppWithEngine('default', store, engine).request('/api/codex/sessions/native-thread/recover-control?machineId=mac-runner')
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ success: true, status: 'ready', sessionId: exact.id })
        } finally { store.close() }
    })

    it('refuses native control across namespaces and for a managed wrapper', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        let calls = 0
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [{ id: 'wrapper', namespace: 'default', active: true, metadata: {
                machineId: 'mac-runner', codexSessionId: 'native-thread', flavor: 'codex'
            } }],
            controlCodexLocalSession: async () => { calls++; return { success: true } }
        } as unknown as SyncEngine
        try {
            for (const namespace of ['default', 'other']) {
                const response = await createRoutesAppWithEngine(namespace, store, engine).request('/api/codex/sessions/native-thread/control', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ machineId: 'mac-runner', action: 'stop', expectedTurnId: 'active-turn' })
                })
                expect(response.status).toBe(409)
            }
            expect(calls).toBe(0)
        } finally { store.close() }
    })

    it('does not turn an ambiguous control RPC into a successful stop or retry it', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        let calls = 0
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            controlCodexLocalSession: async () => { calls++; throw new Error('socket disconnected') }
        } as unknown as SyncEngine
        try {
            const response = await createRoutesAppWithEngine('default', store, engine).request('/api/codex/sessions/native-thread/control', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', action: 'stop', expectedTurnId: 'active-turn' })
            })
            expect(response.status).toBe(502)
            expect(await response.json()).toMatchObject({ success: false, code: 'control_unconfirmed' })
            expect(calls).toBe(1)
        } finally { store.close() }
    })

    it('renames on the selected authorized runner and rejects invalid names and inaccessible runners', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const calls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            renameCodexLocalSession: async (...args: unknown[]) => {
                calls.push(args)
                return { success: true, name: args[2] }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)
        const rename = (name: unknown, machineId = 'mac-runner') => app.request('/api/codex/sessions/native-thread', {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machineId, name })
        })
        try {
            for (const name of ['', '  ', 'x'.repeat(256), 42, null]) expect((await rename(name)).status).toBe(400)
            expect((await rename('Name', 'unknown-runner')).status).toBe(409)
            expect(calls).toEqual([])
            const result = await rename('  新任务名称  ')
            expect(result.status).toBe(200)
            expect(await result.json()).toEqual({ success: true, name: '新任务名称' })
            expect(calls).toEqual([['mac-runner', 'native-thread', '新任务名称']])
        } finally { store.close() }
    })

    it('refuses native rename across namespaces and for a managed wrapper', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        let calls = 0
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [{ id: 'wrapper', namespace: 'default', active: true, metadata: {
                machineId: 'mac-runner', codexSessionId: 'native-thread', flavor: 'codex'
            } }],
            renameCodexLocalSession: async () => { calls++; return { success: true, name: 'New name' } }
        } as unknown as SyncEngine
        try {
            for (const namespace of ['default', 'other']) {
                const response = await createRoutesAppWithEngine(namespace, store, engine).request('/api/codex/sessions/native-thread', {
                    method: 'PATCH', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ machineId: 'mac-runner', name: 'New name' })
                })
                expect(response.status).toBe(409)
            }
            expect(calls).toBe(0)
        } finally { store.close() }
    })

    it('maps native rename failures without reporting success', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        try {
            for (const [code, status] of [['session_not_found', 404], ['rename_unsupported', 501], ['rename_failed', 502]] as const) {
                const engine = {
                    ...createImportSyncEngine(store, [machine]),
                    renameCodexLocalSession: async () => ({ success: false, code, error: code })
                } as unknown as SyncEngine
                const response = await createRoutesAppWithEngine('default', store, engine).request('/api/codex/sessions/native-thread', {
                    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machineId: machine.id, name: 'New name' })
                })
                expect(response.status).toBe(status)
                expect(await response.json()).toMatchObject({ success: false, code })
            }
        } finally { store.close() }
    })

    it('archives a native Codex thread on its owning runner', async () => {
        const store = new Store(':memory:')
        const sessionId = '56565656-5656-4656-8656-565656565657'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const archiveCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            archiveCodexLocalSession: async (...args: unknown[]) => {
                archiveCalls.push(args)
                return { success: true as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/archive`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner' })
            })
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ success: true })
            expect(archiveCalls).toEqual([['mac-runner', sessionId]])
        } finally {
            store.close()
        }
    })

    it('does not archive a native thread that is already managed by a differently keyed SHAPI session', async () => {
        const store = new Store(':memory:')
        const nativeSessionId = '56565656-5656-4656-8656-565656565658'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const archiveCalls: unknown[][] = []
        const managedSession = {
            id: 'hapi-wrapper-session',
            namespace: 'default',
            active: true,
            updatedAt: Date.now(),
            metadata: {
                machineId: 'mac-runner',
                codexSessionId: nativeSessionId,
                flavor: 'codex'
            }
        }
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [managedSession],
            archiveCodexLocalSession: async (...args: unknown[]) => {
                archiveCalls.push(args)
                return { success: true as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${nativeSessionId}/archive`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner' })
            })

            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({
                success: false,
                code: 'not_native_session'
            })
            expect(archiveCalls).toEqual([])
        } finally {
            store.close()
        }
    })

    it('maps native archive runner refusals to stable HTTP statuses', async () => {
        const cases: Array<{ code: string; status: number }> = [
            { code: 'session_busy', status: 409 },
            { code: 'session_status_unknown', status: 409 },
            { code: 'session_queued', status: 409 },
            { code: 'external_writer_active', status: 409 },
            { code: 'archive_unsupported', status: 501 },
            { code: 'archive_failed', status: 502 },
            { code: 'session_not_found', status: 404 }
        ]
        for (const testCase of cases) {
            const store = new Store(':memory:')
            const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
            const engine = {
                ...createImportSyncEngine(store, [machine]),
                archiveCodexLocalSession: async () => ({
                    success: false as const,
                    code: testCase.code,
                    error: `native ${testCase.code}`
                })
            } as unknown as SyncEngine
            const app = createRoutesAppWithEngine('default', store, engine)

            try {
                const response = await app.request('/api/codex/sessions/native-thread/archive', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ machineId: 'mac-runner' })
                })
                expect(response.status).toBe(testCase.status)
                expect(await response.json()).toMatchObject({ success: false, code: testCase.code })
            } finally {
                store.close()
            }
        }
    })

    it('returns native composer custom prompts and Skills from the selected runner', async () => {
        const store = new Store(':memory:')
        store.pluginSettings.setEnabled('default', 'managed-skill:public-share', true)
        const sessionId = '56565656-5656-4656-8656-565656565657'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const capabilityCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getCodexLocalSessionComposerCapabilities: async (...args: unknown[]) => {
                capabilityCalls.push(args)
                return {
                    success: true as const,
                    commands: [{ name: 'review', source: 'project' as const, content: 'Review the requested code.' }],
                    skills: [{ name: 'repo-rules', description: 'Repository rules', scope: 'project' as const }]
                }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(
                `/api/codex/sessions/${sessionId}/composer-capabilities?machineId=mac-runner`
            )
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                success: true,
                commands: [{ name: 'review', source: 'project', content: 'Review the requested code.' }],
                skills: [
                    { name: 'repo-rules', description: 'Repository rules', scope: 'project' },
                    {
                        name: 'public-share',
                        description: 'Create or revoke an expiring SHAPI public link, including feedback-enabled Kanban tasks.',
                        descriptions: { 'zh-CN': '通过限时链接分享文件或收集反馈。' },
                        scope: 'hub'
                    }
                ]
            })
            expect(capabilityCalls).toEqual([['mac-runner', sessionId]])
        } finally {
            store.close()
        }
    })

    it('passes an optional native display receipt separately from the delivered prompt', async () => {
        const store = new Store(':memory:')
        const sessionId = '56565656-5656-4656-8656-565656565658'
        const data = createRunnerLocalSessionData(sessionId, '/runner/.codex/worktrees/direct-thread')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const sendCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSession: async () => ({ success: true as const, data }),
            sendCodexLocalSessionMessage: async (...args: unknown[]) => {
                sendCalls.push(args)
                return { success: true as const, status: 'processing' as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    machineId: 'mac-runner',
                    message: 'Review the requested code.\n\nUser arguments: src/index.ts',
                    displayMessage: '/review src/index.ts',
                    clientMessageId: 'native:receipt-1'
                })
            })
            expect(response.status).toBe(202)
            expect(sendCalls).toEqual([[
                'mac-runner',
                sessionId,
                'Review the requested code.\n\nUser arguments: src/index.ts',
                '/review src/index.ts',
                'native:receipt-1'
            ]])
        } finally {
            store.close()
        }
    })

    it('forwards an explicit native recovery confirmation to the selected runner', async () => {
        const store = new Store(':memory:')
        const sessionId = '56565656-5656-4656-8656-565656565659'
        const data = createRunnerLocalSessionData(sessionId, '/runner/.codex/worktrees/recovery-thread')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const sendCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSession: async () => ({ success: true as const, data }),
            sendCodexLocalSessionMessage: async (...args: unknown[]) => {
                sendCalls.push(args)
                return { success: true as const, status: 'processing' as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    machineId: 'mac-runner',
                    message: 'Retry this saved message',
                    clientMessageId: 'native:recovery-1',
                    forceRecovery: true
                })
            })
            expect(response.status).toBe(202)
            expect(sendCalls).toEqual([[
                'mac-runner',
                sessionId,
                'Retry this saved message',
                undefined,
                'native:recovery-1',
                true
            ]])
        } finally {
            store.close()
        }
    })

    it('removes a saved native recovery receipt on the selected runner', async () => {
        const store = new Store(':memory:')
        const sessionId = '56565656-5656-4656-8656-565656565660'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const discardCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            discardCodexLocalSessionMessage: async (...args: unknown[]) => {
                discardCalls.push(args)
                return { success: true as const, discarded: true, queuedMessages: [] }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages/discard`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    machineId: 'mac-runner',
                    clientMessageId: 'native:recovery-1'
                })
            })
            expect(response.status).toBe(202)
            expect(await response.json()).toEqual({ success: true, discarded: true, queuedMessages: [] })
            expect(discardCalls).toEqual([['mac-runner', sessionId, 'native:recovery-1']])
        } finally {
            store.close()
        }
    })

    it('accepts a direct message while the native thread is processing and returns its queue position', async () => {
        const store = new Store(':memory:')
        const sessionId = '57565656-5756-4756-8756-575656565656'
        const data = createRunnerLocalSessionData(sessionId, '/runner/.codex/worktrees/queued-thread')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            readCodexLocalSession: async () => ({ success: true as const, data }),
            getCodexLocalSessionStatus: async () => ({ success: true as const, status: 'processing' as const }),
            sendCodexLocalSessionMessage: async () => ({
                success: true as const,
                status: 'queued' as const,
                queuedAt: 456,
                queuePosition: 1,
                queueId: 'queued-message-1',
                queuedMessages: [{ id: 'queued-message-1', text: 'Wait for the current turn', queuedAt: 456 }]
            })
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', message: 'Wait for the current turn' })
            })
            expect(response.status).toBe(202)
            expect(await response.json()).toMatchObject({
                success: true,
                status: 'queued',
                queuePosition: 1,
                queuedMessages: [{ text: 'Wait for the current turn' }]
            })
        } finally {
            store.close()
        }
    })

    it('lets the owning runner reject a SHAPI-initiated Codex thread without a preflight transcript read', async () => {
        const store = new Store(':memory:')
        const sessionId = '57575757-5757-4757-8757-575757575757'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        let sendCount = 0
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            sendCodexLocalSessionMessage: async () => {
                sendCount += 1
                return {
                    success: false as const,
                    code: 'not_native_session' as const,
                    error: 'Only original native Codex sessions support direct delivery'
                }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', message: 'Do not send' })
            })
            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({
                success: false,
                error: expect.stringContaining('original native')
            })
            expect(sendCount).toBe(1)
        } finally {
            store.close()
        }
    })

    it('routes a stale native-list SHAPI session through its existing SHAPI transport', async () => {
        const store = new Store(':memory:')
        const sessionId = '59575757-5757-4757-8757-575656565656'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const normalSendCalls: unknown[][] = []
        const nativeSendCalls: unknown[][] = []
        const managedSession = {
            id: 'hapi-managed-session',
            active: true,
            metadata: {
                machineId: 'mac-runner',
                codexSessionId: sessionId
            }
        }
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [managedSession],
            sendMessage: async (...args: unknown[]) => {
                normalSendCalls.push(args)
            },
            sendCodexLocalSessionMessage: async (...args: unknown[]) => {
                nativeSendCalls.push(args)
                return { success: true as const, status: 'processing' as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', message: 'Use the connected SHAPI session' })
            })
            expect(response.status).toBe(202)
            expect(await response.json()).toMatchObject({ success: true, status: 'processing' })
            expect(normalSendCalls).toEqual([[
                'hapi-managed-session',
                { text: 'Use the connected SHAPI session', sentFrom: 'webapp' }
            ]])
            expect(nativeSendCalls).toEqual([])
        } finally {
            store.close()
        }
    })

    it('sends a released SHAPI thread through the native transport', async () => {
        const store = new Store(':memory:')
        const sessionId = '59675757-5757-4757-8757-575656565656'
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const nativeSendCalls: unknown[][] = []
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [{
                id: 'released-hapi-session',
                active: false,
                metadata: {
                    machineId: 'mac-runner',
                    flavor: 'codex',
                    codexSessionId: sessionId,
                    controlOwner: 'external',
                    lifecycleState: 'archived'
                }
            }],
            sendCodexLocalSessionMessage: async (...args: unknown[]) => {
                nativeSendCalls.push(args)
                return { success: true as const, status: 'processing' as const }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request(`/api/codex/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'mac-runner', message: 'Continue natively' })
            })
            expect(response.status).toBe(202)
            expect(await response.json()).toMatchObject({ success: true, status: 'processing' })
            expect(nativeSendCalls).toEqual([['mac-runner', sessionId, 'Continue natively']])
        } finally {
            store.close()
        }
    })

    it('asks the selected runner to exclude SHAPI-initiated Codex threads', async () => {
        const store = new Store(':memory:')
        const machine = createMachine('mac-runner', ['/runner/workspace'], 'default', '/runner/.codex')
        const listCalls: unknown[][] = []
        const hapiSession = {
            ...createRunnerLocalSessionData('hapi-thread').session,
            id: 'hapi-thread',
            originator: 'hapi-codex-client'
        }
        const externalSession = {
            ...createRunnerLocalSessionData('external-thread').session,
            id: 'external-thread',
            originator: 'codex-tui'
        }
        const legacyHapiSession = {
            ...createRunnerLocalSessionData('legacy-hapi-thread').session,
            id: 'legacy-hapi-thread',
            originator: 'Codex Desktop'
        }
        const engine = {
            ...createImportSyncEngine(store, [machine]),
            getSessionsByNamespace: () => [{
                id: 'legacy-hapi-thread',
                metadata: { machineId: 'mac-runner' }
            }],
            listCodexLocalSessions: async (...args: unknown[]) => {
                listCalls.push(args)
                return { success: true as const, sessions: [hapiSession, legacyHapiSession, externalSession] }
            }
        } as unknown as SyncEngine
        const app = createRoutesAppWithEngine('default', store, engine)

        try {
            const response = await app.request('/api/codex/sessions?machineId=mac-runner&limit=10&excludeHapiInitiated=true')
            expect(response.status).toBe(200)
            expect(listCalls).toEqual([['mac-runner', 10, { excludeHapiInitiated: true }]])
            const body = await response.json() as { success: boolean; sessions: Array<{ id: string }> }
            expect(body.success).toBe(true)
            expect(body.sessions.map((session) => session.id)).toEqual(['external-thread'])
        } finally {
            store.close()
        }
    })

    it('forks the selected runner-local Codex thread and copies visible history', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '66666666-6666-4666-8666-666666666666'
        const data = createRunnerLocalSessionData(codexSessionId, '/runner/.codex/worktrees/fork-thread')
        const machine = createMachine('machine-1', ['/runner/workspace'], 'default', '/runner/.codex')
        const spawnCalls: unknown[][] = []
        const readCalls: unknown[][] = []
        process.env.HAPI_HOSTNAME = 'hub-host'

        try {
            const engine = {
                ...createImportSyncEngine(store, [machine]),
                readCodexLocalSession: async (...args: unknown[]) => {
                    readCalls.push(args)
                    return { success: true as const, data }
                },
                getSessionByNamespace: (sessionId: string, namespace: string) => (
                    store.sessions.getSessionsByNamespace(namespace).find((session) => session.id === sessionId)
                        ?? null
                ),
                spawnSession: async (...args: unknown[]) => {
                    spawnCalls.push(args)
                    const session = store.sessions.getOrCreateSession('forked-hapi-session', {
                        path: '/runner/.codex/worktrees/fork-thread',
                        host: 'machine-1',
                        machineId: 'machine-1',
                        flavor: 'codex'
                    }, {}, 'default')
                    return { type: 'success' as const, sessionId: session.id }
                }
            } as unknown as SyncEngine
            const app = createRoutesAppWithEngine('default', store, engine)

            const response = await app.request(`/api/codex/sessions/${codexSessionId}/fork`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'machine-1' })
            })

            expect(response.status).toBe(200)
            const body = await response.json() as { type: string; sessionId: string }
            expect(body.type).toBe('success')
            expect(spawnCalls).toHaveLength(1)
            expect(spawnCalls[0]?.slice(0, 3)).toEqual([
                'machine-1',
                '/runner/.codex/worktrees/fork-thread',
                'codex'
            ])
            expect(spawnCalls[0]?.[12]).toBe(codexSessionId)
            expect(readCalls).toEqual([['machine-1', codexSessionId]])
            const messages = store.messages.getAllMessages(body.sessionId)
            expect(messages).toHaveLength(2)
            const session = store.sessions.getSessionsByNamespace('default').find((candidate) => candidate.id === body.sessionId)
            expect(session?.metadata).toMatchObject({
                codexFork: {
                    sourceCodexSessionId: codexSessionId,
                    mode: 'native_fork'
                }
            })
        } finally {
            store.close()
        }
    })

    it('rejects a selected runner that does not advertise its Codex transcript home', async () => {
        const store = new Store(':memory:')
        const codexSessionId = '77777777-7777-4777-8777-777777777777'
        const data = createRunnerLocalSessionData(codexSessionId)
        let spawnCount = 0

        try {
            const engine = {
                ...createImportSyncEngine(store, [createMachine('remote-runner', [])]),
                readCodexLocalSession: async () => ({ success: true as const, data }),
                spawnSession: async () => {
                    spawnCount += 1
                    return { type: 'success' as const, sessionId: 'unexpected-session' }
                }
            } as unknown as SyncEngine
            const app = createRoutesAppWithEngine('default', store, engine)

            const response = await app.request(`/api/codex/sessions/${codexSessionId}/fork`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ machineId: 'remote-runner' })
            })

            expect(response.status).toBe(409)
            expect(await response.json()).toMatchObject({
                type: 'error',
                code: 'codex_home_unavailable',
                message: expect.stringContaining('Codex transcript home')
            })
            expect(spawnCount).toBe(0)
        } finally {
            store.close()
        }
    })

})
