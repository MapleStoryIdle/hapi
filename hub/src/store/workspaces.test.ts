import { describe, expect, it } from 'bun:test'
import { Store } from './index'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('WorkspaceStore', () => {
    it('maps legacy namespace tokens to stable workspaces', () => {
        const store = new Store(':memory:')
        store.workspaces.ensureLegacyWorkspace('team-a')
        store.workspaces.bootstrapLegacyCredentials('base')
        const first = store.workspaces.authenticate('base:team-a', 'base', 'web')
        const second = store.workspaces.authenticate('base:team-a', 'base', 'runner')
        expect(first?.workspace.id).toBe(second?.workspace.id)
        expect(first?.workspace.dataNamespace).toBe('team-a')
        expect(store.workspaces.authenticate('wrong:team-a', 'base', 'web')).toBeNull()
        expect(store.workspaces.authenticate('base:unknown-team', 'base', 'web')).toBeNull()
        expect(store.workspaces.authenticate('base:default', 'base', 'web')).toBeNull()
        expect(store.workspaces.revokeKey(first!.workspace.id, first!.accessKeyId)).toBe(true)
        expect(store.workspaces.authenticate('base:team-a', 'base', 'web')).toBeNull()
        store.close()
    })

    it('uses purpose-bound independent credentials', () => {
        const store = new Store(':memory:')
        const workspace = store.workspaces.create('Team A')
        const web = store.workspaces.issueKey(workspace.id, 'web', 'Owner')
        const runner = store.workspaces.issueKey(workspace.id, 'runner', 'Mac mini')
        expect(web.token).toMatch(/^spw[A-Za-z0-9_-]+$/)
        expect(runner.token).toMatch(/^spr[A-Za-z0-9_-]+$/)

        expect(store.workspaces.authenticate(web.token, 'legacy', 'web')?.workspace.id).toBe(workspace.id)
        expect(store.workspaces.authenticate(web.token, 'legacy', 'runner')).toBeNull()
        expect(store.workspaces.authenticate(runner.token, 'legacy', 'runner')?.workspace.id).toBe(workspace.id)
        expect(store.workspaces.authenticate(runner.token, 'legacy', 'web')).toBeNull()
        expect(store.workspaces.revokeKey(workspace.id, runner.id)).toBe(true)
        expect(store.workspaces.authenticate(runner.token, 'legacy', 'runner')).toBeNull()
        store.close()
    })

    it('migrates v28 and registers namespaces that already own data', () => {
        const dir = mkdtempSync(join(tmpdir(), 'shapi-workspace-v29-'))
        const path = join(dir, 'hapi.db')
        const initial = new Store(path)
        initial.sessions.getOrCreateSession('tag', {}, {}, 'team-a')
        initial.close()
        const db = new Database(path)
        db.exec('DROP TABLE workspace_access_keys; DROP TABLE workspaces; PRAGMA user_version=28')
        db.close()

        const migrated = new Store(path)
        expect(migrated.workspaces.getByDataNamespace('team-a')?.name).toBe('team-a')
        expect(migrated.workspaces.authenticate('base:team-a', 'base', 'runner')?.workspace.dataNamespace).toBe('team-a')
        migrated.close()
        rmSync(dir, { recursive: true, force: true })
    })
})
