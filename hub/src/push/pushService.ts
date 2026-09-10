import * as webPush from 'web-push'
import type { Store } from '../store'
import type { VapidKeys } from '../config/vapidKeys'
import { sendBark } from './bark'

export type PushPayload = {
    title: string
    body: string
    tag?: string
    data?: {
        type: string
        sessionId?: string
        url: string
    }
}

type StoredSubscription = {
    endpoint: string
    p256dh: string
    auth: string
}

type PushSubscription = {
    endpoint: string
    keys: {
        p256dh: string
        auth: string
    }
}

/**
 * PWA push is the primary notification channel. Bark is a fallback for
 * namespaces that have not subscribed a PWA device yet, avoiding duplicate
 * alerts on a phone that has both configured.
 */
export function shouldSendBarkFallback(subscriptionCount: number, barkKey: string | null): boolean {
    return subscriptionCount === 0 && barkKey !== null
}

export class PushService {
    constructor(
        private readonly vapidKeys: VapidKeys,
        private readonly subject: string,
        private readonly store: Store,
        private readonly publicUrl?: string
    ) {
        webPush.setVapidDetails(this.subject, this.vapidKeys.publicKey, this.vapidKeys.privateKey)
    }

    async sendToNamespace(namespace: string, payload: PushPayload): Promise<void> {
        const subscriptions = this.store.push.getPushSubscriptionsByNamespace(namespace)
        const barkKey = this.store.push.isBarkEnabled(namespace) ? this.store.push.getBarkKey(namespace) : null

        const body = JSON.stringify(payload)
        const deliveries = subscriptions.map((subscription) => {
            return this.sendToSubscription(namespace, subscription, body)
        })
        if (barkKey && shouldSendBarkFallback(subscriptions.length, barkKey)) {
            deliveries.push(sendBark(barkKey, payload, this.publicUrl).catch(() => {
                console.warn('[PushService] Bark delivery failed')
            }))
        }
        await Promise.all(deliveries)
    }

    private async sendToSubscription(
        namespace: string,
        subscription: StoredSubscription,
        body: string
    ): Promise<void> {
        const pushSubscription: PushSubscription = {
            endpoint: subscription.endpoint,
            keys: {
                p256dh: subscription.p256dh,
                auth: subscription.auth
            }
        }

        try {
            await webPush.sendNotification(pushSubscription, body)
        } catch (error) {
            const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
                ? (error as { statusCode: number }).statusCode
                : null

            if (statusCode === 410) {
                this.store.push.removePushSubscription(namespace, subscription.endpoint)
                return
            }

            console.error('[PushService] Failed to send notification:', error)
        }
    }
}
