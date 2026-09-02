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
