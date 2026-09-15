import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { ManagedSkillDefinition } from '@hapi/protocol'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_SKILL_LIBRARY } from '../managedSkillCatalog.generated'
import { managedSkillCatalog } from '../managedSkills'
import { Store } from './index'

function nextVersion(definition: ManagedSkillDefinition, version: string, description: string): ManagedSkillDefinition {
    return { ...definition, version, description }
}

describe('ManagedSkillPackageStore', () => {
    it('seeds bundled Skills and switches active versions without restarting the Store', () => {
        const store = new Store(':memory:')
        try {
            const bundled = MANAGED_SKILL_LIBRARY[0]!
            expect(store.managedSkillPackages.getActive(bundled.id)?.version).toBe(bundled.version)

            const published = nextVersion(bundled, '9.0.0', 'Hot published')
            store.managedSkillPackages.publish(published)
            expect(managedSkillCatalog(store).find((skill) => skill.id === bundled.id)).toMatchObject({
                version: '9.0.0',
                description: 'Hot published',
                visibility: 'public'
            })

            store.managedSkillPackages.activate(bundled.id, bundled.version)
            expect(store.managedSkillPackages.getActive(bundled.id)?.version).toBe(bundled.version)
            expect(store.managedSkillPackages.listVersions(bundled.id)).toHaveLength(2)
        } finally {
            store.close()
        }
    })

    it('keeps personal Skills inside one workspace and lets them override a public id only there', () => {
        const store = new Store(':memory:')
        try {
            const bundled = MANAGED_SKILL_LIBRARY[0]!
            const personal = nextVersion(bundled, '8.0.0', 'Workspace A only')
            store.managedSkillPackages.publish(personal, { namespace: 'workspace-a' })

            expect(store.managedSkillPackages.getActive(bundled.id, 'workspace-a')).toMatchObject({ version: '8.0.0' })
            expect(store.managedSkillPackages.getActive(bundled.id, 'workspace-b')).toMatchObject({ version: bundled.version })
            expect(managedSkillCatalog(store, 'workspace-a').find((skill) => skill.id === bundled.id)).toMatchObject({
                description: 'Workspace A only',
                visibility: 'personal'
            })
            expect(store.managedSkillPackages.listVersions(bundled.id, 'workspace-b')).toEqual([])
        } finally {
            store.close()
        }
    })

    it('keeps a published id and version immutable', () => {
        const store = new Store(':memory:')
        try {
            const bundled = MANAGED_SKILL_LIBRARY[0]!
            const published = nextVersion(bundled, '9.0.0', 'First')
            store.managedSkillPackages.publish(published)
            expect(() => store.managedSkillPackages.publish({ ...published, description: 'Changed' }))
                .toThrow('publish a new version')
        } finally {
            store.close()
        }
    })

    it('makes a package published by another process-visible Store available immediately', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'shapi-hot-skills-'))
        const path = join(directory, 'hapi.db')
        const runningHubStore = new Store(path)
        const publisherStore = new Store(path)
        try {
            const bundled = MANAGED_SKILL_LIBRARY[0]!
            publisherStore.managedSkillPackages.publish(nextVersion(bundled, '9.1.0', 'Published concurrently'))
            expect(managedSkillCatalog(runningHubStore).find((skill) => skill.id === bundled.id)).toMatchObject({
                version: '9.1.0',
                description: 'Published concurrently'
            })
        } finally {
            publisherStore.close()
            runningHubStore.close()
            await rm(directory, { recursive: true, force: true })
        }
    })

    it('migrates a v32 database and seeds the bootstrap catalog', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'shapi-skill-migration-'))
        const path = join(directory, 'hapi.db')
        const initial = new Store(path)
        initial.close()
        const old = new Database(path)
        old.exec('DROP TABLE managed_skill_packages; PRAGMA user_version=32')
        old.close()

        const migrated = new Store(path)
        try {
            expect(migrated.managedSkillPackages.listActive()).toHaveLength(MANAGED_SKILL_LIBRARY.length)
        } finally {
            migrated.close()
            await rm(directory, { recursive: true, force: true })
        }
    })
})
