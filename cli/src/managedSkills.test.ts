import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalHapiHome = process.env.HAPI_HOME
const sandbox = mkdtempSync(join(tmpdir(), 'shapi-managed-skills-'))
process.env.HAPI_HOME = sandbox
const subject = await import('./managedSkills')

function digest(content: Uint8Array | string): string {
    return createHash('sha256').update(content).digest('hex')
}

function payload(version: string, entries: Array<{ path: string; content: string; executable?: boolean }>) {
    const files = entries.map((entry) => ({
        path: entry.path,
        contentBase64: Buffer.from(entry.content).toString('base64'),
        sha256: digest(entry.content),
        executable: entry.executable ?? false
    }))
    const manifest = files
        .map(({ path, sha256, executable }) => ({ path, sha256, executable }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return { id: 'test-skill', version, sha256: digest(JSON.stringify(manifest)), files }
}

async function loadSubject() {
    return { root: sandbox, subject }
}

afterEach(async () => {
    await rm(join(sandbox, 'managed-skills'), { recursive: true, force: true })
})

afterAll(async () => {
    if (originalHapiHome === undefined) delete process.env.HAPI_HOME
    else process.env.HAPI_HOME = originalHapiHome
    await rm(sandbox, { recursive: true, force: true })
})

describe('managed skill cache', () => {
    it('atomically caches a standard Skill bundle and expands its leading token', async () => {
        const { root, subject } = await loadSubject()
        const input = payload('1.0.0', [
            { path: 'SKILL.md', content: '# Test skill\n\nRead references/rules.md and run scripts/check.sh.' },
            { path: 'references/rules.md', content: '# Rules\n\nBe careful.' },
            { path: 'scripts/check.sh', content: '#!/bin/sh\necho ok\n', executable: true },
            { path: 'agents/openai.yaml', content: 'interface:\n  display_name: Test\n' },
            { path: 'assets/template.txt', content: 'template' }
        ])

        const result = await subject.reconcileManagedSkill(input)

        expect(result.success).toBe(true)
        const cacheRoot = join(root, 'managed-skills', 'test-skill')
        expect(await readFile(join(cacheRoot, 'SKILL.md'), 'utf8')).toContain('references/rules.md')
        expect(await readFile(join(cacheRoot, 'references/rules.md'), 'utf8')).toContain('Be careful')
        expect((await import('node:fs/promises').then(({ stat }) => stat(join(cacheRoot, 'scripts/check.sh')))).mode & 0o111).not.toBe(0)
        expect(subject.expandManagedSkillInvocation('$test-skill do it')).toContain(`Bundle root: ${cacheRoot}`)
        expect(subject.expandManagedSkillInvocation('$test-skill do it')).toContain('User request:\ndo it')
    })

    it('replaces an old SHAPI cache when the Hub bundle version changes', async () => {
        const { subject } = await loadSubject()
        await subject.reconcileManagedSkill(payload('1.0.0', [{ path: 'SKILL.md', content: '# First' }]))
        await subject.reconcileManagedSkill(payload('1.1.0', [
            { path: 'SKILL.md', content: '# Second' },
            { path: 'references/details.md', content: 'New details' }
        ]))

        const status = await subject.getManagedSkillStatus('test-skill')
        expect(status).toMatchObject({ state: 'ready', version: '1.1.0' })
        expect(subject.expandManagedSkillInvocation('$test-skill')).toContain('# Second')
    })

    it('injects full instructions once per session and refreshes them after an update', async () => {
        const { root, subject } = await loadSubject()
        await subject.reconcileManagedSkill(payload('1.0.0', [{ path: 'SKILL.md', content: '# First' }]))
        const expand = subject.createManagedSkillInvocationExpander()

        const first = expand('$test-skill first request')
        expect(first).toContain('<shapi-managed-skill id="test-skill" version="1.0.0">')
        expect(first).toContain('# First')

        const repeated = expand('$test-skill second request')
        expect(repeated).toContain('<shapi-managed-skill-ref id="test-skill" version="1.0.0">')
        expect(repeated).not.toContain('# First')
        expect(repeated).toContain(join(root, 'managed-skills', 'test-skill', 'SKILL.md'))
        expect(repeated).toContain('User request:\nsecond request')

        await subject.reconcileManagedSkill(payload('1.1.0', [{ path: 'SKILL.md', content: '# Second' }]))
        const updated = expand('$test-skill third request')
        expect(updated).toContain('<shapi-managed-skill id="test-skill" version="1.1.0">')
        expect(updated).toContain('# Second')
        expect(updated).not.toContain('<shapi-managed-skill-ref')
    })

    it('upgrades an intact legacy single-file SHAPI cache', async () => {
        const { root, subject } = await loadSubject()
        const target = join(root, 'managed-skills', 'test-skill')
        const legacyContent = '# Legacy'
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'SKILL.md'), legacyContent)
        await writeFile(join(target, '.shapi-managed.json'), JSON.stringify({
            id: 'test-skill', version: '0.9.0', sha256: digest(legacyContent), managedBy: 'shapi'
        }))

        const result = await subject.reconcileManagedSkill(payload('1.0.0', [{ path: 'SKILL.md', content: '# Bundle' }]))

        expect(result.success).toBe(true)
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('# Bundle')
    })

    it('rejects unsafe paths, executable non-scripts, and modified cached files', async () => {
        const { root, subject } = await loadSubject()
        const traversal = payload('1.0.0', [{ path: 'SKILL.md', content: '# Safe' }, { path: '../escape', content: 'bad' }])
        expect((await subject.reconcileManagedSkill(traversal)).success).toBe(false)
        expect(await access(join(root, 'escape')).then(() => true, () => false)).toBe(false)

        const executableAsset = payload('1.0.0', [{ path: 'SKILL.md', content: '# Safe', executable: true }])
        expect((await subject.reconcileManagedSkill(executableAsset)).success).toBe(false)

        const valid = payload('1.0.0', [{ path: 'SKILL.md', content: '# Hub' }])
        expect((await subject.reconcileManagedSkill(valid)).success).toBe(true)
        await writeFile(join(root, 'managed-skills', 'test-skill', 'SKILL.md'), '# Modified')
        expect(await subject.getManagedSkillStatus('test-skill')).toMatchObject({ state: 'conflict' })
    })

    it('does not overwrite unmanaged content at the cache path', async () => {
        const { root, subject } = await loadSubject()
        const target = join(root, 'managed-skills', 'test-skill')
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'SKILL.md'), '# Mine')

        const result = await subject.reconcileManagedSkill(payload('1.0.0', [{ path: 'SKILL.md', content: '# Hub' }]))

        expect(result.success).toBe(false)
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('# Mine')
    })
})
