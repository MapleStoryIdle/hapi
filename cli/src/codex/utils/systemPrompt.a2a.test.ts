import { describe, expect, it } from 'vitest'
import { codexSystemPrompt } from './systemPrompt'

describe('Codex A2A system prompt', () => {
    it('把会话引用明确引导到 peer MCP 工具，而不是本地文件系统', () => {
        expect(codexSystemPrompt).toContain('functions.hapi__inspect_peer')
        expect(codexSystemPrompt).toContain('functions.hapi__ping_peer')
        expect(codexSystemPrompt).toContain('/sessions/<id> is a HAPI hub path')
    })
})
