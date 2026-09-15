import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createManagedSkillsRoutes } from './managedSkills'

function createApp(store: Store, namespace = 'workspace-a') {
    const engine = { getMachinesByNamespace: () => [] } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    app.route('/api', createManagedSkillsRoutes(() => engine, store))
    return app
}

describe('managed Skills routes', () => {
    it('keeps catalog Skills disabled by default and persists a workspace enable', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        try {
            const initial = await app.request('/api/managed-skills')
            const initialBody = await initial.json() as { skills: Array<{ id: string; enabled: boolean }> }
            expect(initialBody.skills.find((skill) => skill.id === 'public-share')).toMatchObject({ enabled: false })
            expect(initialBody.skills.find((skill) => skill.id === 'agent-team')).toMatchObject({ enabled: false })
            expect(initialBody.skills.find((skill) => skill.id === 'git-merge-current-to-target')).toMatchObject({ enabled: false })

            const update = await app.request('/api/managed-skills/public-share', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: true })
            })
            expect(update.status).toBe(200)

            const refreshed = await app.request('/api/managed-skills')
            const refreshedBody = await refreshed.json() as { skills: Array<{ id: string; enabled: boolean }> }
            expect(refreshedBody.skills.find((skill) => skill.id === 'public-share')).toMatchObject({ enabled: true })
        } finally {
            store.close()
        }
    })

    it('publishes personal Skills only into the authenticated workspace', async () => {
        const store = new Store(':memory:')
        const workspaceA = createApp(store, 'workspace-a')
        const workspaceB = createApp(store, 'workspace-b')
        try {
            const publicSkill = store.managedSkillPackages.getActive('public-share')!
            const personalSkill = { ...publicSkill, version: '7.0.0', description: 'Private copy' }
            const publish = await workspaceA.request('/api/managed-skills/personal', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(personalSkill)
            })
            expect(publish.status).toBe(201)

            const catalogA = await workspaceA.request('/api/managed-skills')
            const bodyA = await catalogA.json() as { skills: Array<{ id: string; version: string; visibility: string }> }
            expect(bodyA.skills.find((skill) => skill.id === 'public-share')).toMatchObject({ version: '7.0.0', visibility: 'personal' })

            const catalogB = await workspaceB.request('/api/managed-skills')
            const bodyB = await catalogB.json() as { skills: Array<{ id: string; version: string; visibility: string }> }
            expect(bodyB.skills.find((skill) => skill.id === 'public-share')).toMatchObject({ version: publicSkill.version, visibility: 'public' })
        } finally {
            store.close()
        }
    })
})
