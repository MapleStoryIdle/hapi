import { describe, expect, it } from 'vitest'
import { getSessionCurrentBranch } from './SessionHeader'

describe('getSessionCurrentBranch', () => {
    it('prefers the freshly reported Git branch over worktree metadata', () => {
        expect(getSessionCurrentBranch('main', 'feature/worktree')).toBe('main')
    })

    it('uses the worktree branch when a Git query is unavailable', () => {
        expect(getSessionCurrentBranch(null, 'feature/worktree')).toBe('feature/worktree')
    })

    it('does not render a branch for non-Git sessions', () => {
        expect(getSessionCurrentBranch('  ', undefined)).toBeNull()
    })
})
