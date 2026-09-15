import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalHapiHome = process.env.HAPI_HOME
const sandboxes: string[] = []

async function loadSubject() {
    const root = await mkdtemp(join(tmpdir(), 'shapi-managed-skills-'))
    sandboxes.push(root)
    process.env.HAPI_HOME = root
    vi.resetModules()
    return { root, subject: await import('./managedSkills') }
}

afterEach(async () => {
    if (originalHapiHome === undefined) delete process.env.HAPI_HOME
    else process.env.HAPI_HOME = originalHapiHome
    await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('managed skill cache', () => {
    it('caches only inside HAPI_HOME and expands a leading SHAPI skill token', async () => {
        const { root, subject } = await loadSubject()
        const content = '# Test skill\n\nFollow this instruction.'
        const sha256 = createHash('sha256').update(content).digest('hex')

        const result = await subject.reconcileManagedSkill({ id: 'test-skill', version: '1.0.0', sha256, content })

        expect(result.success).toBe(true)
        expect(await readFile(join(root, 'managed-skills', 'test-skill', 'SKILL.md'), 'utf8')).toBe(content)
        expect(subject.expandManagedSkillInvocation('$test-skill do it')).toContain('Follow this instruction.')
        expect(subject.expandManagedSkillInvocation('$test-skill do it')).toContain('User request:\ndo it')
    })

    it('replaces an old SHAPI cache when the Hub version changes', async () => {
        const { subject } = await loadSubject()
        const first = '# First'
        const second = '# Second'
        await subject.reconcileManagedSkill({
            id: 'test-skill', version: '1.0.0', content: first,
            sha256: createHash('sha256').update(first).digest('hex')
        })
        await subject.reconcileManagedSkill({
            id: 'test-skill', version: '1.1.0', content: second,
            sha256: createHash('sha256').update(second).digest('hex')
        })

        const status = await subject.getManagedSkillStatus('test-skill')
        expect(status).toMatchObject({ state: 'ready', version: '1.1.0' })
        expect(subject.expandManagedSkillInvocation('$test-skill')).toContain('# Second')
    })

    it('does not overwrite unmanaged content at the cache path', async () => {
        const { root, subject } = await loadSubject()
        const { mkdir, writeFile } = await import('node:fs/promises')
        const target = join(root, 'managed-skills', 'test-skill')
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'SKILL.md'), '# Mine')
        const content = '# Hub'

        const result = await subject.reconcileManagedSkill({
            id: 'test-skill', version: '1.0.0', content,
            sha256: createHash('sha256').update(content).digest('hex')
        })

        expect(result.success).toBe(false)
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('# Mine')
    })
})
