import { describe, expect, it } from 'vitest'
import { HAPI_MCP_STDIO_TOOL_NAMES } from './happyMcpStdioBridge'

describe('HAPI MCP stdio bridge capabilities', () => {
    it('forwards A2A peer tools to the HTTP MCP server', () => {
        expect(HAPI_MCP_STDIO_TOOL_NAMES).toEqual(expect.arrayContaining([
            'list_peers',
            'inspect_peer',
            'ping_peer'
        ]))
    })
})
