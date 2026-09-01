import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getGitBranchStatusForCwd, hasGitWorktreeChanges, isLinkedGitWorktree } from './git'

const execFileAsync = promisify(execFile)

async function runGit(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd })
}

describe('isLinkedGitWorktree', () => {
    it('keeps the primary checkout as a regular Git directory', () => {
        expect(isLinkedGitWorktree('.git\n.git\n', '/repo/hapi')).toBe(false)
    })

    it('recognizes a linked worktree from its separate Git directory', () => {
        expect(isLinkedGitWorktree(
            '/repo/hapi/.git/worktrees/feature-list\n/repo/hapi/.git\n',
            '/repo/hapi-worktrees/feature-list'
        )).toBe(true)
    })

    it('does not classify incomplete Git output as a worktree', () => {
        expect(isLinkedGitWorktree('/repo/hapi/.git/worktrees/feature-list\n', '/repo/hapi-worktrees/feature-list'))
            .toBe(false)
    })

    it('reports the linked-worktree flag from a real Git worktree', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-git-worktree-'))
        const primaryCheckout = join(sandbox, 'primary')
        const linkedWorktree = join(sandbox, 'feature-list')

        try {
            await mkdir(primaryCheckout)
            await runGit(primaryCheckout, 'init')
            await runGit(primaryCheckout, 'config', 'user.name', 'HAPI Test')
            await runGit(primaryCheckout, 'config', 'user.email', 'test@example.com')
            await writeFile(join(primaryCheckout, 'README.md'), '# test\n')
            await runGit(primaryCheckout, 'add', 'README.md')
            await runGit(primaryCheckout, 'commit', '-m', 'initial')
            await runGit(primaryCheckout, 'branch', '-M', 'main')
            await runGit(primaryCheckout, 'worktree', 'add', '-b', 'feature-list', linkedWorktree)

            await expect(getGitBranchStatusForCwd(primaryCheckout)).resolves.toMatchObject({
                success: true,
                stdout: expect.stringContaining('# branch.head main\n'),
                isWorktree: false,
                isDirty: false
            })
            await expect(getGitBranchStatusForCwd(linkedWorktree)).resolves.toMatchObject({
                success: true,
                stdout: expect.stringContaining('# branch.head feature-list\n'),
                isWorktree: true,
                isDirty: false
            })

            await writeFile(join(primaryCheckout, 'README.md'), '# changed\n')
            await expect(getGitBranchStatusForCwd(primaryCheckout)).resolves.toMatchObject({
                success: true,
                isDirty: true
            })
        } finally {
            await rm(sandbox, { recursive: true, force: true })
        }
    })
})

describe('hasGitWorktreeChanges', () => {
    it('ignores porcelain branch headers and detects changed records', () => {
        expect(hasGitWorktreeChanges('# branch.oid abc123\n# branch.head main\n')).toBe(false)
        expect(hasGitWorktreeChanges('# branch.head main\n1 .M N... README.md\n')).toBe(true)
        expect(hasGitWorktreeChanges('# branch.head main\n? notes.md\n')).toBe(true)
    })
})
