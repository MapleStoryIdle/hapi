import { afterEach, describe, expect, it } from 'vitest'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerLocalPreviewHandlers } from './localPreview'

describe('local preview probe RPC handler', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('treats an HTTP error response as unavailable', async () => {
        globalThis.fetch = (async () => new Response('Not found', {
            status: 404,
            headers: { 'content-type': 'text/plain' }
        })) as unknown as typeof globalThis.fetch

        const rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' })
        registerLocalPreviewHandlers(rpc)

        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.LocalPreviewCheck}`,
            params: JSON.stringify({ protocol: 'http', port: 3000, path: '/' })
        })
        const result = JSON.parse(raw) as {
            ok: boolean
            status?: number
            error?: string
        }

        expect(result).toMatchObject({
            ok: false,
            status: 404,
            error: 'Local preview returned HTTP 404'
        })
    })
})
