import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerOpenVikingHandlers } from './openViking'

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = Parameters<typeof globalThis.fetch>[1]

const OPEN_VIKING_ENV_NAMES = [
    'HAPI_OPENVIKING_API_KEY',
    'HAPI_OPENVIKING_BEARER_TOKEN',
    'HAPI_OPENVIKING_ACCOUNT',
    'HAPI_OPENVIKING_USER',
    'OPENVIKING_API_KEY',
    'OPENVIKING_BEARER_TOKEN',
    'OPENVIKING_ACCOUNT',
    'OPENVIKING_USER',
    'OPENVIKING_CLI_CONFIG_FILE'
] as const

describe('OpenViking RPC handlers', () => {
    const originalFetch = globalThis.fetch
    const originalEnvironment = Object.fromEntries(
        OPEN_VIKING_ENV_NAMES.map((name) => [name, process.env[name]])
    ) as Record<typeof OPEN_VIKING_ENV_NAMES[number], string | undefined>

    beforeEach(() => {
        process.env.HAPI_OPENVIKING_API_KEY = 'openviking-key'
        process.env.HAPI_OPENVIKING_ACCOUNT = 'default'
        process.env.HAPI_OPENVIKING_USER = 'default'
        delete process.env.HAPI_OPENVIKING_BEARER_TOKEN
        delete process.env.OPENVIKING_API_KEY
        delete process.env.OPENVIKING_BEARER_TOKEN
        delete process.env.OPENVIKING_ACCOUNT
        delete process.env.OPENVIKING_USER
        process.env.OPENVIKING_CLI_CONFIG_FILE = '/does-not-exist'
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
        for (const name of OPEN_VIKING_ENV_NAMES) {
            const value = originalEnvironment[name]
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })

    it('reports the local OpenViking version and auth mode', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({
            version: '0.4.14',
            auth_mode: 'trusted'
        }), { status: 200 })) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingStatus}`,
            params: '{}'
        })

        expect(JSON.parse(raw)).toEqual({
            ok: true,
            status: 200,
            version: '0.4.14',
            authMode: 'trusted'
        })
    })

    it('lists a context directory with runner-side credentials', async () => {
        const captured: { url?: URL; headers?: Headers } = {}
        globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
            captured.url = new URL(String(input))
            captured.headers = new Headers(init?.headers)
            return new Response(JSON.stringify({
                status: 'ok',
                result: [
                    { uri: 'viking://resources/', isDir: true },
                    { name: 'profile.md', uri: 'viking://user/default/profile.md', isDir: false, size: 42 }
                ]
            }), { status: 200 })
        }) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingListContext}`,
            params: JSON.stringify({ uri: 'viking://' })
        })

        expect(JSON.parse(raw)).toEqual({
            ok: true,
            entries: [
                { name: 'resources', uri: 'viking://resources/', isDir: true },
                { name: 'profile.md', uri: 'viking://user/default/profile.md', isDir: false, size: 42 }
            ]
        })
        expect(captured.url?.origin).toBe('http://127.0.0.1:1933')
        expect(captured.url?.pathname).toBe('/api/v1/fs/ls')
        expect(captured.url?.searchParams.get('uri')).toBe('viking://')
        expect(captured.headers?.get('x-api-key')).toBe('openviking-key')
        expect(captured.headers?.get('x-openviking-account')).toBe('default')
        expect(captured.headers?.get('x-openviking-user')).toBe('default')
    })

    it('reads any Viking URI and retries without trusted headers for API-key mode', async () => {
        const headers: Headers[] = []
        globalThis.fetch = (async (_input: FetchInput, init?: FetchInit) => {
            headers.push(new Headers(init?.headers))
            if (headers.length === 1) {
                return new Response(JSON.stringify({ status: 'error' }), { status: 400 })
            }
            return new Response(JSON.stringify({ status: 'ok', result: '# context' }), { status: 200 })
        }) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingReadContext}`,
            params: JSON.stringify({ uri: 'viking://agent/skills/search-web/SKILL.md' })
        })

        expect(JSON.parse(raw)).toEqual({ ok: true, content: '# context' })
        expect(headers).toHaveLength(2)
        expect(headers[0]?.get('x-openviking-account')).toBe('default')
        expect(headers[1]?.get('x-openviking-account')).toBeNull()
        expect(headers[1]?.get('x-api-key')).toBe('openviking-key')
    })

    it('rejects a non-Viking URI without contacting OpenViking', async () => {
        const fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingListContext}`,
            params: JSON.stringify({ uri: 'https://example.test' })
        })

        expect(JSON.parse(raw)).toEqual({ ok: false, error: 'Invalid OpenViking context URI' })
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
