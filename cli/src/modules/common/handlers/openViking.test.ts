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

    it('summarizes OpenViking retrieval metrics', async () => {
        globalThis.fetch = (async () => new Response([
            'openviking_retrieval_requests_total{context_type="memory"} 10',
            'openviking_retrieval_results_total{context_type="memory"} 24',
            'openviking_retrieval_zero_result_total{context_type="memory"} 2',
            'openviking_retrieval_latency_seconds_sum{context_type="memory"} 3',
            'openviking_retrieval_latency_seconds_count{context_type="memory"} 10',
            'openviking_retrieval_latency_seconds_bucket{context_type="memory",le="0.5"} 8',
            'openviking_retrieval_latency_seconds_bucket{context_type="memory",le="1"} 10',
            'openviking_retrieval_latency_seconds_bucket{context_type="memory",le="+Inf"} 10',
            'openviking_retrieval_rerank_fallback_total 1',
            'openviking_queue_pending{queue="semantic"} 3'
        ].join('\n'), { status: 200 })) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({ method: `machine-test:${RPC_METHODS.OpenVikingMetrics}`, params: '{}' })

        expect(JSON.parse(raw)).toMatchObject({ ok: true, retrievalRequests: 10, retrievalResults: 24, zeroResults: 2, zeroResultRate: 0.2, averageLatencyMs: 300, p95LatencyMs: 1000, rerankFallbacks: 1, queuePending: 3 })
    })

    it('runs a retrieval test and normalizes ranked hits', async () => {
        let requestBody = ''
        globalThis.fetch = (async (_input: FetchInput, init?: FetchInit) => {
            requestBody = String(init?.body)
            return new Response(JSON.stringify({ status: 'ok', result: {
                memories: [{ uri: 'viking://~/memories/name.md', context_type: 'memory', score: 0.91, abstract: 'Preferred name' }],
                resources: [{ uri: 'viking://resources/guide.md', score: 0.72 }],
                skills: []
            } }), { status: 200 })
        }) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({ method: `machine-test:${RPC_METHODS.OpenVikingSearch}`, params: JSON.stringify({ query: 'my name', limit: 5 }) })

        expect(JSON.parse(requestBody)).toEqual({ query: 'my name', limit: 5 })
        expect(JSON.parse(raw)).toMatchObject({ ok: true, total: 2, hits: [
            { uri: 'viking://~/memories/name.md', contextType: 'memory', score: 0.91 },
            { uri: 'viking://resources/guide.md', contextType: 'resource', score: 0.72 }
        ] })
    })

    it('checks duplicate and explicit conflict candidates on demand', async () => {
        globalThis.fetch = (async (input: FetchInput) => {
            const url = new URL(String(input))
            if (url.pathname.endsWith('/fs/ls')) return new Response(JSON.stringify({ status: 'ok', result: [
                { name: 'one.md', uri: 'viking://~/memories/one.md', isDir: false, modTime: '2020-01-01T00:00:00Z' },
                { name: 'two.md', uri: 'viking://~/memories/two.md', isDir: false, modTime: '2020-01-01T00:00:00Z' },
                { name: 'three.md', uri: 'viking://~/memories/three.md', isDir: false, modTime: '2020-01-01T00:00:00Z' }
            ] }), { status: 200 })
            const uri = url.searchParams.get('uri')
            const content = uri?.endsWith('one.md') ? 'theme: dark\neditor: vim' : uri?.endsWith('two.md') ? 'theme: dark\neditor: vim' : 'theme: light'
            return new Response(JSON.stringify({ status: 'ok', result: content }), { status: 200 })
        }) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)
        const raw = await rpc.handleRequest({ method: `machine-test:${RPC_METHODS.OpenVikingQuality}`, params: '{}' })
        const result = JSON.parse(raw)

        expect(result.ok).toBe(true)
        expect(result.scannedMemories).toBe(3)
        expect(result.duplicateGroups).toBe(1)
        expect(result.conflictGroups).toBe(1)
        expect(result.stale30d).toBe(3)
    })
})
