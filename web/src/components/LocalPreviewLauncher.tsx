import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { LocalPreviewCandidate } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

function BrowserPreviewIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-5 w-5'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="4.5" width="18" height="15.5" rx="2.5" />
            <path d="M3 9h18" />
            <path d="M7 7h.01" />
            <path d="M10 7h.01" />
            <path d="M13 14h4" />
            <path d="M15 12l2 2-2 2" />
        </svg>
    )
}

function formatCandidate(candidate: LocalPreviewCandidate): string {
    return candidate.title?.trim()
        || `${candidate.protocol}://127.0.0.1:${candidate.port}`
}

export function LocalPreviewLauncher(props: {
    sessionId: string
    candidates: LocalPreviewCandidate[]
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [open, setOpen] = useState(false)
    const candidates = props.candidates

    const openCandidate = useCallback((candidate: LocalPreviewCandidate) => {
        setOpen(false)
        navigate({
            to: '/sessions/$sessionId/preview',
            params: { sessionId: props.sessionId },
            search: {
                port: candidate.port,
                protocol: candidate.protocol,
                path: candidate.path
            }
        })
    }, [navigate, props.sessionId])

    if (candidates.length === 0) return null

    const primary = candidates[0]
    const label = t('localPreview.open')

    return (
        <div className="fixed right-3 top-1/2 z-30 -translate-y-1/2">
            <button
                type="button"
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] shadow-lg shadow-black/10 transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                aria-label={label}
                title={label}
                onClick={() => {
                    if (candidates.length === 1 && primary) {
                        openCandidate(primary)
                        return
                    }
                    setOpen((value) => !value)
                }}
            >
                <BrowserPreviewIcon className="h-5 w-5" />
            </button>

            {open ? (
                <div className="absolute right-12 top-1/2 w-64 -translate-y-1/2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-xl shadow-black/15">
                    <div className="px-2 pb-1 pt-1 text-xs font-medium text-[var(--app-hint)]">
                        {t('localPreview.title')}
                    </div>
                    {candidates.map((candidate) => (
                        <button
                            key={candidate.id}
                            type="button"
                            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                            onClick={() => openCandidate(candidate)}
                        >
                            <BrowserPreviewIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                            <span className="min-w-0 flex-1 truncate">{formatCandidate(candidate)}</span>
                            <span className="shrink-0 text-xs text-[var(--app-hint)]">{candidate.port}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
