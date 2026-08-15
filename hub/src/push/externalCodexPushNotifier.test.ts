import { describe, expect, it } from 'bun:test'
import { ExternalCodexPushNotifier } from './externalCodexPushNotifier'
import type { PushPayload } from './pushService'

describe('ExternalCodexPushNotifier', () => {
    it('sends a PWA-only generic alert with a read-only Codex deep link', async () => {
        const sent: Array<{ namespace: string; payload: PushPayload }> = []
        const notifier = new ExternalCodexPushNotifier({
            sendToNamespace: async (namespace: string, payload: PushPayload) => {
                sent.push({ namespace, payload })
            }
        } as never)

        await expect(notifier.send({
            namespace: 'team-a',
            machineId: 'machine/a',
            codexSessionId: 'session/1',
            requestId: 'request-1',
            kind: 'permission',
            toolName: 'Bash'
        })).resolves.toBe(true)

        expect(sent).toEqual([{
            namespace: 'team-a',
            payload: {
                title: 'Codex 正在等待你的确认',
                body: '请回到本机的 Codex 会话继续操作。',
                tag: 'external-codex-machine/a-session/1',
                data: {
                    type: 'external-codex-request',
                    sessionId: 'session/1',
                    url: '/sessions/codex/session%2F1?machineId=machine%2Fa'
                }
            }
        }])
    })

    it('deduplicates repeated hook deliveries for the same pending request', async () => {
        let now = 1_000
        const sent: PushPayload[] = []
        const notifier = new ExternalCodexPushNotifier({
            sendToNamespace: async (_namespace: string, payload: PushPayload) => {
                sent.push(payload)
            }
        } as never, 1_000, () => now)
        const request = {
            namespace: 'default',
            machineId: 'machine-1',
            codexSessionId: 'session-1',
            requestId: 'request-1',
            kind: 'user-input' as const
        }

        expect(await notifier.send(request)).toBe(true)
        expect(await notifier.send(request)).toBe(false)
        now += 1_000
        expect(await notifier.send(request)).toBe(true)
        expect(sent).toHaveLength(2)
    })
})
