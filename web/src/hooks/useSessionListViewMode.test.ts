import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_SESSION_LIST_VIEW_MODE,
    getInitialPinnedSessionKeys,
    getInitialSessionListViewMode,
} from './useSessionListViewMode'

describe('useSessionListViewMode helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('defaults to the regular list and ignores invalid stored values', () => {
        expect(getInitialSessionListViewMode()).toBe(DEFAULT_SESSION_LIST_VIEW_MODE)

        window.localStorage.setItem('hapi-session-list-view-mode', 'calendar')
        expect(getInitialSessionListViewMode()).toBe(DEFAULT_SESSION_LIST_VIEW_MODE)
    })

    it('restores the board view and valid local pins', () => {
        window.localStorage.setItem('hapi-session-list-view-mode', 'kanban')
        window.localStorage.setItem('hapi-session-list-pinned-session-keys', JSON.stringify([
            'hapi:session-1',
            'native:thread-2',
            'native:thread-2',
            42
        ]))

        expect(getInitialSessionListViewMode()).toBe('kanban')
        expect([...getInitialPinnedSessionKeys()]).toEqual(['hapi:session-1', 'native:thread-2'])
    })
})
