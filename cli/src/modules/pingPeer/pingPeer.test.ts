import { describe, expect, it, vi } from 'vitest'
import {
    PingPeerError,
    formatInspectPeerReport,
    inspectPeer,
    pingPeer,
    resolveSessionByPrefix,
    type PingPeerSessionSummary
} from './pingPeer'

type MockResponse = { status: number; data: unknown }

function createHttpMock(handlers: {
    post: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    get: (url: string, config?: { params?: Record<string, unknown> }) => MockResponse | Promise<MockResponse>
}) {
    return {
        post: vi.fn(handlers.post),
        get: vi.fn(handlers.get)
    }
}

describe('pingPeer', () => {
    const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111'

    it('解析唯一前缀，拒绝歧义前缀', () => {
        const sessions: PingPeerSessionSummary[] = [
            { id: sessionId, active: true },
            { id: 'aaaaaaab-2222-2222-2222-222222222222', active: false }
        ]
        expect(resolveSessionByPrefix(sessions, sessionId).id).toBe(sessionId)
        expect(() => resolveSessionByPrefix(sessions, 'aaaa')).toThrow(PingPeerError)
    })

    it('向已激活会话投递消息而不 resume', async () => {
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(body).toEqual({ text: 'hello peer' })
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions')) {
                    return { status: 200, data: { sessions: [{ id: sessionId, active: true, metadata: { name: 'Peer' } }] } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return { status: 200, data: { session: { id: sessionId, active: true, metadata: { name: 'Peer' } } } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await pingPeer({
            sessionIdPrefix: 'aaaaaaaa',
            message: 'hello peer',
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })
        expect(result).toMatchObject({ sessionId, resumed: false })
        expect(http.post.mock.calls.some(([url]) => String(url).includes('/resume'))).toBe(false)
    })

    it('拒绝向当前 HAPI 会话投递，避免 Agent 自激循环', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions')) {
                    return { status: 200, data: { sessions: [{ id: sessionId, active: true, metadata: { name: 'Self' } }] } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(pingPeer({
            sessionIdPrefix: 'aaaaaaaa',
            message: 'do not loop',
            callerSessionId: sessionId,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).rejects.toMatchObject({
            code: 'bad_args',
            message: 'refusing to ping the current HAPI session'
        })
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.post.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false)
    })

    it('inspect 只读取，不会 resume，并保留文本消息', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return { status: 200, data: { sessions: [{ id: sessionId, active: false, metadata: { name: 'Peer', flavor: 'codex' } }] } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return { status: 200, data: { session: { id: sessionId, active: false, thinking: false, metadata: { name: 'Peer', flavor: 'codex' } } } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 30 })
                    return {
                        status: 200,
                        data: {
                            messages: [
                                { id: 'u1', createdAt: 1, content: { role: 'user', content: { text: '状态如何？' } } },
                                { id: 'a1', createdAt: 2, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: '正在处理。' } } } }
                            ]
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await inspectPeer({
            sessionIdPrefix: `[Peer](/sessions/${sessionId})`,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })
        expect(result.messages.map((message) => message.text)).toEqual(['状态如何？', '正在处理。'])
        expect(formatInspectPeerReport(result)).toContain(`/sessions/${sessionId}`)
        expect(http.post).toHaveBeenCalledTimes(1)
    })
})
