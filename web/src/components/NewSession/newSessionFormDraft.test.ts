import { afterEach, describe, expect, it } from 'vitest'
import {
    clearNewSessionFormDraft,
    loadNewSessionFormDraft,
    newSessionDraftMatchesMachine,
    saveNewSessionFormDraft,
    shouldRestoreNewSessionFormDraft
} from './newSessionFormDraft'

describe('newSessionFormDraft', () => {
    afterEach(() => {
        clearNewSessionFormDraft()
    })

    it('round-trips visible agent model fields through sessionStorage', () => {
        saveNewSessionFormDraft({
            agent: 'codex',
            model: 'gpt-5.5',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            yoloMode: false,
            sessionType: 'simple',
            worktreeName: ''
        })

        expect(loadNewSessionFormDraft()).toEqual({
            agent: 'codex',
            model: 'gpt-5.5',
            cursorSelectedBase: 'auto',
            machineId: 'machine-1',
            effort: 'auto',
            modelReasoningEffort: 'xhigh',
            yoloMode: false,
            sessionType: 'simple',
            worktreeName: ''
        })
    })

    it('restores only when returning from browse with a directory in search', () => {
        expect(shouldRestoreNewSessionFormDraft({})).toBe(false)
        expect(shouldRestoreNewSessionFormDraft({ initialDirectory: '/tmp/proj' })).toBe(true)
        expect(shouldRestoreNewSessionFormDraft({
            initialDirectory: '/tmp/proj',
            initialMachineId: 'machine-1'
        })).toBe(true)
    })

    it('matches machine when draft has no machine id', () => {
        const draft = loadNewSessionFormDraft()
        void draft
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'auto',
            cursorSelectedBase: 'auto',
            machineId: null,
            effort: 'auto',
            modelReasoningEffort: 'default',
            yoloMode: false,
            sessionType: 'simple',
            worktreeName: ''
        })
        const loaded = loadNewSessionFormDraft()!
        expect(newSessionDraftMatchesMachine(loaded, 'machine-1')).toBe(true)
    })

    it('rejects draft when machine id differs', () => {
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'composer-2.5[fast=true]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-a',
            effort: 'auto',
            modelReasoningEffort: 'default',
            yoloMode: false,
            sessionType: 'simple',
            worktreeName: ''
        })
        const draft = loadNewSessionFormDraft()!
        expect(newSessionDraftMatchesMachine(draft, 'machine-b')).toBe(false)
    })

    it('coerces a hidden agent to codex and resets dependent fields', () => {
        saveNewSessionFormDraft({
            agent: 'cursor',
            model: 'composer-2.5[fast=false]',
            cursorSelectedBase: 'composer-2.5',
            machineId: 'machine-1',
            effort: 'high',
            modelReasoningEffort: 'high',
            yoloMode: true,
            sessionType: 'simple',
            worktreeName: ''
        })

        const loaded = loadNewSessionFormDraft()!
        expect(loaded.agent).toBe('codex')
        // Agent-dependent fields reset so a hidden agent model isn't carried into Codex.
        expect(loaded.model).toBe('auto')
        expect(loaded.cursorSelectedBase).toBe('auto')
        expect(loaded.effort).toBe('auto')
        expect(loaded.modelReasoningEffort).toBe('default')
        // agent-independent fields preserved
        expect(loaded.yoloMode).toBe(true)
        expect(loaded.machineId).toBe('machine-1')
    })
})
