import { useEffect, useRef, useState } from 'react'

export type NativeSendConnectionPhase = 'launching' | 'matching' | 'connected' | 'retrying'

const CHARACTER_INTERVAL_MS = 40
const MIN_FULL_LABEL_MS = 1_000

type StatusEntry = { phase: NativeSendConnectionPhase; label: string; startedAt: number }
type StatusPlayback = {
    queue: StatusEntry[]
    text: string
    mode: 'typing' | 'holding' | 'erasing'
    fullyShownAt: number | null
}

export function formatNativeSendWait(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor(seconds / 60) % 60
    const remainder = seconds % 60
    return [hours && `${hours}h`, minutes && `${minutes}m`, remainder && `${remainder}s`]
        .filter(Boolean).join('') || '0s'
}

/** Ephemeral assistant row; only this row rerenders while typing or timing. */
export function NativeSendStatusMessage(props: {
    phase: NativeSendConnectionPhase | null
    label: string
    startedAt: number | null
}) {
    const [display, setDisplay] = useState<StatusPlayback>({ queue: [], text: '', mode: 'typing', fullyShownAt: null })
    const lastInput = useRef<StatusEntry | null>(null)
    const [now, setNow] = useState(() => Date.now())

    // Record observed transitions instead of chasing only the newest phase.
    // A null phase (real output arrived) drains this local presentation queue;
    // it never delays network delivery or rendering the actual reply.
    useEffect(() => {
        const next = props.phase && props.label
            ? { phase: props.phase, label: props.label, startedAt: props.startedAt ?? Date.now() }
            : null
        const previous = lastInput.current
        lastInput.current = next
        if (!next || (previous?.phase === next.phase && previous.label === next.label)) return
        setDisplay((current) => ({ ...current, queue: [...current.queue, next] }))
    }, [props.phase, props.label, props.startedAt])

    const entry = display.queue[0]
    useEffect(() => {
        if (!entry) return
        // Start the minimum hold after the complete label has been committed,
        // not while React is still preparing the final character.
        if (display.mode === 'holding' && display.fullyShownAt === null) {
            setDisplay((current) => ({ ...current, fullyShownAt: Date.now() }))
            return
        }
        if (display.mode === 'holding' && display.queue.length === 1
            && props.phase === entry.phase && props.label === entry.label) return

        const delay = display.mode === 'holding'
            ? Math.max(CHARACTER_INTERVAL_MS, (display.fullyShownAt ?? Date.now()) + MIN_FULL_LABEL_MS - Date.now())
            : CHARACTER_INTERVAL_MS
        const timer = window.setTimeout(() => {
            setDisplay((current) => {
                const active = current.queue[0]
                if (!active) return current
                if (current.mode !== 'typing') {
                    const text = Array.from(current.text).slice(0, -1).join('')
                    return text
                        ? { ...current, mode: 'erasing', text }
                        : { queue: current.queue.slice(1), text: '', mode: 'typing', fullyShownAt: null }
                }
                const text = Array.from(active.label).slice(0, Array.from(current.text).length + 1).join('')
                return {
                    ...current,
                    text,
                    mode: text === active.label ? 'holding' : 'typing',
                    fullyShownAt: null
                }
            })
        }, delay)
        return () => window.clearTimeout(timer)
    }, [display, entry, props.phase, props.label])

    const playing = Boolean(entry)
    useEffect(() => {
        if (!playing) return
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1_000)
        return () => window.clearInterval(timer)
    }, [playing])

    if (!entry) return null

    return (
        <div
            className="flex min-h-6 items-baseline gap-2 break-words text-[var(--app-hint)]"
            data-testid={`codex-direct-send-phase-${entry.phase}`}
            role="status"
            aria-label={entry.label}
        >
            <span aria-hidden="true">{display.text}</span>
            {display.mode === 'holding' ? (
                <span className="shrink-0 tabular-nums" aria-hidden="true">
                    {formatNativeSendWait(now - entry.startedAt)}
                </span>
            ) : null}
        </div>
    )
}
