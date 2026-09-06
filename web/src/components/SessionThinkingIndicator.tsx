import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { useTranslation } from '@/lib/use-translation'

function randomLabelDuration(): number {
    return (12 + Math.floor(Math.random() * 13)) * 1_000
}

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
    showElapsed?: boolean
}) {
    const { locale } = useTranslation()
    const reducedMotion = useReducedMotion() === true
    const mountedAt = useRef(Date.now())
    const startedAt = getStartedAt(props.startedAt, mountedAt.current)
    const [now, setNow] = useState(() => Date.now())
    const [labelIndex, setLabelIndex] = useState(0)
    const suppliedLabel = props.label?.trim() ? props.label : undefined
    const genericLabels = GENERIC_THINKING_LABELS[locale]
    const labelCount = genericLabels.length
    const showElapsed = props.showElapsed !== false

    useEffect(() => {
        setNow(Date.now())
        if (!suppliedLabel) {
            setLabelIndex(Math.floor(Math.random() * labelCount))
        }
        let nextRotationAt = suppliedLabel ? Infinity : Date.now() + randomLabelDuration()
        const timer = window.setInterval(() => {
            const currentTime = Date.now()
            if (showElapsed) setNow(currentTime)
            if (!suppliedLabel && currentTime >= nextRotationAt) {
                // Pick any other phrase equally, without repeating the previous one.
                const offset = 1 + Math.floor(Math.random() * (labelCount - 1))
                setLabelIndex((previous) => (previous + offset) % labelCount)
                nextRotationAt = currentTime + randomLabelDuration()
            }
        }, 1_000)
        return () => window.clearInterval(timer)
    }, [startedAt, suppliedLabel, labelCount, showElapsed])

    const elapsed = Math.max(0, now - startedAt)
    const label = suppliedLabel ?? genericLabels[labelIndex]
    const compact = props.compact === true

    return (
        <span
            className={`session-thinking flex min-w-0 items-center ${compact ? 'min-h-5 gap-1.5 text-xs' : 'min-h-6 gap-2 text-sm'}`}
            data-testid="session-thinking-indicator"
            data-reduced-motion={reducedMotion}
            // Warmth is visual only, never a timeout, error, or progress estimate.
            data-tone={suppliedLabel ? 'default' : 'warm'}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={suppliedLabel ?? genericLabels[0]}
        >
            <svg
                className={`session-thinking__glyph ${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} shrink-0`}
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
            >
                <path
                    d="M12 3v18M3 12h18M7.5 4.2l9 15.6M4.2 7.5l15.6 9M7.5 19.8l9-15.6M4.2 16.5l15.6-9"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                />
            </svg>
            <span
                className={`session-thinking__label min-w-0 font-medium ${suppliedLabel ? 'break-words' : locale === 'zh-CN' ? 'w-[4em] shrink-0' : 'w-[9ch] shrink-0'}`}
                aria-hidden="true"
            >
                {label}
            </span>
            {showElapsed ? (
                <span className="min-w-[6ch] shrink-0 text-right tabular-nums text-[var(--app-hint)]" aria-hidden="true">
                    {formatThinkingDuration(elapsed)}
                </span>
            ) : null}
        </span>
    )
}
