import type { PushPayload } from './pushService'

/** Accept the full URL copied from Bark; ignore its sample title and body. */
export function parseBarkKey(value: string): string {
    const url = new URL(value.trim())
    if (url.origin !== 'https://api.day.app' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS api.day.app Bark URL')
    const key = url.pathname.split('/').filter(Boolean)[0]
    if (!key || !/^[A-Za-z0-9_-]{8,256}$/.test(key)) throw new Error('Invalid Bark device key')
    return key
}

export async function sendBark(key: string, payload: PushPayload, publicUrl?: string): Promise<void> {
    const link = payload.data?.url && publicUrl ? new URL(payload.data.url, publicUrl).href : undefined
    const response = await fetch('https://api.day.app/push', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_key: key, title: payload.title, body: payload.body, group: 'SHAPI', ...(link ? { url: link } : {}) })
    })
    // Never log the request, response body, key, or user-provided URL.
    if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('Bark delivery failed')
    }
    const reader = response.body.getReader()
    let result = ''
    let bytes = 0
    const decoder = new TextDecoder()
    try {
        while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > 4096) throw new Error('Bark delivery failed')
            result += decoder.decode(chunk.value, { stream: true })
        }
        result += decoder.decode()
        const parsed: unknown = JSON.parse(result)
        if (!parsed || typeof parsed !== 'object' || !('code' in parsed) || parsed.code !== 200) throw new Error('Bark delivery failed')
    } catch {
        throw new Error('Bark delivery failed')
    } finally {
        await reader.cancel()
    }
}
