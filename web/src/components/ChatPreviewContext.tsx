import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { LocalServiceSource, OpenLocalServiceRequest } from '@hapi/protocol/localServices'
import { useMobileSheet } from '@/hooks/useMobileSheet'

export type ChatFilePreview = {
    type: 'file'
    api: ApiClient
    source: LocalServiceSource
    path: string
    workspacePath?: string | null
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

const APP_ROUTE = /^\/(?:sessions(?:\/|$)|browse(?:\/|$)|memory(?:\/|$)|settings(?:\/|$)|local-service(?:\/|$)|shares?(?:\/|$)|monitors(?:\/|$))/

function appRoutePath(pathname: string): string | null {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    if (!base) return pathname
    if (pathname === base) return '/'
    return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
}

/** Content HTTP(S) links use previews; HAPI routes, fragments and custom schemes keep their own navigation. */
export function previewableWebUrl(href: string, base = window.location.href): string | null {
    if (!href || /^[#?]/.test(href)) return null
    try {
        const url = new URL(href, base)
        if (!['http:', 'https:'].includes(url.protocol)) return null
        if (url.username || url.password) return null
        const routePath = url.origin === new URL(base).origin ? appRoutePath(url.pathname) : null
        if (routePath && (routePath === '/' || APP_ROUTE.test(routePath))) return null
        return url.href
    } catch { return null }
}
