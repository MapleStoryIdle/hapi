import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'

function RefreshIcon() {
    return (
        <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 4v6h-6" />
        </svg>
    )
}

function buildPreviewSrc(args: {
    baseUrl: string
    sessionId: string
    port: number
    protocol: string
    path: string
    token: string
}): string {
    const path = args.path.startsWith('/') ? args.path : `/${args.path}`
    const url = new URL(
        `/api/preview/sessions/${encodeURIComponent(args.sessionId)}/${args.port}${path}`,
        args.baseUrl || window.location.origin
    )
    url.searchParams.set('hapiPreviewProtocol', args.protocol)
    url.searchParams.set('hapiPreviewToken', args.token)
    return url.toString()
}

export default function SessionPreviewPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/preview' })
    const search = useSearch({ from: '/sessions/$sessionId/preview' })
    const { baseUrl, token } = useAppContext()
    const [reloadKey, setReloadKey] = useState(0)
    const port = search.port
    const protocol = search.protocol ?? 'http'
    const path = search.path ?? '/'

    const src = useMemo(() => {
        if (!port) return null
        return buildPreviewSrc({ baseUrl, sessionId, port, protocol, path, token })
    }, [baseUrl, path, port, protocol, sessionId, token, reloadKey])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
            <SessionDetailHeader
                title={t('localPreview.title')}
                subtitle={port ? `${protocol}://127.0.0.1:${port}${path}` : t('localPreview.empty')}
                onBack={() => navigate({ to: '/sessions/$sessionId', params: { sessionId } })}
                actions={(
                    <button
                        type="button"
                        className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={t('localPreview.refresh')}
                        title={t('localPreview.refresh')}
                        disabled={!src}
                        onClick={() => setReloadKey((value) => value + 1)}
                    >
                        <RefreshIcon />
                    </button>
                )}
            />
            {src ? (
                <iframe
                    key={`${src}:${reloadKey}`}
                    src={src}
                    title={t('localPreview.title')}
                    className="min-h-0 flex-1 border-0 bg-white"
                    sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                />
            ) : (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
                    {t('localPreview.empty')}
                </div>
            )}
        </div>
    )
}
