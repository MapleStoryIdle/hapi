import { describe, expect, it } from 'vitest'
import { HAPI_MCP_TOOL_NAMES, toClaudeAllowedHapiMcpTools } from './startHappyServer'

describe('HAPI MCP A2A capabilities', () => {
    it('公开 peer discovery、inspect 和 ping 工具', () => {
        expect(HAPI_MCP_TOOL_NAMES).toEqual(expect.arrayContaining([
            'list_peers',
            'inspect_peer',
            'ping_peer'
        ]))
    })

    it('Claude 不会自动批准读取或写入其他会话的工具', () => {
        const allowed = toClaudeAllowedHapiMcpTools([...HAPI_MCP_TOOL_NAMES])
        expect(allowed).toContain('mcp__hapi__list_peers')
        expect(allowed).not.toContain('mcp__hapi__inspect_peer')
        expect(allowed).not.toContain('mcp__hapi__ping_peer')
    })
})
