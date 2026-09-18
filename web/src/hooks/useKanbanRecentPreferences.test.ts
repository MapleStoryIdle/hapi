import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_KANBAN_RECENT_AUTO_REMOVE,
    DEFAULT_KANBAN_RECENT_MINUTES,
    MAX_KANBAN_RECENT_MINUTES,
    MIN_KANBAN_RECENT_MINUTES,
    getInitialKanbanRecentPreferences,
    normalizeKanbanRecentMinutes
} from './useKanbanRecentPreferences'

describe('Kanban recent preferences', () => {
    beforeEach(() => window.localStorage.clear())

    it('uses the product defaults when preferences are missing or invalid', () => {
        expect(getInitialKanbanRecentPreferences()).toEqual({
            recentMinutes: DEFAULT_KANBAN_RECENT_MINUTES,
            autoRemoveOnOpen: DEFAULT_KANBAN_RECENT_AUTO_REMOVE
        })

        window.localStorage.setItem('hapi-kanban-recent-minutes', 'invalid')
        expect(getInitialKanbanRecentPreferences().recentMinutes).toBe(DEFAULT_KANBAN_RECENT_MINUTES)
    })

    it('reads stored preferences', () => {
        window.localStorage.setItem('hapi-kanban-recent-minutes', '45')
        window.localStorage.setItem('hapi-kanban-recent-auto-remove', 'false')

        expect(getInitialKanbanRecentPreferences()).toEqual({
            recentMinutes: 45,
            autoRemoveOnOpen: false
        })
    })

    it('clamps the recent window to the three-day session index', () => {
        expect(normalizeKanbanRecentMinutes(0)).toBe(MIN_KANBAN_RECENT_MINUTES)
        expect(normalizeKanbanRecentMinutes(MAX_KANBAN_RECENT_MINUTES + 1)).toBe(MAX_KANBAN_RECENT_MINUTES)
    })
})
