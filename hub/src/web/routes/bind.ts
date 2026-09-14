import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { getConfiguration } from '../../configuration'
import { validateTelegramInitData } from '../telegramInitData'
import { getOrCreateOwnerId } from '../../config/ownerId'
import type { WebAppEnv } from '../middleware/auth'
import type { Store } from '../../store'
import { bodyLimit } from 'hono/body-limit'

const bindBodySchema = z.object({
    initData: z.string().max(16_384),
    accessToken: z.string().min(1).max(512)
})

export function createBindRoutes(jwtSecret: Uint8Array, store: Store): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('/bind', bodyLimit({ maxSize: 16_384, onError: c => c.json({ error: 'Request too large' }, 413) }))
    app.use('/bind', async (c, next) => { c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); await next() })

    app.post('/bind', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = bindBodySchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const configuration = getConfiguration()
        const access = store.workspaces.authenticate(parsed.data.accessToken, configuration.cliApiToken, 'web')
        if (!access) {
            return c.json({ error: 'Invalid access token' }, 401)
        }
        const namespace = access.workspace.dataNamespace

        if (!configuration.telegramEnabled || !configuration.telegramBotToken) {
            return c.json({ error: 'Telegram authentication is disabled. Configure TELEGRAM_BOT_TOKEN.' }, 503)
        }

        const result = validateTelegramInitData(parsed.data.initData, configuration.telegramBotToken)
        if (!result.ok) {
            return c.json({ error: result.error }, 401)
        }

        const telegramUserId = String(result.user.id)
        const existingUser = store.users.getUser('telegram', telegramUserId)
        if (existingUser && existingUser.namespace !== namespace) {
            return c.json({ error: 'already_bound' }, 409)
        }
        const boundUser = store.users.addUser('telegram', telegramUserId, namespace)
        if (boundUser.namespace !== namespace) return c.json({ error: 'already_bound' }, 409)

        const userId = await getOrCreateOwnerId()

        const token = await new SignJWT({ uid: userId, wid: access.workspace.id, ns: namespace, aid: access.accessKeyId, kind: access.kind })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('4h')
            .sign(jwtSecret)

        return c.json({
            token,
            user: {
                id: userId,
                username: result.user.username,
                firstName: result.user.first_name,
                lastName: result.user.last_name
            }
        })
    })

    return app
}
