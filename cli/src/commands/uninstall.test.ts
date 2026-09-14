import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const stopRunner = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/runner/controlClient', () => ({ stopRunner }))

import { parseUninstallArgs, uninstallShapi } from './uninstall'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(path => import('node:fs/promises').then(fs => fs.rm(path, { recursive: true, force: true }))))
    vi.clearAllMocks()
})

async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'shapi-uninstall-test-'))
    roots.push(root)
    const bin = join(root, 'bin')
    const hapiHome = join(root, '.hapi')
    const home = join(root, 'home')
    await mkdir(join(hapiHome, 'logs'), { recursive: true })
    await mkdir(join(hapiHome, 'runtime'), { recursive: true })
    await mkdir(join(hapiHome, 'credentials-v2'), { recursive: true })
    await mkdir(bin, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(bin, 'shapi'), 'binary')
    await writeFile(join(bin, 'hapi'), 'binary')
    await writeFile(join(hapiHome, 'credentials-v2', 'runner.json'), 'secret')
    await writeFile(join(home, '.zshrc'), 'before\n# Added by SHAPI installer\nexport PATH="$HOME/.local/bin:$PATH"\nafter\n')
    return { root, bin, hapiHome, homeDir: home, executablePath: join(bin, 'shapi') }
}

describe('uninstall', () => {
    it('parses safe and purge modes', () => {
        expect(parseUninstallArgs([])).toEqual({ purge: false })
        expect(parseUninstallArgs(['--purge'])).toEqual({ purge: true })
        expect(() => parseUninstallArgs(['--all'])).toThrow('Usage')
    })

    it('removes the program and runtime state while preserving credentials by default', async () => {
        const paths = await fixture()
        await uninstallShapi({ purge: false, ...paths, output: vi.fn() })
        expect(stopRunner).toHaveBeenCalledOnce()
        expect(existsSync(join(paths.bin, 'shapi'))).toBe(false)
        expect(existsSync(join(paths.hapiHome, 'logs'))).toBe(false)
        expect(existsSync(join(paths.hapiHome, 'credentials-v2', 'runner.json'))).toBe(true)
        expect(await readFile(join(paths.homeDir, '.zshrc'), 'utf8')).toBe('before\nafter\n')
    })

    it('removes all local state with --purge', async () => {
        const paths = await fixture()
        await uninstallShapi({ purge: true, ...paths, output: vi.fn() })
        expect(existsSync(paths.hapiHome)).toBe(false)
    })
})
