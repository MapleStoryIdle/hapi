import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactService } from '../../artifacts/service'
import { KanbanFeedbackService } from '../../kanban/feedback'
import type { PushPayload, PushService } from '../../push/pushService'
import { Store } from '../../store'
import { createPublicFeedbackRoutes } from './feedback'

const dirs: string[] = []

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(pushService?: Pick<PushService, 'sendToNamespace'>) {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-kanban-feedback-'))
    dirs.push(dir)
    const store = new Store(':memory:')
    const shares = new ArtifactService(store, dir)
    const feedback = new KanbanFeedbackService(store, dir)
    const published = shares.publish({
        namespace: 'default',
        filename: 'task.md',
        expiresSeconds: 300,
        source: { type: 'hapi', sessionId: 'source-session' },
        bytes: new TextEncoder().encode('# Task'),
        makePublicUrl: (token) => `https://example.test/s/${token}`,
        feedback: {
            makeFeedbackUrl: (artifactId) => `https://example.test/f/${artifactId}`
        }
    })
    const shared = shares.readPublic(published.token)
    if (!shared) throw new Error('Shared Markdown missing')
    const sharedText = new TextDecoder().decode(shared.bytes)
    const token = /Authorization: Bearer ([A-Za-z0-9_-]+)/.exec(sharedText)?.[1]
    if (!token) throw new Error('Feedback contract token missing from shared Markdown')
    return {
        app: createPublicFeedbackRoutes(store, feedback, pushService),
        artifactId: published.artifact.id,
        token,
        feedback,
        store
    }
}

function body(modelId = 'gpt-test'): string {
    return `---
hapi_feedback: 1
agent:
  name: reviewer
  version: 1.2.3
model:
  provider: openai
  id: ${modelId}
environment:
  os: macOS
  arch: arm64
  runtime: codex-cli
---

## Feedback

No unsafe change proposed.`
}

function headers(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'text/markdown; charset=utf-8',
        'x-hapi-feedback-filename': Buffer.from('review.md', 'utf8').toString('base64url')
    }
}

describe('public Kanban feedback route', () => {
    test('accepts one valid Markdown feedback document and persists self-reported metadata', async () => {
        const { app, artifactId, token, feedback, store } = await setup()
        try {
            const response = await app.request(`http://hub/${artifactId}`, {
                method: 'POST',
                headers: headers(token),
                body: body()
            })
            expect(response.status).toBe(201)
            expect(response.headers.get('cache-control')).toBe('no-store')
            expect(store.kanbanTasks.find(artifactId)?.feedbackTokenHash).not.toBe(token)
            expect(feedback.read(artifactId)).toEqual(expect.objectContaining({
                filename: 'review.md',
                metadata: expect.objectContaining({
                    model: expect.objectContaining({ id: 'gpt-test' })
                })
            }))
        } finally {
            store.close()
        }
    })

    test('returns a safe format error without consuming the one-time token', async () => {
        const { app, artifactId, token, store } = await setup()
        try {
            const missingFilename = await app.request(`http://hub/${artifactId}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'text/markdown; charset=utf-8'
                },
                body: body()
            })
            expect(missingFilename.status).toBe(400)
            expect(await missingFilename.text()).toBe('Feedback format rejected')

            const malformed = await app.request(`http://hub/${artifactId}`, {
                method: 'POST',
                headers: headers(token),
                body: '# no contract'
            })
            expect(malformed.status).toBe(400)
            expect(await malformed.text()).toBe('Feedback format rejected')

            const retry = await app.request(`http://hub/${artifactId}`, {
                method: 'POST',
                headers: headers(token),
                body: body('retry-model')
            })
            expect(retry.status).toBe(201)
        } finally {
            store.close()
        }
    })

    test('notifies the task owner with a deep link after feedback is safely stored', async () => {
        const sendToNamespace = vi.fn<(namespace: string, payload: PushPayload) => Promise<void>>().mockResolvedValue(undefined)
        const pushService: Pick<PushService, 'sendToNamespace'> = { sendToNamespace }
        const { app, artifactId, token, store } = await setup(pushService)
        try {
            const response = await app.request(`http://hub/${artifactId}`, {
                method: 'POST',
                headers: headers(token),
                body: body()
            })

            expect(response.status).toBe(201)
            expect(sendToNamespace).toHaveBeenCalledWith('default', expect.objectContaining({
                title: '看板收到反馈',
                tag: `kanban-feedback-${artifactId}`,
                data: {
                    type: 'kanban-feedback',
                    url: `/shares/${artifactId}`
                }
            }))
        } finally {
            store.close()
        }
    })

    test('permits exactly one concurrent submission for the feedback token', async () => {
        const { app, artifactId, token, store } = await setup()
        try {
            const responses = await Promise.all([
                app.request(`http://hub/${artifactId}`, { method: 'POST', headers: headers(token), body: body('first') }),
                app.request(`http://hub/${artifactId}`, { method: 'POST', headers: headers(token), body: body('second') })
            ])
            expect(responses.map((response) => response.status).sort()).toEqual([201, 404])
            expect((await responses.find((response) => response.status === 404)?.text()) ?? '').toBe('Not found')
        } finally {
            store.close()
        }
    })
})
