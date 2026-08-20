import { afterEach, describe, expect, it } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerOpenVikingHandlers } from './openViking'

describe('OpenViking RPC handlers', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('reports the local OpenViking version and auth mode', async () => {
        globalThis.fetch = (async (input) => {
            expect(input).toBe('http://127.0.0.1:1933/health')
            return new Response(JSON.stringify({ version: '0.4.14', auth_mode: 'dev' }), {
                headers: { 'content-type': 'application/json' }
            })
        }) as typeof globalThis.fetch

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
            authMode: 'dev'
        })
    })

    it('proxies only supported OpenViking paths and strips HAPI authorization', async () => {
        const captured: { headers?: Headers } = {}
        globalThis.fetch = (async (input, init) => {
            expect(input).toBe('http://127.0.0.1:1933/studio/')
            captured.headers = new Headers(init?.headers)
            return new Response('<html>studio</html>', {
                headers: {
                    'content-type': 'text/html',
                    'x-frame-options': 'DENY'
                }
            })
        }) as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)

        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingHttpRequest}`,
            params: JSON.stringify({
                path: '/studio/',
                method: 'GET',
                headers: {
                    authorization: 'Bearer hapi-jwt',
                    accept: 'text/html'
                }
            })
        })
        const result = JSON.parse(raw) as {
            ok: boolean
            headers: Record<string, string>
        }

        expect(result.ok).toBe(true)
        expect(captured.headers?.get('authorization')).toBeNull()
        expect(captured.headers?.get('accept')).toBe('text/html')
        expect(result.headers['x-frame-options']).toBeUndefined()
    })

    it('rejects unsupported or traversal local paths before making a request', async () => {
        const fetchMock = async () => new Response('unexpected')
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerOpenVikingHandlers(rpc)

        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingHttpRequest}`,
            params: JSON.stringify({ path: '/metrics' })
        })

        expect(JSON.parse(raw)).toMatchObject({
            ok: false,
            status: 403,
            error: 'OpenViking path is not allowed'
        })

        const traversalRaw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.OpenVikingHttpRequest}`,
            params: JSON.stringify({ path: '/api/%2e%2e/metrics' })
        })

        expect(JSON.parse(traversalRaw)).toMatchObject({
            ok: false,
            status: 403,
            error: 'OpenViking path is not allowed'
        })
    })
})
