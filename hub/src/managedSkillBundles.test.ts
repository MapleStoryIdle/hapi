import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManagedSkillBundle } from './managedSkillBundles'

const directories: string[] = []

async function createBundle(): Promise<string> {
    const parent = mkdtempSync(join(tmpdir(), 'shapi-published-skill-'))
    directories.push(parent)
    const root = join(parent, 'example-skill')
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'hapi.json'), JSON.stringify({
        id: 'example-skill',
        name: 'Example Skill',
        description: 'Example hot-published Skill.',
        descriptions: { 'zh-CN': '热发布技能示例。' },
        version: '1.0.0',
        minimumRunnerVersion: '1.1.1'
    }))
    await writeFile(join(root, 'SKILL.md'), '---\nname: example-skill\ndescription: Example.\n---\n\n# Example\n')
    await writeFile(join(root, 'scripts/check.sh'), '#!/bin/sh\necho ok\n')
    return root
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('managed Skill bundle loading', () => {
    it('loads a standard bundle with localized metadata and executable scripts', async () => {
        const definition = await loadManagedSkillBundle(await createBundle())
        expect(definition).toMatchObject({
            id: 'example-skill',
            descriptions: { 'zh-CN': '热发布技能示例。' }
        })
        expect(definition.files.find((file) => file.path === 'scripts/check.sh')?.executable).toBe(true)
    })

    it('rejects symbolic links in a published bundle', async () => {
        if (process.platform === 'win32') return
        const root = await createBundle()
        await symlink(join(root, 'SKILL.md'), join(root, 'references-link'))
        await expect(loadManagedSkillBundle(root)).rejects.toThrow('Symbolic links')
    })
})
