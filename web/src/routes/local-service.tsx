import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from '@tanstack/react-router'
import type { OpenLocalServiceResponse } from '@hapi/protocol/localServices'
import { ApiError, type ApiClient } from '@/api/client'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { parseLocalServiceLaunchHash } from '@/lib/local-service-links'
import { localServiceErrorKey } from '@/lib/open-local-service'

export default function LocalServicePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const hash = useLocation({ select: (location) => location.hash })
    const request = useMemo(() => parseLocalServiceLaunchHash(hash), [hash])
    const [attempt, setAttempt] = useState(0)
    const [errorCode, setErrorCode] = useState<string | null>(null)
    const pending = useRef<{ key: string; api: ApiClient; promise: Promise<OpenLocalServiceResponse> } | null>(null)

    useEffect(() => {
        if (!request) { setErrorCode('local_service_invalid_url'); return }
        let cancelled = false
        setErrorCode(null)
        const key = `${hash}:${attempt}`
        if (!pending.current || pending.current.key !== key || pending.current.api !== api) {
            pending.current = { key, api, promise: api.openLocalService(request) }
        }
        void pending.current.promise.then((result) => {
            if (cancelled) return
            const destination = new URL(result.url)
            if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('Invalid service URL')
            window.location.replace(result.url)
        }).catch((error: unknown) => {
            if (!cancelled) setErrorCode(error instanceof ApiError ? error.code ?? 'local_service_connect_failed' : 'local_service_connect_failed')
        })
        return () => { cancelled = true }
    }, [api, request, hash, attempt])

    const message = t(localServiceErrorKey(errorCode))

    return (
        <main className="flex min-h-full flex-1 items-center justify-center bg-[var(--app-bg)] p-6 text-[var(--app-fg)]">
            <div className="w-full max-w-sm text-center">
                <h1 className="text-lg font-semibold">{t('localService.title')}</h1>
                {errorCode ? (
                    <>
                        <p className="mt-3 text-base leading-6 text-[var(--app-hint)]" role="alert">{message}</p>
                        <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-6 min-h-11 rounded-full bg-[var(--app-button)] px-6 font-medium text-[var(--app-button-text)] focus-visible:outline-2 focus-visible:outline-offset-2">{t('localService.retry')}</button>
                    </>
                ) : (
                    <p className="mt-3 text-base text-[var(--app-hint)] motion-safe:animate-pulse" role="status" aria-live="polite">{t('localService.opening')}</p>
                )}
                <a href={`${import.meta.env.BASE_URL}sessions`} className="mt-4 inline-flex min-h-11 items-center px-4 text-sm text-[var(--app-hint)]">{t('localService.back')}</a>
            </div>
        </main>
    )
}
