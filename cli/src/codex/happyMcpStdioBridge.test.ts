import { describe, expect, it } from 'vitest'
import { HAPI_MCP_STDIO_TOOL_NAMES } from './happyMcpStdioBridge'

describe('HAPI MCP stdio bridge capabilities', () => {
    it('only forwards the retained HAPI MCP tools to the HTTP MCP server', () => {
        expect(HAPI_MCP_STDIO_TOOL_NAMES).toEqual([
            'change_title',
            'display_image',
            'list_peers',
            'inspect_peer',
            'ping_peer'
        ])
    })
})
