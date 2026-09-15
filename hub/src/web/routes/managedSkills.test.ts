import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { Store } from '../../store'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createManagedSkillsRoutes } from './managedSkills'

function createApp(store: Store) {
    const engine = { getMachinesByNamespace: () => [] } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'workspace-a')
        await next()
    })
    app.route('/api', createManagedSkillsRoutes(() => engine, store))
    return app
}

describe('managed Skills routes', () => {
    it('enables catalog Skills by default and persists a workspace disable', async () => {
        const store = new Store(':memory:')
        const app = createApp(store)
        try {
            const initial = await app.request('/api/managed-skills')
            expect(await initial.json()).toMatchObject({
                skills: [{ id: 'public-share', enabled: true }]
            })

            const update = await app.request('/api/managed-skills/public-share', {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: false })
            })
            expect(update.status).toBe(200)

            const refreshed = await app.request('/api/managed-skills')
            expect(await refreshed.json()).toMatchObject({
                skills: [{ id: 'public-share', enabled: false }]
            })
        } finally {
            store.close()
        }
    })
})
