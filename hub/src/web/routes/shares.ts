import { Hono } from 'hono'
import { ArtifactService, artifactContentType } from '../../artifacts/service'
import type { Store } from '../../store'
import { getConfiguration } from '../../configuration'

const SAFETY_HEADERS = {
    'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "sandbox; default-src 'none'"
}

function notFound(): Response {
    return new Response('Not found', { status: 404, headers: SAFETY_HEADERS })
}

export function createPublicShareRoutes(store: Store, shareService?: ArtifactService): Hono {
    const app = new Hono()
    const shares = shareService ?? new ArtifactService(store, getConfiguration().dataDir)

    app.on(['GET', 'HEAD'], '/:token', (c) => {
        const result = shares.readPublic(c.req.param('token'))
        if (!result) return notFound()

        const content = artifactContentType(result.artifact.filename, result.bytes)
        const headers = new Headers({
            ...SAFETY_HEADERS,
            'Content-Type': content.type,
            'Content-Length': String(result.bytes.length)
        })
        if (!content.inline) headers.set('Content-Disposition', 'attachment')
        return new Response(c.req.method === 'HEAD' ? null : result.bytes, { headers })
    })

    app.all('*', () => notFound())
    return app
}

export function createLegacyPublicShareTombstoneRoutes(): Hono {
    const app = new Hono()
    app.all('*', () => notFound())
    return app
}
