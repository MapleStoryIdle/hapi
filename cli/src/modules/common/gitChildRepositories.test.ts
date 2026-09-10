import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { GitChildRepositoryCache, scanDirectChildRepositories, type ChildRepositoryScan } from './gitChildRepositories'
import { getGitBranchStatusForCwd, isConfirmedNonGitDirectory } from './handlers/git'

const exec = promisify(execFile)

describe('Git directory classification', () => {
    it('only confirms the standard Git non-repository diagnostic', () => {
        expect(isConfirmedNonGitDirectory({ success: false, exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' })).toBe(true)
        expect(isConfirmedNonGitDirectory({ success: false, exitCode: 128, stderr: 'fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n' })).toBe(true)
        for (const stderr of ['fatal: detected dubious ownership in repository', 'fatal: cannot open .git: Permission denied', 'spawn git ENOENT', 'Command timed out', 'fatal: invalid gitfile format: .git']) {
            expect(isConfirmedNonGitDirectory({ success: false, exitCode: 128, stderr })).toBe(false)
        }
    })

    it('reports missing cwd as an error, not a non-Git directory', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-git-missing-'))
        try {
            expect(await getGitBranchStatusForCwd(join(sandbox, 'missing'))).toMatchObject({ success: false, repositoryState: 'error' })
        } finally { await rm(sandbox, { recursive: true, force: true }) }
    })

    it('finds only direct real repositories and supports .git worktree files', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-child-repos-'))
        const root = join(sandbox, 'projects')
        const primary = join(root, 'primary')
        const linked = join(root, 'linked')
        const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd })
        try {
            await mkdir(primary, { recursive: true })
            await git(primary, 'init', '-b', 'main')
            await git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
            await git(primary, 'worktree', 'add', '-b', 'linked', linked)
            const nested = join(root, 'container', 'nested')
            await mkdir(nested, { recursive: true })
            await git(nested, 'init')
            for (const name of ['node_modules', 'dist', 'vendor', '.hidden']) {
                const skipped = join(root, name)
                await mkdir(skipped)
                await git(skipped, 'init')
            }
            await symlink(primary, join(root, 'symlink'), 'dir')
            await mkdir(join(root, 'marker-link'))
            await symlink(join(primary, '.git'), join(root, 'marker-link', '.git'), 'dir')
            expect(await getGitBranchStatusForCwd(root)).toEqual({
                success: true, repositoryState: 'non-git', childRepositories: [
                    { name: 'linked', cwd: linked }, { name: 'primary', cwd: primary }
                ]
            })
            expect(await getGitBranchStatusForCwd(linked)).toMatchObject({ success: true, repositoryState: 'git', isWorktree: true })
            expect(await getGitBranchStatusForCwd(primary)).toMatchObject({ isDirty: false })
            await writeFile(join(primary, 'new.txt'), 'dirty')
            expect(await getGitBranchStatusForCwd(primary)).toMatchObject({ isDirty: true })
            await mkdir(join(root, 'broken'))
            await writeFile(join(root, 'broken', '.git'), 'invalid git file')
            expect(await scanDirectChildRepositories(root)).toMatchObject({ childRepositoriesError: expect.any(String) })
        } finally { await rm(sandbox, { recursive: true, force: true }) }
    })

    it('caps large directory scans and reports partial inventories', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'hapi-child-limit-'))
        try {
            for (let i = 0; i < 513; i++) await mkdir(join(sandbox, `folder-${i}`))
            expect(await scanDirectChildRepositories(sandbox)).toEqual({ childRepositories: [], childRepositoriesTruncated: true })
        } finally { await rm(sandbox, { recursive: true, force: true }) }
    })
})

describe('Runner child repository cache', () => {
    it('deduplicates concurrent requests and expires inventory after five minutes', async () => {
        let now = 0
        const scan = vi.fn(async (): Promise<ChildRepositoryScan> => ({ childRepositories: [] }))
        const cache = new GitChildRepositoryCache(scan, () => now)
        await Promise.all([cache.get('/project'), cache.get('/project'), cache.get('/project/')])
        expect(scan).toHaveBeenCalledTimes(1)
        now = 299_999
        await cache.get('/project')
        expect(scan).toHaveBeenCalledTimes(1)
        now = 300_000
        await cache.get('/project')
        expect(scan).toHaveBeenCalledTimes(2)
    })

    it('bounds active scans and queued work, and releases slots on failure', async () => {
        const resolvers: Array<(value: ChildRepositoryScan) => void> = []
        const scan = vi.fn(() => new Promise<ChildRepositoryScan>(resolve => { resolvers.push(resolve) }))
        const cache = new GitChildRepositoryCache(scan)
        const pending = Array.from({ length: 6 }, (_, i) => cache.get(`/p${i}`))
        expect(scan).toHaveBeenCalledTimes(2)
        expect(await cache.get('/overflow')).toMatchObject({ childRepositoriesError: expect.any(String) })
        for (let i = 0; i < 6; i++) {
            resolvers[i]!({ childRepositories: [] })
            await pending[i]
        }
        expect(scan).toHaveBeenCalledTimes(6)
        const failing = vi.fn(async (): Promise<ChildRepositoryScan> => { throw new Error('unreadable') })
        const retrying = new GitChildRepositoryCache(failing)
        await retrying.get('/failure')
        await retrying.get('/failure')
        expect(failing).toHaveBeenCalledTimes(2)
    })

    it('bounds cached directory inventories', async () => {
        const scan = vi.fn(async (): Promise<ChildRepositoryScan> => ({ childRepositories: [] }))
        const cache = new GitChildRepositoryCache(scan)
        for (let i = 0; i < 129; i++) await cache.get(`/p${i}`)
        await cache.get('/p0')
        expect(scan).toHaveBeenCalledTimes(130)
    })
})
