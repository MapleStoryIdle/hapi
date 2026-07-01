import { beforeEach, describe, expect, it } from 'vitest'
import {
    loadPreferredAgent,
    loadPreferredYoloMode,
    savePreferredAgent,
    savePreferredYoloMode,
} from './preferences'

describe('NewSession preferences', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('loads defaults when storage is empty', () => {
        expect(loadPreferredAgent()).toBe('claude')
        expect(loadPreferredYoloMode()).toBe(false)
    })

    it('loads saved values from storage', () => {
        localStorage.setItem('hapi:newSession:agent', 'codex')
        localStorage.setItem('hapi:newSession:yolo', 'true')

        expect(loadPreferredAgent()).toBe('codex')
        expect(loadPreferredYoloMode()).toBe(true)
    })

    it('falls back to default agent on invalid or hidden stored value', () => {
        localStorage.setItem('hapi:newSession:agent', 'unknown-agent')

        expect(loadPreferredAgent()).toBe('claude')

        localStorage.setItem('hapi:newSession:agent', 'cursor')

        expect(loadPreferredAgent()).toBe('claude')
    })

    it('persists new values to storage', () => {
        savePreferredAgent('codex')
        savePreferredYoloMode(true)

        expect(localStorage.getItem('hapi:newSession:agent')).toBe('codex')
        expect(localStorage.getItem('hapi:newSession:yolo')).toBe('true')
    })
})
