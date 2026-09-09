import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import { readWebPage } from '../../webReader/reader'

/** Registered behind normal Hub authentication. No cookies/authorization are forwarded. */
export function createWebReaderRoutes(read = readWebPage): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    let active = 0
    app.use('/web-reader', bodyLimit({ maxSize: 10000 }))
    app.post('/web-reader', async c => {
        const input = z.object({ url: z.string().min(1).max(8192) }).strict().safeParse(await c.req.json().catch(() => null))
        if (!input.success) return c.json({ error: 'Invalid URL' }, 400)
        if (active >= 4) return c.json({ error: 'Reader busy' }, 429)
        active++
        c.header('Cache-Control', 'no-store')
        try {
            return c.json(await read(input.data.url, c.req.header('origin') ?? new URL(c.req.url).origin, c.req.raw.signal))
        } catch {
            return c.json({ error: 'Unable to read this page', code: 'web_reader_unavailable' }, 502)
        } finally { active-- }
    })
    return app
}
