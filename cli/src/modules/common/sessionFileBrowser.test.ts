import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { browseSessionFiles } from './sessionFileBrowser'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'shapi-file-browser-'))
    directories.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'index.ts'), 'original\n')
    return root
}
it('lists a bounded directory and distinguishes non-Git workspaces', async () => {
    const root = await fixture()
    expect(await browseSessionFiles(root, { action: 'directory' })).toMatchObject({ success: true, entries: [{ name: 'src', type: 'directory' }] })
    expect(await browseSessionFiles(root, { action: 'changes' })).toMatchObject({ success: true, isGitRepository: false })
})
it('rejects traversal, symlink escapes and extra request fields', async () => {
    const root = await fixture()
    await symlink(tmpdir(), join(root, 'outside'))
    for (const path of ['../', tmpdir(), 'outside']) {
        expect(await browseSessionFiles(root, { action: 'directory', path })).toMatchObject({ success: false })
    }
    expect(await browseSessionFiles(root, { action: 'directory', cwd: '/' })).toMatchObject({ success: false })
    expect((await browseSessionFiles(root, { action: 'directory' })).entries?.map(entry => entry.name)).not.toContain('outside')
})
it('reports staged and unstaged files, reads diffs without modifying the index', async () => {
    const root = await fixture()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial')
    await writeFile(join(root, 'src', 'index.ts'), 'updated\n')
    const result = await browseSessionFiles(root, { action: 'changes' })
    expect(result).toMatchObject({ success: true, isGitRepository: true })
    expect(result.unstaged).toContain('src/index.ts')
    const before = git('diff', '--cached')
    expect((await browseSessionFiles(root, { action: 'diff', path: 'src/index.ts' })).stdout).toContain('+updated')
    expect(git('diff', '--cached')).toBe(before)
    git('add', '.')
    expect((await browseSessionFiles(root, { action: 'changes' })).staged).toContain('src/index.ts')
})
it('uses paths relative to a nested session directory', async () => {
    const root = await fixture()
    execFileSync('git', ['init', '-q'], { cwd: root })
    const result = await browseSessionFiles(join(root, 'src'), { action: 'changes' })
    expect(result.status).toContain('? index.ts')
    execFileSync('git', ['add', '.'], { cwd: root })
    expect((await browseSessionFiles(join(root, 'src'), { action: 'changes' })).staged).toContain('\tindex.ts')
    expect((await browseSessionFiles(join(root, 'src'), { action: 'diff', path: 'index.ts', staged: true })).stdout).toContain('+original')
})
