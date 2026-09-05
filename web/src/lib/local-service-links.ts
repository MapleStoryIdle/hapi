import { OpenLocalServiceSchema, parseLocalServiceUrl, type LocalServiceSource, type OpenLocalServiceRequest } from '@hapi/protocol/localServices'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { useContext, type MouseEvent } from 'react'
import { I18nContext } from '@/lib/i18n-context'
import { en } from '@/lib/locales'
import { openLocalServiceInTab } from '@/lib/open-local-service'

export function localServiceLaunchHref(url: string, source: LocalServiceSource, base = import.meta.env.BASE_URL): string | null {
    // mdast encodes IPv6 brackets in generated hrefs. Normalize only the exact
    // loopback authority, never percent-decode an arbitrary destination.
    url = url.replace(/^(https?:\/\/)%5B::1%5D(?=[:/?#]|$)/i, '$1[::1]')
    if (!parseLocalServiceUrl(url)) return null
    const hash = new URLSearchParams({ source: JSON.stringify(source), url })
    // Local URLs may contain private query parameters; keep them out of HTTP logs.
    return `${base.replace(/\/?$/, '/')}local-service#${hash}`
}

export function parseLocalServiceLaunchHash(hash: string): OpenLocalServiceRequest | null {
    if (hash.length > 32_768) return null
    try {
        const params = new URLSearchParams(hash.replace(/^#/, ''))
        const parsed = OpenLocalServiceSchema.safeParse({ source: JSON.parse(params.get('source') ?? ''), url: params.get('url') })
        return parsed.success ? parsed.data : null
    } catch { return null }
}

export function useLocalServiceLink(href: string | undefined): { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void } | null {
    const chat = useOptionalHappyChatContext()
    const i18n = useContext(I18nContext)
    if (!chat || !href) return null
    const source: LocalServiceSource = chat.fileLinkTarget ?? { type: 'session', sessionId: chat.sessionId }
    const launchHref = localServiceLaunchHref(href, source)
    if (!launchHref) return null
    const t = i18n?.t ?? ((key: string) => en[key as keyof typeof en] ?? key)
    return {
        href: launchHref,
        onClick(event) {
            // Copy / context-menu / modifier navigation retains the authenticated route.
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            const request = parseLocalServiceLaunchHash(launchHref.slice(launchHref.indexOf('#')))!
            if (!openLocalServiceInTab(chat.api, request, { title: t('localService.title'), opening: t('localService.opening'), retry: t('localService.retry'), error: (key) => t(key) })) {
                // Popup blocking must not make the link inert. Same-tab fallback keeps login.
                window.location.assign(launchHref)
            }
        }
    }
}
