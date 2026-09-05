import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { useTranslation } from '@/lib/use-translation'

const LABEL_ROTATION_MS = 12_000

const GENERIC_THINKING_LABELS = {
    en: ['Thinking', 'Pondering', 'Working'],
    'zh-CN': ['思考中', '推敲中', '处理中']
} as const

function getStartedAt(startedAt: number | null | undefined, fallback: number): number {
    return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : fallback
}

function formatThinkingDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor(seconds / 60) % 60
    const remainder = seconds % 60
    return [hours && `${hours}h`, minutes && `${minutes}m`, remainder && `${remainder}s`]
        .filter(Boolean)
        .join('') || '0s'
}

/**
 * Small, self-contained processing status for a live agent turn. Its timer is
 * intentionally local so a changing elapsed value does not rerender the chat.
 */
export function SessionThinkingIndicator(props: {
    label?: string
    startedAt?: number | null
    compact?: boolean
}) {
    const { locale } = useTranslation()
    const reducedMotion = useReducedMotion() === true
    const mountedAt = useRef(Date.now())
    const labelStartedAt = useRef(Date.now())
    const startedAt = getStartedAt(props.startedAt, mountedAt.current)
    const [now, setNow] = useState(() => Date.now())
    const suppliedLabel = props.label?.trim() ? props.label : undefined

    useEffect(() => {
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1_000)
        return () => window.clearInterval(timer)
    }, [startedAt])

    const genericLabels = GENERIC_THINKING_LABELS[locale]
    const labelIndex = reducedMotion
        ? 0
        : Math.floor(Math.max(0, now - labelStartedAt.current) / LABEL_ROTATION_MS) % genericLabels.length
    const label = suppliedLabel ?? genericLabels[labelIndex]
    const compact = props.compact === true

    return (
        <div
            className={`flex items-center ${compact ? 'min-h-5 gap-1.5 text-xs' : 'min-h-6 gap-2 text-sm'}`}
            data-testid="session-thinking-indicator"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={label}
        >
            <svg
                className={`${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} shrink-0 text-[var(--app-badge-warning-text)] ${reducedMotion ? '' : 'animate-spin'}`}
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
            >
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.85" />
            </svg>
            <span
                className={`shrink-0 font-medium text-[var(--app-badge-warning-text)] ${suppliedLabel ? '' : locale === 'zh-CN' ? 'w-[4em]' : 'w-[9ch]'}`}
                aria-hidden="true"
            >
                {label}
            </span>
            <span className="min-w-[6ch] shrink-0 text-right tabular-nums text-[var(--app-hint)]" aria-hidden="true">
                {formatThinkingDuration(now - startedAt)}
            </span>
        </div>
    )
}
