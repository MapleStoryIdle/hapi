import { ApiError, type ApiClient } from '@/api/client'
import type { OpenLocalServiceRequest } from '@hapi/protocol/localServices'

export function localServiceErrorKey(code: string | null | undefined) {
    return code === 'local_service_not_configured' ? 'localService.notConfigured'
        : code === 'local_service_offline' ? 'localService.offline'
            : code === 'local_service_invalid_url' ? 'localService.invalid'
                : code === 'local_service_busy' ? 'localService.busy'
                    : 'localService.failed'
}

type Labels = { title: string; opening: string; retry: string; error: (key: ReturnType<typeof localServiceErrorKey>) => string }

/** Open synchronously during the tap; authenticate in the existing chat, not
 * in a second browser profile. Only the one-use preview ticket crosses over.
 * Returns false when the browser refuses a controllable new tab.
 */
export function openLocalServiceInTab(api: Pick<ApiClient, 'openLocalService'>, request: OpenLocalServiceRequest, labels: Labels): boolean {
    let popup: Window | null = null
    let message: HTMLParagraphElement
    let retry: HTMLButtonElement
    try {
        popup = window.open('about:blank', '_blank')
        if (!popup || popup.closed) return false
        // Keep our handle for navigation, but never expose the chat to the service.
        popup.opener = null
        const doc = popup.document
        doc.title = labels.title
        const viewport = doc.createElement('meta')
        viewport.name = 'viewport'
        viewport.content = 'width=device-width,initial-scale=1'
        const referrer = doc.createElement('meta')
        referrer.name = 'referrer'
        referrer.content = 'no-referrer'
        doc.head.append(viewport, referrer)
        doc.body.style.cssText = 'margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui;color:CanvasText;background:Canvas;color-scheme:light dark'
        const content = doc.createElement('main')
        content.style.cssText = 'padding:24px;max-width:28rem;text-align:center;overflow-wrap:anywhere'
        message = doc.createElement('p')
        message.setAttribute('role', 'status')
        message.setAttribute('aria-live', 'polite')
        retry = doc.createElement('button')
        retry.type = 'button'
        retry.textContent = labels.retry
        retry.style.cssText = 'min-height:44px;padding:8px 24px;font:inherit;cursor:pointer'
        content.append(message, retry)
        doc.body.replaceChildren(content)
    } catch {
        popup?.close()
        return false
    }
    const target = popup
    let pending = false
    const connect = async () => {
        if (pending || target.closed) return
        pending = true
        message.textContent = labels.opening
        message.setAttribute('role', 'status')
        retry.hidden = true
        retry.disabled = true
        try {
            const result = await api.openLocalService(request)
            if (target.closed) return
            const destination = new URL(result.url)
            if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('Invalid service URL')
            target.location.replace(destination.href)
        } catch (error) {
            if (target.closed) return
            message.textContent = labels.error(localServiceErrorKey(error instanceof ApiError ? error.code : null))
            message.setAttribute('role', 'alert')
            retry.hidden = false
            retry.disabled = false
        } finally { pending = false }
    }
    retry.onclick = () => { void connect() }
    void connect()
    return true
}
