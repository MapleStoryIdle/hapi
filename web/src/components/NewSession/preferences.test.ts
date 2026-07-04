import { beforeEach, describe, expect, it } from 'vitest'
import {
    loadPreferredAgent,
    loadPreferredModel,
    loadPreferredReasoningEffort,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredModel,
    savePreferredReasoningEffort,
    savePreferredYoloMode,
} from './preferences'

describe('NewSession preferences', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('loads defaults when storage is empty', () => {
        expect(loadPreferredAgent()).toBe('codex')
        expect(loadPreferredModel('codex')).toBe('auto')
        expect(loadPreferredReasoningEffort('codex')).toBe('default')
        expect(loadPreferredYoloMode()).toBe(false)
    })

    it('loads saved values from storage', () => {
        localStorage.setItem('hapi:newSession:agent', 'claude')
        localStorage.setItem('hapi:newSession:model:codex', 'gpt-5.5')
        localStorage.setItem('hapi:newSession:reasoningEffort:codex', 'xhigh')
        localStorage.setItem('hapi:newSession:yolo', 'true')

        expect(loadPreferredAgent()).toBe('claude')
        expect(loadPreferredModel('codex')).toBe('gpt-5.5')
        expect(loadPreferredReasoningEffort('codex')).toBe('xhigh')
        expect(loadPreferredYoloMode()).toBe(true)
    })

    it('falls back to default agent on invalid or hidden stored value', () => {
        localStorage.setItem('hapi:newSession:agent', 'unknown-agent')

        expect(loadPreferredAgent()).toBe('codex')

        localStorage.setItem('hapi:newSession:agent', 'cursor')

        expect(loadPreferredAgent()).toBe('codex')
    })

    it('persists new values to storage', () => {
        savePreferredAgent('codex')
        savePreferredModel('codex', 'gpt-5.5')
        savePreferredReasoningEffort('codex', 'high')
        savePreferredYoloMode(true)

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('codex')
        expect(localStorage.getItem('hapi:newSession:model:codex')).toBe('gpt-5.5')
        expect(localStorage.getItem('hapi:newSession:reasoningEffort:codex')).toBe('high')
        expect(localStorage.getItem('hapi:newSession:yolo')).toBe('true')
    })

    it('ignores invalid cached reasoning effort for the selected agent', () => {
        // Codex intentionally does not expose OpenCode's "max" effort level.
        localStorage.setItem('hapi:newSession:reasoningEffort:codex', 'max')

        expect(loadPreferredReasoningEffort('codex')).toBe('default')
    })
})
