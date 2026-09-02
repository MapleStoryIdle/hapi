import type { ExternalCodexRequestPayload } from '@hapi/protocol'
import type { PushPayload, PushService } from './pushService'

export type ExternalCodexPushRequest = ExternalCodexRequestPayload & {
    namespace: string
}

const DEFAULT_DEDUPE_WINDOW_MS = 30_000

/**
 * PWA-only notifications for native Codex sessions that are not managed by
 * HAPI. These deliberately bypass the in-app toast / Telegram / ServerChan
 * channels: the source session remains wholly local to Codex.
 */
export class ExternalCodexPushNotifier {
    private readonly recentlySentAt = new Map<string, number>()

    constructor(
        private readonly pushService: PushService,
        private readonly dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
        private readonly now: () => number = () => Date.now()
    ) {}

    async send(request: ExternalCodexPushRequest): Promise<boolean> {
        if (request.phase === 'resolved') {
            return false
        }
        const now = this.now()
        const dedupeKey = [
            request.namespace,
            request.machineId,
            request.codexSessionId,
            request.requestId
        ].join('\u0000')
        const previous = this.recentlySentAt.get(dedupeKey)
        if (previous !== undefined && now - previous < this.dedupeWindowMs) {
            return false
        }

        this.prune(now)
        this.recentlySentAt.set(dedupeKey, now)

        const payload: PushPayload = {
            title: request.kind === 'user-input' ? 'Codex 正在等待你的选择' : 'Codex 正在等待你的确认',
            body: '请回到本机的 Codex 会话继续操作。',
            // Keep one current notification per external Codex thread instead
            // of accumulating stale approval prompts on the phone.
            tag: `external-codex-${request.machineId}-${request.codexSessionId}`,
            data: {
                type: 'external-codex-request',
                sessionId: request.codexSessionId,
                url: this.buildSessionPath(request)
            }
        }

        try {
            await this.pushService.sendToNamespace(request.namespace, payload)
            return true
        } catch (error) {
            this.recentlySentAt.delete(dedupeKey)
            throw error
        }
    }

    private buildSessionPath(request: ExternalCodexPushRequest): string {
        const sessionId = encodeURIComponent(request.codexSessionId)
        const machineId = encodeURIComponent(request.machineId)
        return `/sessions/codex/${sessionId}?machineId=${machineId}`
    }

    private prune(now: number): void {
        const expiry = now - this.dedupeWindowMs
        for (const [key, sentAt] of this.recentlySentAt) {
            if (sentAt < expiry) {
                this.recentlySentAt.delete(key)
            }
        }
    }
}
