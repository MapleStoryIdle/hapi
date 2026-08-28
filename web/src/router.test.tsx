import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from '@tanstack/react-router'
import { createAppRouter } from './router'

describe('recent Codex session route', () => {
    it('resolves the static read-only transcript route before the generic session route', async () => {
        const router = createAppRouter(createMemoryHistory({
            initialEntries: ['/sessions/codex/codex-thread-1?machineId=machine-1']
        }))

        await router.load()

        // 验证静态 codex 前缀不会被 $sessionId 动态路由误判为普通 HAPI 会话。
        const leaf = router.state.matches.at(-1)
        expect(leaf?.routeId).toBe('/sessions/codex/$codexSessionId')
        expect(leaf?.params).toEqual({ codexSessionId: 'codex-thread-1' })
        expect(leaf?.search).toEqual({ machineId: 'machine-1' })
    })

    it('resolves the new-session route used by the sessions header plus button', async () => {
        const router = createAppRouter(createMemoryHistory({
            initialEntries: ['/sessions']
        }))

        await router.load()
        await router.navigate({ to: '/sessions/new', search: { machineId: 'machine-1' } })

        expect(router.state.location.pathname).toBe('/sessions/new')
        expect(router.state.location.search).toEqual({ machineId: 'machine-1' })
        expect(router.state.matches.at(-1)?.routeId).toBe('/sessions/new')
    })
})
