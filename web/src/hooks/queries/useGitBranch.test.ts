import { describe, expect, it } from 'vitest'
import { getGitBranchFromStatusOutput } from './useGitBranch'

describe('getGitBranchFromStatusOutput', () => {
    it('reads the branch from porcelain v2 output', () => {
        expect(getGitBranchFromStatusOutput('# branch.oid abc123\n# branch.head feature/sidebar\n'))
            .toBe('feature/sidebar')
    })

    it('keeps detached HEAD distinguishable and hides an initial repository', () => {
        expect(getGitBranchFromStatusOutput('# branch.head (detached)\n')).toBe('detached')
        expect(getGitBranchFromStatusOutput('# branch.head (initial)\n')).toBeNull()
    })
})
