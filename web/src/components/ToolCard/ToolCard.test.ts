import { describe, expect, it } from 'vitest'
import { shouldShowInlineToolCardBody, shouldUseCompactTerminalToolCard } from '@/components/ToolCard/ToolCard'

describe('ToolCard terminal display mode helpers', () => {
    it('treats terminal-related cards as compact by default', () => {
        expect(shouldUseCompactTerminalToolCard('CodexBash', 'compact')).toBe(true)
        expect(shouldUseCompactTerminalToolCard('shell_command', 'compact')).toBe(true)
        expect(shouldUseCompactTerminalToolCard('run_shell_command', 'compact')).toBe(true)
        expect(shouldUseCompactTerminalToolCard('Read', 'compact')).toBe(false)
    })

    it('keeps terminal execution details out of the message flow in every mode', () => {
        expect(shouldShowInlineToolCardBody('CodexBash', false)).toBe(false)
        expect(shouldShowInlineToolCardBody('Bash', true)).toBe(false)
        expect(shouldShowInlineToolCardBody('shell_command', true)).toBe(false)
        expect(shouldShowInlineToolCardBody('run_shell_command', true)).toBe(false)
    })

    it('still hides inline bodies for minimal and Task/Agent subagent cards', () => {
        expect(shouldShowInlineToolCardBody('Task', false)).toBe(false)
        expect(shouldShowInlineToolCardBody('Agent', false)).toBe(false)
        expect(shouldShowInlineToolCardBody('Read', true)).toBe(false)
    })
})
