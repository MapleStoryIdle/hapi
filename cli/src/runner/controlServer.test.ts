import { describe, expect, it } from 'vitest'
import { startRunnerControlServer } from './controlServer'

describe('runner control server external Codex requests', () => {
    it('forwards sanitized external Codex request metadata to the runner', async () => {
        const requests: unknown[] = []
        const server = await startRunnerControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            onExternalCodexRequest: (request) => requests.push(request),
            onExternalCodexLifecycle: () => {}
        })

        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/codex-external-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    codexSessionId: 'codex-thread-1',
                    requestId: 'turn-1:Bash',
                    kind: 'permission',
                    toolName: 'Bash'
                })
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ status: 'ok' })
            expect(requests).toEqual([{
                codexSessionId: 'codex-thread-1',
                requestId: 'turn-1:Bash',
                kind: 'permission',
                phase: 'requested',
                toolName: 'Bash'
            }])
        } finally {
            await server.stop()
        }
    })

    it('accepts only sanitized external Codex lifecycle events', async () => {
        const events: unknown[] = []
        const server = await startRunnerControlServer({
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }),
            requestShutdown: () => {},
            onHappySessionWebhook: () => {},
            onExternalCodexRequest: () => {},
            onExternalCodexLifecycle: (event) => events.push(event)
        })

        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/codex-external-lifecycle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    codexSessionId: 'codex-thread-1',
                    turnId: 'turn-1',
                    event: 'turn_started',
                    observedAt: 1_725_000_000_000
                })
            })
            const rejected = await fetch(`http://127.0.0.1:${server.port}/codex-external-lifecycle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    codexSessionId: 'codex-thread-1',
                    turnId: 'turn-1',
                    event: 'turn_started',
                    observedAt: 1_725_000_000_000,
                    prompt: 'TOP_SECRET'
                })
            })

            expect(response.status).toBe(200)
            expect(rejected.status).toBe(400)
            expect(events).toEqual([{
                codexSessionId: 'codex-thread-1',
                turnId: 'turn-1',
                event: 'turn_started',
                observedAt: 1_725_000_000_000
            }])
        } finally {
            await server.stop()
        }
    })
})
