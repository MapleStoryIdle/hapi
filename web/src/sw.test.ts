import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type RouteRegistration = {
    match: unknown
    handler: unknown
    method?: string
}

type EventListener = (event: { waitUntil: (promise: Promise<unknown>) => void }) => void

const state = vi.hoisted(() => {
    class CacheFirst {
        constructor(readonly options?: Record<string, unknown>) {}
    }

    class NetworkFirst {
        constructor(readonly options?: Record<string, unknown>) {}
    }

    class NetworkOnly {
        constructor(readonly options?: Record<string, unknown>) {}
    }

    class ExpirationPlugin {
        constructor(readonly options?: Record<string, unknown>) {}
    }

    return {
        CacheFirst,
        NetworkFirst,
        NetworkOnly,
        ExpirationPlugin,
        routes: [] as RouteRegistration[],
        registrations: [] as Array<{ type: 'route' | 'precache'; method?: string; handler?: unknown }>,
        listeners: new Map<string, EventListener[]>(),
        cleanupExpiredShareTransfers: vi.fn(() => Promise.resolve()),
    }
})

vi.mock('workbox-precaching', () => ({
    precacheAndRoute: vi.fn(() => state.registrations.push({ type: 'precache' })),
}))

vi.mock('workbox-routing', () => ({
    registerRoute: (match: unknown, handler: unknown, method?: string) => {
        state.routes.push({ match, handler, method })
        state.registrations.push({ type: 'route', handler, method })
    },
}))

vi.mock('workbox-strategies', () => ({
    CacheFirst: state.CacheFirst,
    NetworkFirst: state.NetworkFirst,
    NetworkOnly: state.NetworkOnly,
}))

vi.mock('workbox-expiration', () => ({ ExpirationPlugin: state.ExpirationPlugin }))

vi.mock('./lib/shareTransfer', () => ({
    cleanupExpiredShareTransfers: state.cleanupExpiredShareTransfers,
    ingestShareRequest: vi.fn(),
    putShareTransfer: vi.fn(),
}))

vi.mock('./lib/sharePath', () => ({ shareTargetPathname: () => '/share' }))

function routeMatch(route: RouteRegistration, pathname: string, destination = 'script'): unknown {
    if (typeof route.match !== 'function') throw new Error('Expected a callback route matcher')
    return route.match({
        sameOrigin: true,
        url: new URL(`https://hub.example${pathname}`),
        request: { destination },
    })
}

function installServiceWorker(cacheEntries: Array<{ url: string }> = []): { deleted: Array<{ url: string }> } {
    const deleted: Array<{ url: string }> = []
    const listeners = state.listeners
    const cache = {
        keys: vi.fn(async () => cacheEntries),
        delete: vi.fn(async (request: { url: string }) => {
            deleted.push(request)
            return true
        }),
    }

    vi.stubGlobal('caches', {
        keys: vi.fn(async () => ['static-assets']),
        open: vi.fn(async () => cache),
    })
    vi.stubGlobal('self', {
        __WB_MANIFEST: [],
        addEventListener(type: string, listener: EventListener) {
            const registered = listeners.get(type) ?? []
            registered.push(listener)
            listeners.set(type, registered)
        },
        clients: { claim: vi.fn(() => Promise.resolve()) },
        skipWaiting: vi.fn(),
        location: { origin: 'https://hub.example' },
        registration: { showNotification: vi.fn(() => Promise.resolve()) },
    })

    return { deleted }
}

async function loadServiceWorker(): Promise<void> {
    await import('./sw')
}

beforeEach(() => {
    vi.resetModules()
    state.routes.length = 0
    state.registrations.length = 0
    state.listeners.clear()
    state.cleanupExpiredShareTransfers.mockClear()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('local-service preview service-worker bypass', () => {
    it('registers every preview method as NetworkOnly before precache and runtime cache routes', async () => {
        installServiceWorker()
        await loadServiceWorker()

        const previewMethods = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']
        const previewRoutes = state.routes.filter((route) => route.handler instanceof state.NetworkOnly)
        expect(previewRoutes.map((route) => route.method)).toEqual(previewMethods)
        expect(previewRoutes.every((route) => routeMatch(route, '/preview/lease/grant/assets/app.js') === true)).toBe(true)
        expect(previewRoutes.every((route) => routeMatch(route, '/assets/app.js') === false)).toBe(true)

        const staticAssetsRoute = state.routes.find((route) => route.handler instanceof state.CacheFirst
            && (route.handler as InstanceType<typeof state.CacheFirst>).options?.cacheName === 'static-assets')
        expect(staticAssetsRoute).toBeDefined()
        expect(state.registrations.slice(0, previewMethods.length)).toEqual(
            previewMethods.map((method) => ({ type: 'route', handler: expect.any(state.NetworkOnly), method }))
        )
        expect(state.registrations[previewMethods.length]).toEqual({ type: 'precache' })
        expect(state.routes.indexOf(staticAssetsRoute!)).toBeGreaterThan(state.routes.indexOf(previewRoutes.at(-1)!))

        expect(routeMatch(staticAssetsRoute!, '/preview/lease/grant/assets/app.js')).toBe(false)
        expect(routeMatch(staticAssetsRoute!, '/assets/app.js')).toBe(true)
    })

    it('removes legacy preview entries without deleting ordinary static assets', async () => {
        const preview = { url: 'https://hub.example/preview/lease/grant/assets/app.js' }
        const ordinaryAsset = { url: 'https://hub.example/assets/app.js' }
        const { deleted } = installServiceWorker([preview, ordinaryAsset])
        await loadServiceWorker()

        const pending: Promise<unknown>[] = []
        for (const listener of state.listeners.get('activate') ?? []) {
            listener({ waitUntil: (promise) => pending.push(promise) })
        }
        await Promise.all(pending)

        expect(deleted).toEqual([preview])
        expect(deleted).not.toContain(ordinaryAsset)
    })
})
