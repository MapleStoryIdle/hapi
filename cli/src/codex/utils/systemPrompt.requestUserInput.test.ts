import { describe, expect, it } from 'vitest'
import { codexSystemPrompt } from './systemPrompt'

describe('Codex structured user-input prompt', () => {
    it('steers blocking decisions to request_user_input before normal assistant text', () => {
        expect(codexSystemPrompt).toContain('request_user_input tool is available')
        expect(codexSystemPrompt).toContain('Do not ask the same decision first in normal assistant text.')
        expect(codexSystemPrompt).toContain('2–4 clear, mutually exclusive options')
    })

    it('preserves normal permission approvals and provides an unavailable-tool fallback', () => {
        expect(codexSystemPrompt).toContain('normal permission flow')
        expect(codexSystemPrompt).toContain('ask one concise plain-text question')
    })
})
