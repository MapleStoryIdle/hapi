import { describe, expect, it } from 'bun:test'
import {
    classifyCodexFailureMessage,
    extractCodexFailureMessage,
    isGenericCodexFailureMessage,
    selectPreferredCodexFailureMessage,
} from './codexFailure'

describe('Codex failure extraction', () => {
    it('finds a detailed provider error inside changing payload shapes', () => {
        expect(extractCodexFailureMessage({
            status: { type: 'systemError', error: { detail: { message: 'Selected model is at capacity.' } } },
            message: 'Task failed',
        })).toBe('Selected model is at capacity.')
    })

    it('parses JSON-encoded errors and preserves unfamiliar objects as JSON', () => {
        expect(extractCodexFailureMessage('{"error":{"message":"Backend unavailable"}}')).toBe('Backend unavailable')
        expect(extractCodexFailureMessage({ provider_code: 987 })).toBe('{"provider_code":987}')
    })

    it('never lets a generic terminal event erase a detailed earlier error', () => {
        expect(selectPreferredCodexFailureMessage('Selected model is at capacity.', 'Task failed'))
            .toBe('Selected model is at capacity.')
        expect(isGenericCodexFailureMessage('Codex thread entered systemError')).toBe(true)
    })

    it('classifies provider detail without replacing its original text', () => {
        expect(classifyCodexFailureMessage('Selected model is at capacity. Please try a different model.'))
            .toBe('model_capacity')
    })
})
