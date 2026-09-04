import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getSessionLastSeenAt, initializeCodexKanbanLastSeen, markSessionSeen } from './sessionLastSeen'

describe('sessionLastSeen', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('stores the latest seen timestamp for a session', () => {
        markSessionSeen('session-a', 1000)
        markSessionSeen('session-a', 2500)
        expect(getSessionLastSeenAt('session-a')).toBe(2500)
    })

    it('does not move the watermark backwards', () => {
        markSessionSeen('session-a', 5000)
        markSessionSeen('session-a', 2000)
        expect(getSessionLastSeenAt('session-a')).toBe(5000)
    })

    it('baselines only the first completed Codex Kanban rollout', () => {
        expect(initializeCodexKanbanLastSeen([
            { id: 'historical-a', updatedAt: 1000 },
            { id: 'historical-b', updatedAt: 2000 }
        ], 'machine-a')).toBe(true)
        expect(initializeCodexKanbanLastSeen([{ id: 'future-row', updatedAt: 3000 }], 'machine-a')).toBe(true)

        expect(getSessionLastSeenAt('historical-a')).toBe(1000)
        expect(getSessionLastSeenAt('historical-b')).toBe(2000)
        expect(getSessionLastSeenAt('future-row')).toBe(0)
    })

    it('retains flat legacy watermarks while initializing a Kanban scope', () => {
        localStorage.setItem('hapi.sessionLastSeen.v1', JSON.stringify({ 'seen-before': 500 }))

        expect(initializeCodexKanbanLastSeen([{ id: 'historical-a', updatedAt: 1000 }], 'machine-a')).toBe(true)
        expect(getSessionLastSeenAt('seen-before')).toBe(500)
        expect(getSessionLastSeenAt('historical-a')).toBe(1000)
    })

    it('baselines each runner scope independently', () => {
        initializeCodexKanbanLastSeen([{ id: 'runner-a-historical', updatedAt: 1000 }], 'machine-a')
        initializeCodexKanbanLastSeen([{ id: 'runner-b-historical', updatedAt: 2000 }], 'machine-b')

        expect(getSessionLastSeenAt('runner-a-historical')).toBe(1000)
        expect(getSessionLastSeenAt('runner-b-historical')).toBe(2000)
    })

    it('recovers a missing persisted state by reseeding each runner scope', () => {
        const runnerA = { id: 'runner-a-historical', updatedAt: 1000 }
        const runnerB = { id: 'runner-b-historical', updatedAt: 1500 }

        expect(initializeCodexKanbanLastSeen([runnerA], 'machine-a')).toBe(true)
        expect(initializeCodexKanbanLastSeen([runnerB], 'machine-b')).toBe(true)
        localStorage.removeItem('hapi.sessionLastSeen.v1')

        expect(initializeCodexKanbanLastSeen([runnerA], 'machine-a')).toBe(true)
        expect(getSessionLastSeenAt(runnerA.id)).toBe(runnerA.updatedAt)
        expect(initializeCodexKanbanLastSeen([runnerB], 'machine-b')).toBe(true)
        expect(getSessionLastSeenAt(runnerB.id)).toBe(runnerB.updatedAt)
        expect(initializeCodexKanbanLastSeen([{ id: 'future-row', updatedAt: 2000 }], 'machine-b')).toBe(true)
        expect(getSessionLastSeenAt('future-row')).toBe(0)
    })

    it('notifies the current browser when a session is marked seen', () => {
        const onChange = vi.fn()
        window.addEventListener('hapi:session-last-seen-changed', onChange)

        markSessionSeen('session-a', 1000)

        expect(onChange).toHaveBeenCalledTimes(1)
        expect((onChange.mock.calls[0][0] as CustomEvent<{
            lastSeenAtBySession: Record<string, number>
        }>).detail.lastSeenAtBySession).toMatchObject({
            'session-a': 1000
        })
        window.removeEventListener('hapi:session-last-seen-changed', onChange)
    })

    it('ignores localStorage write failures', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('quota exceeded')
        })

        expect(initializeCodexKanbanLastSeen([{ id: 'historical-a', updatedAt: 1000 }], 'machine-a')).toBe(false)
        expect(() => markSessionSeen('session-a', 1000)).not.toThrow()

        setItem.mockRestore()
    })

    it('returns zero when localStorage getter throws', () => {
        const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new Error('storage denied')
            },
        })

        expect(getSessionLastSeenAt('session-a')).toBe(0)
        expect(() => markSessionSeen('session-a', 1000)).not.toThrow()

        if (localStorageDescriptor) {
            Object.defineProperty(window, 'localStorage', localStorageDescriptor)
        }
    })
})
