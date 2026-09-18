import { describe, expect, it } from 'vitest'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import {
    closeAutoExpandedToolGroups,
    shouldCloseAutoExpandedToolGroups,
    getDefaultToolGroupExpansionState,
    isToolGroupExpansionOpen,
    resolveToolGroupExpansionState
} from './toolGroupExpansion'

function makeGroup(overrides: Partial<ToolGroupBlock> = {}): ToolGroupBlock {
    return {
        kind: 'tool-group',
        id: 'result-details:1',
        createdAt: 1,
        invokedAt: null,
        firstToolId: 'tool-1',
        lastToolId: 'tool-2',
        tools: [],
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: 0,
            countsByKind: { read: 0, search: 0, command: 0, mutation: 0, web: 0, other: 0 },
            fileTargets: [],
            commandTargets: [],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0
        },
        ...overrides
    }
}

describe('tool group expansion state', () => {
    it('closes only auto-expanded groups when the turn completes', () => {
        expect(closeAutoExpandedToolGroups({
            current: 'auto-open',
            historical: 'auto-closed',
            userOpened: 'user-open',
            userClosed: 'user-closed'
        })).toEqual({
            current: 'auto-closed',
            historical: 'auto-closed',
            userOpened: 'user-open',
            userClosed: 'user-closed'
        })
    })

    it('carries the newest user choice into a completed merged result group', () => {
        const state = resolveToolGroupExpansionState(
            makeGroup({ expansionStateKeys: ['live:first', 'live:last'] }),
            {
                'live:first': 'auto-closed',
                'live:last': 'user-open'
            },
            getDefaultToolGroupExpansionState(false)
        )

        expect(state).toBe('user-open')
        expect(isToolGroupExpansionOpen(state)).toBe(true)
    })
})

describe('shouldCloseAutoExpandedToolGroups', () => {
    it('does not close when a completion marker arrives during an active session run', () => {
        expect(shouldCloseAutoExpandedToolGroups(
            { runActive: true, completionKey: null },
            { runActive: true, completionKey: 'duration-1' }
        )).toBe(false)
    })

    it('closes on the active-to-idle edge even when the completion marker is missing', () => {
        expect(shouldCloseAutoExpandedToolGroups(
            { runActive: true, completionKey: null },
            { runActive: false, completionKey: null }
        )).toBe(true)
    })

    it('closes for a new completion marker only while already idle', () => {
        expect(shouldCloseAutoExpandedToolGroups(
            { runActive: false, completionKey: 'duration-1' },
            { runActive: false, completionKey: 'duration-2' }
        )).toBe(true)
    })
})
