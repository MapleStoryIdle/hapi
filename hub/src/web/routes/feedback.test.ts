import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactService } from '../../artifacts/service'
import { KanbanFeedbackService } from '../../kanban/feedback'
import { Store } from '../../store'
import { createPublicFeedbackRoutes } from './feedback'

const dirs: string[] = []

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-kanban-feedback-'))
    dirs.push(dir)
    const store = new Store(':memory:')
    const shares = new ArtifactService(store, dir)
    const feedback = new KanbanFeedbackService(store, dir)
    const published = shares.publish({
        namespace: 'default',
        filename: 'task.md',
        expiresSeconds: 300,
        sourceSessionId: 'source-session',
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
        app: createPublicFeedbackRoutes(store, feedback),
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

    test('does not consume the one-time token when metadata is malformed', async () => {
        const { app, artifactId, token, store } = await setup()
        try {
            const malformed = await app.request(`http://hub/${artifactId}`, {
                method: 'POST',
                headers: headers(token),
                body: '# no contract'
            })
            expect(malformed.status).toBe(404)

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
