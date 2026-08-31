import { Hono } from 'hono'
import { basename } from 'node:path'
import { KanbanFeedbackService, MAX_KANBAN_FEEDBACK_BYTES, parseFeedbackMetadata } from '../../kanban/feedback'
import { getConfiguration } from '../../configuration'
import type { PushService } from '../../push/pushService'
import type { Store } from '../../store'

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

function decodeFilename(raw: string | undefined): string | null {
    if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
    try {
        const bytes = Buffer.from(raw, 'base64url')
        if (bytes.length === 0 || bytes.length > 255 || bytes.toString('base64url') !== raw) return null
        const filename = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
        if (filename !== basename(filename) || /[\\/\u0000-\u001f\u007f]/.test(filename)) return null
        return filename
    } catch {
        return null
    }
}

async function readFeedbackBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
    if (!body) return null
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > MAX_KANBAN_FEEDBACK_BYTES) {
                await reader.cancel()
                return null
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    if (length === 0) return null
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}

/**
 * Public, bearer-token based one-time feedback ingress. Every invalid,
 * expired, already-used, or concurrent request receives the same response so
 * it cannot be used to probe task state.
 */
export function createPublicFeedbackRoutes(
    store: Store,
    service?: KanbanFeedbackService,
    pushService?: Pick<PushService, 'sendToNamespace'>
): Hono {
    const app = new Hono()
    const feedback = service ?? new KanbanFeedbackService(store, getConfiguration().dataDir)

    app.post('/:artifactId', async (c) => {
        const artifactId = c.req.param('artifactId')
        const authorization = c.req.header('authorization')
        const token = authorization?.match(/^Bearer\s+([A-Za-z0-9_-]{43,})$/i)?.[1]
        const filename = decodeFilename(c.req.header('x-hapi-feedback-filename'))
        const contentType = c.req.header('content-type')?.toLowerCase() ?? ''
        const contentLength = Number(c.req.header('content-length'))
        if (!/^[a-f0-9]{32}$/.test(artifactId) || !token || !filename || !/^text\/markdown(?:\s*;|$)/.test(contentType) || (!Number.isNaN(contentLength) && (contentLength <= 0 || contentLength > MAX_KANBAN_FEEDBACK_BYTES))) {
            return notFound()
        }

        const bytes = await readFeedbackBody(c.req.raw.body)
        if (!bytes) return notFound()
        const metadata = parseFeedbackMetadata(bytes)
        if (!metadata) return notFound()

        if (!feedback.receive({ artifactId, token, filename, bytes, metadata })) return notFound()

        const task = store.kanbanTasks.find(artifactId)
        if (task) {
            void pushService?.sendToNamespace(task.namespace, {
                title: '看板收到反馈',
                body: '点击查看 Agent 返回的内容。',
                tag: `kanban-feedback-${artifactId}`,
                data: {
                    type: 'kanban-feedback',
                    url: `/shares/${encodeURIComponent(artifactId)}`
                }
            }).catch((error) => {
                console.error('[KanbanFeedback] Failed to send feedback notification:', error)
            })
        }

        return c.json({ ok: true }, 201, SAFETY_HEADERS)
    })

    app.all('*', () => notFound())
    return app
}
