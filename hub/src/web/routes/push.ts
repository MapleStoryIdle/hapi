import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { Store } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { parseBarkKey, sendBark } from '../../push/bark'

const subscriptionSchema = z.object({
    endpoint: z.string().min(1),
    keys: z.object({
        p256dh: z.string().min(1),
        auth: z.string().min(1)
    })
})

const unsubscribeSchema = z.object({
    endpoint: z.string().min(1)
})

export function createPushRoutes(store: Store, vapidPublicKey: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    const pendingBarkTests = new Set<string>()
    app.post('/push/bark/test', async c => {
        c.header('Cache-Control', 'no-store')
        const namespace = c.get('namespace')
        const key = store.push.getBarkKey(namespace)
        if (!key) return c.json({ error: 'Configure Bark before testing' }, 409)
        if (pendingBarkTests.has(namespace)) return c.json({ error: 'A test notification is already sending' }, 429)
        pendingBarkTests.add(namespace)
        try {
            await sendBark(key, { title: 'SHAPI · 测试推送 / Test notification', body: 'Bark 推送已连接 / Bark notifications are connected.' })
            return c.json({ ok: true })
        } catch {
            return c.json({ error: 'Could not send the test notification' }, 502)
        } finally {
            pendingBarkTests.delete(namespace)
        }
    })
    app.use('/push/bark', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'Request too large' }, 413) }))
    app.get('/push/bark', c => {
        c.header('Cache-Control', 'no-store')
        return c.json({ configured: Boolean(store.push.getBarkKey(c.get('namespace'))), enabled: store.push.isBarkEnabled(c.get('namespace')) })
    })
    app.put('/push/bark', async c => {
        c.header('Cache-Control', 'no-store')
        try {
            if (Number(c.req.header('content-length') ?? 0) > 4096) return c.json({ error: 'Request too large' }, 413)
            const raw = await c.req.text()
            if (raw.length > 4096) return c.json({ error: 'Request too large' }, 413)
            const body = z.object({ url: z.string().trim().max(2048).optional(), enabled: z.boolean().optional() }).strict().parse(JSON.parse(raw))
            const namespace = c.get('namespace')
            if (body.url !== undefined) store.push.setBarkKey(namespace, body.url ? parseBarkKey(body.url) : null)
            if (body.enabled !== undefined) store.push.setBarkEnabled(namespace, body.enabled)
            return c.json({ configured: Boolean(store.push.getBarkKey(namespace)), enabled: store.push.isBarkEnabled(namespace) })
        } catch { return c.json({ error: 'Use the HTTPS Bark URL copied from api.day.app' }, 400) }
    })

    app.get('/push/vapid-public-key', (c) => {
        return c.json({ publicKey: vapidPublicKey })
    })

    app.post('/push/subscribe', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = subscriptionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        const { endpoint, keys } = parsed.data
        store.push.addPushSubscription(namespace, {
            endpoint,
            p256dh: keys.p256dh,
            auth: keys.auth
        })

        return c.json({ ok: true })
    })

    app.delete('/push/subscribe', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = unsubscribeSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const namespace = c.get('namespace')
        store.push.removePushSubscription(namespace, parsed.data.endpoint)
        return c.json({ ok: true })
    })

    return app
}
