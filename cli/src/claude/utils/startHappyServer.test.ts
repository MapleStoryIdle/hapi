import { describe, expect, it } from 'vitest'
import { HAPI_MCP_TOOL_NAMES, toClaudeAllowedHapiMcpTools } from './startHappyServer'

describe('SHAPI MCP A2A capabilities', () => {
    it('only exposes the retained SHAPI MCP tools', () => {
        expect(HAPI_MCP_TOOL_NAMES).toEqual([
            'change_title',
            'display_image',
            'list_peers',
            'inspect_peer',
            'ping_peer'
        ])
    })

    it('Claude 不会自动批准读取或写入其他会话的工具', () => {
        const allowed = toClaudeAllowedHapiMcpTools([...HAPI_MCP_TOOL_NAMES])
        expect(allowed).toContain('mcp__hapi__list_peers')
        expect(allowed).not.toContain('mcp__hapi__inspect_peer')
        expect(allowed).not.toContain('mcp__hapi__ping_peer')
    })
})
