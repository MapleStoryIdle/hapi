import { useCallback, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Chrome } from 'lucide-react'
import type { LocalPreviewCandidate } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

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
    const edgeOffset = 'max(0.75rem, calc((100% - var(--content-max-w, 960px)) / 2 + 0.75rem))'

    return (
        <div
            className="fixed top-[calc(var(--app-safe-area-top)+4.75rem)] z-30"
            style={{ right: edgeOffset }}
        >
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
                <Chrome className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
            </button>

            {open ? (
                <div className="absolute right-0 top-full mt-2 w-64 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-xl shadow-black/15">
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
                            <Chrome className="h-4 w-4 shrink-0 text-[var(--app-hint)]" strokeWidth={1.8} aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{formatCandidate(candidate)}</span>
                            <span className="shrink-0 text-xs text-[var(--app-hint)]">{candidate.port}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
