import { CLAUDE_MODEL_PRESETS, getClaudeModelLabel } from '@hapi/protocol'
import { describe, expect, it } from 'vitest'
import {
    CLAUDE_EFFORT_OPTIONS,
    CODEX_REASONING_EFFORT_OPTIONS,
    MODEL_OPTIONS,
    OPENCODE_REASONING_EFFORT_OPTIONS
} from './types'

describe('Claude model options', () => {
    it('derives options from shared Claude model presets', () => {
        expect(MODEL_OPTIONS.claude).toEqual([
            { value: 'auto', label: 'Default' },
            ...CLAUDE_MODEL_PRESETS.map((model) => ({
                value: model,
                label: getClaudeModelLabel(model) ?? model
            }))
        ])
    })

    it('exposes friendly labels for Claude model presets', () => {
        expect(CLAUDE_MODEL_PRESETS).toEqual(['sonnet', 'sonnet[1m]', 'opus', 'opus[1m]', 'fable', 'fable[1m]'])
        expect(getClaudeModelLabel('sonnet[1m]')).toBe('Sonnet 1M')
        expect(getClaudeModelLabel('opus[1m]')).toBe('Opus 1M')
        expect(getClaudeModelLabel('fable[1m]')).toBe('Fable 1M')
    })
})

describe('Claude effort options', () => {
    it('matches supported effort presets in expected order', () => {
        expect(CLAUDE_EFFORT_OPTIONS).toEqual([
            { value: 'auto', label: 'Auto' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
        ])
    })
})

describe('reasoning effort options', () => {
    it('offers all supported Codex reasoning effort presets', () => {
        expect(CODEX_REASONING_EFFORT_OPTIONS).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'XHigh' },
            { value: 'max', label: 'Max' },
            { value: 'ultra', label: 'Ultra' },
        ])
    })

    it('keeps the OpenCode reasoning presets unchanged', () => {
        expect(OPENCODE_REASONING_EFFORT_OPTIONS).toEqual([
            { value: 'default', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
        ])
    })
})
