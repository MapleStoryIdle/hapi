/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst, NetworkOnly } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import {
    cleanupExpiredShareTransfers,
    ingestShareRequest,
    putShareTransfer,
} from './lib/shareTransfer'
import { shareTargetPathname } from './lib/sharePath'

const sharePath = shareTargetPathname()
const staticAssetsCacheName = 'static-assets'
const legacyPreviewCacheScanLimit = 80
const previewMethods = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'] as const

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<string | { url: string; revision?: string }>
}

type PushPayload = {
    title: string
    body?: string
    icon?: string
    badge?: string
    tag?: string
    data?: {
        type?: string
        sessionId?: string
        url?: string
    }
}

function isPreviewPath(pathname: string): boolean {
    return pathname === '/preview' || pathname.startsWith('/preview/')
}

// Local-service path previews contain a bearer capability in the URL. Keep
// every interceptable request network-only, including uploads.
for (const method of previewMethods) {
    registerRoute(
        ({ url }) => isPreviewPath(url.pathname),
        new NetworkOnly(),
        method
    )
}

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
    ({ request, sameOrigin, url }) => sameOrigin
        && !isPreviewPath(url.pathname)
        && url.pathname.includes('/assets/')
        && ['script', 'style', 'font', 'image'].includes(request.destination),
    new CacheFirst({
        cacheName: staticAssetsCacheName,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 80,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
        ]
    })
)

registerRoute(
    ({ url }) => url.pathname === '/api/sessions',
    new NetworkFirst({
        cacheName: 'api-sessions',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 10,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => /^\/api\/sessions\/[^/]+$/.test(url.pathname),
    new NetworkFirst({
        cacheName: 'api-session-detail',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 20,
                maxAgeSeconds: 60 * 5
            })
        ]
    })
)

registerRoute(
    ({ url }) => url.pathname === '/api/machines',
    new NetworkFirst({
        cacheName: 'api-machines',
        networkTimeoutSeconds: 10,
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 10
            })
        ]
    })
)

registerRoute(
    /^https:\/\/cdn\.socket\.io\/.*/,
    new CacheFirst({
        cacheName: 'cdn-socketio',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 30
            })
        ]
    })
)

registerRoute(
    /^https:\/\/telegram\.org\/.*/,
    new CacheFirst({
        cacheName: 'cdn-telegram',
        plugins: [
            new ExpirationPlugin({
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 7
            })
        ]
    })
)

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting()
    }
})

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            // A prior Service Worker could have put a preview response in the
            // static runtime cache. Do not inspect or clear unrelated caches.
            cleanupLegacyPreviewCache().catch((error) => {
                console.warn('preview cache cleanup failed', error)
            })
        ])
    )
})

self.addEventListener('push', (event) => {
    const payload = event.data?.json() as PushPayload | undefined
    if (!payload) {
        return
    }

    const title = payload.title || 'SHAPI'
    const body = payload.body ?? ''
    const icon = payload.icon ?? '/pwa-192x192.png'
    const badge = payload.badge ?? '/pwa-64x64.png'
    const data = payload.data
    const tag = payload.tag

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge,
            data,
            tag
        })
    )
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: string } | undefined
    const url = data?.url ?? '/'
    event.waitUntil(self.clients.openWindow(url))
})

// Web Share Target — manifest declares POST /share, Android Chrome posts a
// multipart form with title/text/url/files. Stash in IDB so the SPA route
// can read it after the 303 redirect (which converts POST -> GET).
self.addEventListener('fetch', (event) => {
    const request = event.request
    if (request.method !== 'POST') return
    const url = new URL(request.url)
    if (url.pathname !== sharePath) return

    event.respondWith(handleShareTarget(request))
})

async function handleShareTarget(request: Request): Promise<Response> {
    // Resolve to absolute URLs because Response.redirect throws on relative
    // input per the Fetch spec; Chrome currently tolerates relative paths
    // but the SW spec is explicit and the cost of resolving is one line.
    const origin = self.location.origin
    try {
        const { redirectTo } = await ingestShareRequest(request, { put: putShareTransfer })
        return Response.redirect(new URL(redirectTo, origin).toString(), 303)
    } catch (error) {
        // Surface a minimal page if IDB write fails — don't 5xx silently or
        // the user gets a Chrome error sheet instead of useful UI.
        console.error('share-target ingest failed', error)
        return Response.redirect(new URL(`${sharePath}?error=ingest`, origin).toString(), 303)
    }
}

async function cleanupLegacyPreviewCache(): Promise<void> {
    if (!(await caches.keys()).includes(staticAssetsCacheName)) return
    const cache = await caches.open(staticAssetsCacheName)
    const previewRequests = (await cache.keys())
        .filter((request) => isPreviewPath(new URL(request.url).pathname))
        .slice(0, legacyPreviewCacheScanLimit)
    await Promise.all(previewRequests.map((request) => cache.delete(request)))
}

// Best-effort GC for stale share transfers (TTL-only — never blocks
// anything else). 1h TTL is set in shareTransfer.ts.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        cleanupExpiredShareTransfers().catch((error) => {
            console.warn('share-transfer cleanup failed', error)
        })
    )
})
