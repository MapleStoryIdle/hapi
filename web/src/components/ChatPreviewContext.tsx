import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { LocalServiceSource, OpenLocalServiceRequest } from '@hapi/protocol/localServices'
import { useMobileSheet } from '@/hooks/useMobileSheet'

export type ChatFilePreview = {
    type: 'file'
    api: ApiClient
    source: LocalServiceSource
    path: string
    line?: number
    column?: number
    staged?: boolean
    diff?: boolean
}
export type ChatUrlPreview = {
    type: 'url'
    url: string
    localService?: { api: ApiClient; request: OpenLocalServiceRequest }
}
export type ChatPreview = ChatFilePreview | ChatUrlPreview
const Context = createContext<((preview: ChatPreview) => boolean) | null>(null)
const PreviewDrawer = lazy(() => import('./ChatPreviewDrawer'))

export function useChatPreview() { return useContext(Context) }

export function ChatPreviewProvider({ children }: { children: ReactNode }) {
    const parent = useChatPreview()
    return parent ? <>{children}</> : <PreviewRoot>{children}</PreviewRoot>
}

function PreviewRoot({ children }: { children: ReactNode }) {
    const mobile = useMobileSheet()
    const [preview, setPreview] = useState<ChatPreview | null>(null)
    const [open, setOpen] = useState(false)
    const openPreview = useCallback((next: ChatPreview) => {
        if (!mobile) return false
        setPreview(next)
        setOpen(true)
        return true
    }, [mobile])
    return (
        <Context.Provider value={openPreview}>
            {children}
            {preview ? <Suspense fallback={null}><PreviewDrawer preview={preview} open={open} onOpenChange={setOpen} /></Suspense> : null}
        </Context.Provider>
    )
}

/** Only content web links; keep app navigation, fragments and custom schemes intact. */
export function previewableWebUrl(href: string, origin = window.location.origin): string | null {
    if (!/^(https?:\/\/|\/\/)/i.test(href)) return null
    try {
        const url = new URL(href, origin)
        if (!['http:', 'https:'].includes(url.protocol)) return null
        if (url.username || url.password) return null
        if (url.origin === origin) return null
        return url.href
    } catch { return null }
}
