import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './client'

describe('ApiClient error mapping', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        vi.useRealTimers()
    })

    it('renames a native session using its selected runner and the native PATCH route', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, name: '原生任务' }), { status: 200 }))
        const api = new ApiClient('test-token')
        expect(await api.renameCodexSession('thread/1', 'runner-1', '原生任务')).toEqual({ success: true, name: '原生任务' })
        expect(fetchMock).toHaveBeenCalledWith('/api/codex/sessions/thread%2F1', expect.objectContaining({
            method: 'PATCH', body: JSON.stringify({ machineId: 'runner-1', name: '原生任务' })
        }))
    })

    it('keeps one spawn idempotency key when authentication retries the request', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ type: 'success', sessionId: 'session-1' }), { status: 200 }))
        const api = new ApiClient('test-token', {
            onUnauthorized: async () => 'refreshed-token'
        })

        await api.spawnSession('machine-1', '/work/project', 'codex')

        expect(fetchMock).toHaveBeenCalledTimes(2)
        const firstBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
        const retryBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)
        expect(firstBody.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(retryBody).toEqual(firstBody)
    })

    it('resolves a native Codex thread to its managed SHAPI session on the selected runner', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: true,
            sessionId: 'managed-session'
        }), { status: 200 }))
        const api = new ApiClient('test-token')

        expect(await api.getCodexManagedSessionTarget('thread/1', 'runner 1')).toEqual({
            success: true,
            sessionId: 'managed-session'
        })
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/codex/sessions/thread%2F1/managed-session?machineId=runner+1',
            expect.objectContaining({ headers: expect.any(Object) })
        )
    })

    it('rejects an invalid managed-session target payload', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
        const api = new ApiClient('test-token')

        await expect(api.getCodexManagedSessionTarget('thread-1', 'runner-1')).rejects.toThrow()
    })

    it('prefers the stable `code` field over the human-readable `error` message in ApiError.code', async () => {
        // Match the shape /sessions/:id/reopen actually returns on a 503.
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'No machine online', code: 'no_machine_online' }),
                { status: 503, statusText: 'Service Unavailable' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-X')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(503)
            // The stable taxonomy must survive into ApiError.code so callers can
            // branch on `no_machine_online` rather than parsing the message text.
            expect(apiError.code).toBe('no_machine_online')
            expect(apiError.body).toContain('no_machine_online')
        }
    })

    it('falls back to `parsed.error` when `code` is absent (legacy route shape)', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'something broke' }),
                { status: 500, statusText: 'Internal Server Error' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Y')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            expect((error as ApiError).code).toBe('something broke')
        }
    })

    it('uses the server error message instead of exposing a raw HTTP/JSON string', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Source session has an unsafe permission mode',
                    code: 'source_session_permission_unsafe'
                }),
                { status: 409, statusText: 'Conflict' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.deliverShareFeedback('share-1')
            expect.unreachable('expected deliverShareFeedback to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            expect((error as ApiError).message).toBe('Source session has an unsafe permission mode')
            expect((error as ApiError).message).not.toContain('HTTP 409')
        }
    })

    it('passes the 422 missing-metadata body through unchanged so the UI can show the missing fields', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                    missing: ['cursorSessionId']
                }),
                { status: 422, statusText: 'Unprocessable Entity' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Z')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(422)
            expect(apiError.body).toContain('cursorSessionId')
        }
    })

    it('aborts a stalled request and exposes a stable timeout error', async () => {
        vi.useFakeTimers()
        fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => (
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'))
                }, { once: true })
            })
        ))

        const api = new ApiClient('test-token', { requestTimeoutMs: 100 })
        const request = api.reopenSession('session-timeout')
        const timeoutExpectation = expect(request).rejects.toMatchObject({
            status: 408,
            code: 'request_timeout'
        })
        await vi.advanceTimersByTimeAsync(100)

        await timeoutExpectation
        vi.useRealTimers()
    })

    it('gives file uploads a five-minute timeout without widening other API requests', async () => {
        vi.useFakeTimers()
        fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => (
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'))
                }, { once: true })
            })
        ))

        const api = new ApiClient('test-token', { requestTimeoutMs: 100 })
        const upload = api.uploadFile('session-1', 'large.bin', new Blob([new Uint8Array([1])]), 'application/octet-stream')
        const timeoutExpectation = expect(upload).rejects.toMatchObject({
            status: 408,
            code: 'request_timeout'
        })

        await vi.advanceTimersByTimeAsync(299_999)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await timeoutExpectation
    })

    it('uses the authenticated share-management endpoints', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({
                shares: [{ id: 'share-1', filename: 'note.md', size: 4, createdAt: 1, expiresAt: 2 }]
            })))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                share: { id: 'share-1', filename: 'note.md', size: 4, createdAt: 1, expiresAt: 2, url: 'https://example.test/s/token' }
            })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ content: '# Note' })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))

        const api = new ApiClient('test-token')
        await expect(api.getShares()).resolves.toEqual({
            shares: [{ id: 'share-1', filename: 'note.md', size: 4, createdAt: 1, expiresAt: 2 }]
        })
        await expect(api.getShare('share / one')).resolves.toEqual({
            share: { id: 'share-1', filename: 'note.md', size: 4, createdAt: 1, expiresAt: 2, url: 'https://example.test/s/token' }
        })
        await expect(api.getShareContent('share / one')).resolves.toEqual({ content: '# Note' })
        await expect(api.revokeShare('share / one')).resolves.toEqual({ ok: true })

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/shares')
        expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toBeInstanceOf(Headers)
        expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Headers).get('authorization')).toBe('Bearer test-token')
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/shares/share%20%2F%20one')
        expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method ?? 'GET').toBe('GET')
        expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/shares/share%20%2F%20one/content')
        expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method ?? 'GET').toBe('GET')
        expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/shares/share%20%2F%20one')
        expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe('DELETE')
    })

    it('uses monitor endpoints without ever fetching a raw webhook token', async () => {
        const config = {
            name: 'API health',
            kind: 'http' as const,
            deliveryMode: 'current-session' as const,
            machineId: 'machine / one',
            directory: '/work/project',
            agent: 'codex' as const,
            model: '',
            reasoningEffort: '' as const,
            permissionMode: 'read-only' as const,
            prompt: 'Investigate safely and propose a repair.',
            webhookIgnoreKeywords: '',
            expiresAt: null,
            enabled: true,
            request: {
                url: 'https://example.test/health',
                method: 'POST' as const,
                headers: { accept: 'application/json' },
                body: '{"probe":true}',
                intervalSeconds: 60,
                timeoutSeconds: 10,
                expectedStatus: 200,
                bodyIncludes: 'ok',
                allowPrivateNetwork: false,
                allowPost: true
            }
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ monitors: [] })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ monitor: { id: 'm / 1' } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ monitor: { id: 'm / 1' }, token: 'new-token' })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ monitor: { id: 'm / 1' } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'rotated-token' })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ request: config.request })))

        const api = new ApiClient('test-token')
        await api.getMonitors()
        await api.getMonitor('m / 1')
        await api.createMonitor(config)
        await api.updateMonitor('m / 1', config)
        await api.rotateMonitorToken('m / 1')
        await api.checkMonitor('m / 1')
        await api.approveMonitorIncident('m / 1', 'incident / 1', 'immutable-plan-hash')
        await api.closeMonitorIncident('m / 1', 'incident / 1')
        await api.parseMonitorCurl('curl -X POST https://example.test/health')

        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            '/api/monitors',
            '/api/monitors/m%20%2F%201',
            '/api/monitors',
            '/api/monitors/m%20%2F%201',
            '/api/monitors/m%20%2F%201/token',
            '/api/monitors/m%20%2F%201/check',
            '/api/monitors/m%20%2F%201/incidents/incident%20%2F%201/approve',
            '/api/monitors/m%20%2F%201/incidents/incident%20%2F%201/close',
            '/api/monitors/parse-curl'
        ])
        expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toBe(JSON.stringify(config))
        expect((fetchMock.mock.calls[4]?.[1] as RequestInit).method).toBe('POST')
        expect((fetchMock.mock.calls[6]?.[1] as RequestInit).body).toBe(JSON.stringify({ planHash: 'immutable-plan-hash' }))
        expect((fetchMock.mock.calls[7]?.[1] as RequestInit).body).toBe(JSON.stringify({}))
        expect((fetchMock.mock.calls[8]?.[1] as RequestInit).body).toBe(JSON.stringify({ curl: 'curl -X POST https://example.test/health' }))
    })

    it('loads a server-resolved monitor target with encoded session identifiers', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            config: { targetSession: { type: 'native-codex', sessionId: 'thread / one' } },
            target: { type: 'native-codex', sessionId: 'thread / one', title: 'Native thread' }
        })))

        const api = new ApiClient('test-token')
        await expect(api.getMonitorSessionTarget({
            type: 'native-codex',
            sessionId: 'thread / one',
            machineId: 'machine / one'
        })).resolves.toEqual({
            config: { targetSession: { type: 'native-codex', sessionId: 'thread / one' } },
            target: { type: 'native-codex', sessionId: 'thread / one', title: 'Native thread' }
        })

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/monitors/session-target?type=native-codex&sessionId=thread+%2F+one&machineId=machine+%2F+one'
        )
        expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method ?? 'GET').toBe('GET')
    })

    it('requests a runner directory Git branch with encoded identifiers', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: true,
            stdout: '# branch.head feature/list\n',
            stderr: '',
            exitCode: 0,
            isWorktree: true
        })))

        const api = new ApiClient('test-token')
        await expect(api.getMachineGitBranch('machine / one', '/work/project name')).resolves.toEqual({
            success: true,
            stdout: '# branch.head feature/list\n',
            stderr: '',
            exitCode: 0,
            isWorktree: true
        })

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/machines/machine%20%2F%20one/git-branch?cwd=%2Fwork%2Fproject%20name'
        )
    })

    it('uses the machine Git branch picker endpoints', async () => {
        const payload = {
            success: true,
            currentBranch: 'main',
            isDirty: false,
            changedFileCount: 0,
            additions: 0,
            deletions: 0,
            upstream: 'origin/main',
            canUpdate: true,
            localBranches: [{ ref: 'main', name: 'main' }],
            remoteBranches: [{ ref: 'origin/main', name: 'main' }]
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload)))

        const api = new ApiClient('test-token')
        await expect(api.getMachineGitBranches('machine / one', '/work/project name')).resolves.toEqual(payload)
        await expect(api.switchMachineGitBranch('machine / one', {
            cwd: '/work/project name',
            target: { kind: 'remote', ref: 'origin/main' },
            confirmDirty: true
        })).resolves.toEqual(payload)
        await expect(api.createMachineGitBranch('machine / one', {
            cwd: '/work/project name',
            name: 'feature/new'
        })).resolves.toEqual(payload)
        await expect(api.commitMachineGitChanges('machine / one', {
            cwd: '/work/project name',
            message: 'Add branch controls'
        })).resolves.toEqual(payload)
        await expect(api.pushMachineGitBranch('machine / one', {
            cwd: '/work/project name'
        })).resolves.toEqual(payload)
        await expect(api.fetchMachineGitBranches('machine / one', {
            cwd: '/work/project name'
        })).resolves.toEqual(payload)
        await expect(api.updateMachineGitBranch('machine / one', {
            cwd: '/work/project name'
        })).resolves.toEqual(payload)

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/machines/machine%20%2F%20one/git-branches?cwd=%2Fwork%2Fproject%20name'
        )
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/machines/machine%20%2F%20one/git-branches/switch')
        expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('POST')
        expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBe(JSON.stringify({
            cwd: '/work/project name',
            target: { kind: 'remote', ref: 'origin/main' },
            confirmDirty: true
        }))
        expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/machines/machine%20%2F%20one/git-branches')
        expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/machines/machine%20%2F%20one/git-branches/commit')
        expect((fetchMock.mock.calls[3]?.[1] as RequestInit).body).toBe(JSON.stringify({
            cwd: '/work/project name',
            message: 'Add branch controls'
        }))
        expect(fetchMock.mock.calls[4]?.[0]).toBe('/api/machines/machine%20%2F%20one/git-branches/push')
        expect((fetchMock.mock.calls[4]?.[1] as RequestInit).body).toBe(JSON.stringify({
            cwd: '/work/project name'
        }))
        expect(fetchMock.mock.calls[5]?.[0]).toBe('/api/machines/machine%20%2F%20one/git-branches/fetch')
        expect((fetchMock.mock.calls[5]?.[1] as RequestInit).body).toBe(JSON.stringify({
            cwd: '/work/project name'
        }))
        expect(fetchMock.mock.calls[6]?.[0]).toBe('/api/machines/machine%20%2F%20one/git-branches/update')
        expect((fetchMock.mock.calls[6]?.[1] as RequestInit).body).toBe(JSON.stringify({
            cwd: '/work/project name'
        }))
    })

    it('reads a native Codex file through its owning runner with encoded identifiers', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            success: true,
            content: 'Y29uc3QgbmF0aXZlID0gdHJ1ZQo='
        })))

        const api = new ApiClient('test-token')
        await expect(api.readCodexSessionFile(
            'thread / one',
            'machine / one',
            'web/src/my file.tsx'
        )).resolves.toEqual({
            success: true,
            content: 'Y29uc3QgbmF0aXZlID0gdHJ1ZQo='
        })

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/codex/sessions/thread%20%2F%20one/file?machineId=machine+%2F+one&path=web%2Fsrc%2Fmy+file.tsx'
        )
    })
})
