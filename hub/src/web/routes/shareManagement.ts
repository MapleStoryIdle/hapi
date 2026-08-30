import { Hono } from 'hono'
import type { RevokeShareResponse, ShareDetails, ShareResponse, ShareSummary, SharesResponse } from '@hapi/protocol'
import { ArtifactService } from '../../artifacts/service'
import { getConfiguration } from '../../configuration'
import type { Store, StoredArtifact } from '../../store'
import type { WebAppEnv } from '../middleware/auth'

function toShareSummary(artifact: StoredArtifact): ShareSummary {
    return {
        id: artifact.id,
        filename: artifact.filename,
        size: artifact.size,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt
    }
}

function toShareDetails(artifact: StoredArtifact): ShareDetails {
    return {
        ...toShareSummary(artifact),
        url: artifact.publicUrl
    }
}

export function createShareManagementRoutes(store: Store, injectedShareService?: ArtifactService): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const shares = injectedShareService ?? new ArtifactService(store, getConfiguration().dataDir)

    app.get('/shares', (c) => {
        const response: SharesResponse = {
            shares: store.artifacts.listActive(c.get('namespace')).map(toShareSummary)
        }
        return c.json(response)
    })

    app.get('/shares/:id', (c) => {
        const artifact = store.artifacts.findActive(c.req.param('id'), c.get('namespace'))
        if (!artifact) {
            return c.json({ error: 'Share not found' }, 404)
        }

        const response: ShareResponse = { share: toShareDetails(artifact) }
        return c.json(response)
    })

    app.delete('/shares/:id', (c) => {
        const result = shares.revoke(c.req.param('id'), c.get('namespace'))
        if (result.type === 'not-found') {
            return c.json({ error: 'Share not found' }, 404)
        }

        const response: RevokeShareResponse = {
            ok: true,
            cleanupPending: result.cleanupPending
        }
        return c.json(response, result.cleanupPending ? 202 : 200)
    })

    return app
}
