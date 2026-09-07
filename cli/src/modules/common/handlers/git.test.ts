import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
    commitGitChangesForCwd,
    createGitBranchForCwd,
    getGitBranchesForCwd,
    getGitBranchStatusForCwd,
    hasGitWorktreeChanges,
    isLinkedGitWorktree,
    pushGitBranchForCwd,
    switchGitBranchForCwd
} from './git'

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
            await runGit(primaryCheckout, 'config', 'user.name', 'SHAPI Test')
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

describe('machine Git branch actions', () => {
    it('lists remote refs without their origin prefix and guards dirty switches', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-git-branches-'))
        const checkout = join(sandbox, 'checkout')
        const remote = join(sandbox, 'remote.git')

        try {
            await mkdir(checkout)
            await runGit(checkout, 'init')
            await runGit(checkout, 'config', 'user.name', 'SHAPI Test')
            await runGit(checkout, 'config', 'user.email', 'test@example.com')
            await writeFile(join(checkout, 'README.md'), '# test\n')
            await runGit(checkout, 'add', 'README.md')
            await runGit(checkout, 'commit', '-m', 'initial')
            await runGit(checkout, 'branch', '-M', 'main')
            await runGit(checkout, 'init', '--bare', remote)
            await runGit(checkout, 'remote', 'add', 'origin', remote)
            await runGit(checkout, 'push', '-u', 'origin', 'main')
            await runGit(checkout, 'switch', '-c', 'feature/local')
            await runGit(checkout, 'switch', 'main')
            await runGit(checkout, 'switch', '-c', 'feature/remote')
            await runGit(checkout, 'push', '-u', 'origin', 'feature/remote')
            await runGit(checkout, 'switch', 'main')
            await runGit(checkout, 'branch', '-D', 'feature/remote')

            await expect(getGitBranchesForCwd(checkout)).resolves.toMatchObject({
                success: true,
                currentBranch: 'main',
                isDirty: false,
                pushRemote: 'origin',
                localBranches: expect.arrayContaining([{ ref: 'feature/local', name: 'feature/local' }]),
                remoteBranches: expect.arrayContaining([{ ref: 'origin/feature/remote', name: 'feature/remote' }])
            })

            await writeFile(join(checkout, 'README.md'), '# changed\n')
            await expect(switchGitBranchForCwd(checkout, {
                target: { kind: 'local', ref: 'feature/local' }
            })).resolves.toMatchObject({
                success: false,
                code: 'dirty_confirmation_required',
                currentBranch: 'main'
            })

            await expect(switchGitBranchForCwd(checkout, {
                target: { kind: 'local', ref: 'feature/local' },
                confirmDirty: true
            })).resolves.toMatchObject({
                success: true,
                currentBranch: 'feature/local'
            })

            await expect(createGitBranchForCwd(checkout, { name: 'feature/new' })).resolves.toMatchObject({
                success: true,
                currentBranch: 'feature/new',
                localBranches: expect.arrayContaining([{ ref: 'feature/new', name: 'feature/new' }])
            })

            await runGit(checkout, 'switch', 'main')
            await expect(switchGitBranchForCwd(checkout, {
                target: { kind: 'remote', ref: 'origin/feature/remote' },
                confirmDirty: true
            })).resolves.toMatchObject({
                success: true,
                currentBranch: 'feature/remote',
                localBranches: expect.arrayContaining([{ ref: 'feature/remote', name: 'feature/remote' }])
            })
        } finally {
            await rm(sandbox, { recursive: true, force: true })
        }
    })

    it('commits all local changes and pushes the current branch through its default remote', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-git-commit-push-'))
        const checkout = join(sandbox, 'checkout')
        const remote = join(sandbox, 'remote.git')

        try {
            await mkdir(checkout)
            await runGit(checkout, 'init')
            await runGit(checkout, 'config', 'user.name', 'SHAPI Test')
            await runGit(checkout, 'config', 'user.email', 'test@example.com')
            await writeFile(join(checkout, 'README.md'), '# test\n')
            await runGit(checkout, 'add', 'README.md')
            await runGit(checkout, 'commit', '-m', 'initial')
            await runGit(checkout, 'branch', '-M', 'main')
            await runGit(checkout, 'init', '--bare', remote)
            await runGit(checkout, 'remote', 'add', 'origin', remote)
            await runGit(checkout, 'push', '-u', 'origin', 'main')

            await writeFile(join(checkout, 'README.md'), '# changed\n')
            await writeFile(join(checkout, 'notes.md'), 'new file\n')

            await expect(commitGitChangesForCwd(checkout, {
                message: 'Save local work'
            })).resolves.toMatchObject({
                success: true,
                currentBranch: 'main',
                isDirty: false,
                changedFileCount: 0,
                pushRemote: 'origin'
            })

            await expect(pushGitBranchForCwd(checkout)).resolves.toMatchObject({
                success: true,
                currentBranch: 'main',
                pushRemote: 'origin'
            })
            const { stdout } = await execFileAsync('git', ['--git-dir', remote, 'log', '-1', '--format=%s'])
            expect(stdout.trim()).toBe('Save local work')
        } finally {
            await rm(sandbox, { recursive: true, force: true })
        }
    })
})
