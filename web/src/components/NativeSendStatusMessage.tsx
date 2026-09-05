import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'

export type NativeSendConnectionPhase = 'launching' | 'matching' | 'connected' | 'retrying'

const CHARACTER_INTERVAL_MS = 40
const MIN_FULL_LABEL_MS = 1_000

export type NativeSendStatusEntry = { phase: NativeSendConnectionPhase; label: string; startedAt: number }
type StatusPlayback = {
    queue: NativeSendStatusEntry[]
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
    history?: readonly NativeSendStatusEntry[]
    historyStartedAt?: number
    waitingForOutput?: boolean
    waitingStartedAt?: number | null
}) {
    const reducedMotion = useReducedMotion() === true
    const [display, setDisplay] = useState<StatusPlayback>({ queue: [], text: '', mode: 'typing', fullyShownAt: null })
    const lastInput = useRef<NativeSendStatusEntry | null>(null)
    const lastQueued = useRef<NativeSendStatusEntry | null>(null)
    const historyCursor = useRef<{ startedAt: number; count: number } | null>(null)
    const localLaunchPending = useRef(false)
    const [now, setNow] = useState(() => Date.now())

    // Record observed transitions instead of chasing only the newest phase.
    // A null phase (real output arrived) drains this local presentation queue;
    // it never delays network delivery or rendering the actual reply.
    useEffect(() => {
        // The runner records transitions before status refreshes are batched.
        // Consume that history even when this render already has real output.
        if (props.history?.length && props.historyStartedAt !== undefined) {
            const previous = historyCursor.current
            const sameSend = previous?.startedAt === props.historyStartedAt
            if (previous && !sameSend && !localLaunchPending.current) lastQueued.current = null
            const unseen = props.history.slice(sameSend ? previous.count : 0)
            historyCursor.current = { startedAt: props.historyStartedAt, count: Math.max(sameSend ? previous.count : 0, props.history.length) }
            localLaunchPending.current = false
            const additions: NativeSendStatusEntry[] = []
            for (const entry of unseen) {
                // The local launch echo and the runner's first launch are one stage.
                if (lastQueued.current?.phase !== entry.phase) additions.push(entry)
                lastQueued.current = entry
            }
            lastInput.current = lastQueued.current
            if (additions.length) setDisplay((current) => ({ ...current, queue: [...current.queue, ...additions] }))
            return
        }
        const next = props.phase && props.label
            ? { phase: props.phase, label: props.label, startedAt: props.startedAt ?? Date.now() }
            : null
        const previous = lastInput.current
        lastInput.current = next
        if (!next || (previous?.phase === next.phase && previous.label === next.label)) return
        localLaunchPending.current = next.phase === 'launching'
        lastQueued.current = next
        setDisplay((current) => ({ ...current, queue: [...current.queue, next] }))
    }, [props.phase, props.label, props.startedAt, props.history, props.historyStartedAt])

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
            && props.phase === entry.phase && props.label === entry.label && !props.waitingForOutput) return

        const delay = display.mode === 'holding'
            ? Math.max(CHARACTER_INTERVAL_MS, (display.fullyShownAt ?? Date.now()) + MIN_FULL_LABEL_MS - Date.now())
            : CHARACTER_INTERVAL_MS
        const timer = window.setTimeout(() => {
            setDisplay((current) => {
                const active = current.queue[0]
                if (!active) return current
                if (current.mode !== 'typing') {
                    const text = reducedMotion ? '' : Array.from(current.text).slice(0, -1).join('')
                    return text
                        ? { ...current, mode: 'erasing', text }
                        : { queue: current.queue.slice(1), text: '', mode: 'typing', fullyShownAt: null }
                }
                const text = reducedMotion ? active.label : Array.from(active.label).slice(0, Array.from(current.text).length + 1).join('')
                return {
                    ...current,
                    text,
                    mode: text === active.label ? 'holding' : 'typing',
                    fullyShownAt: null
                }
            })
        }, delay)
        return () => window.clearTimeout(timer)
    }, [display, entry, props.phase, props.label, props.waitingForOutput, reducedMotion])

    const historyConsumed = !props.history?.length || (historyCursor.current?.startedAt === props.historyStartedAt
        && (historyCursor.current?.count ?? 0) >= props.history.length)
    const waiting = !entry && props.waitingForOutput === true && historyConsumed && lastQueued.current !== null
    const playing = Boolean(entry) || waiting
    useEffect(() => {
        if (!playing) return
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), waiting && !reducedMotion ? 500 : 1_000)
        return () => window.clearInterval(timer)
    }, [playing, waiting, reducedMotion])

    if (waiting) {
        const elapsed = Math.max(0, now - (props.waitingStartedAt ?? now))
        return (
            <div
                className="flex min-h-6 items-baseline gap-2 break-words text-[var(--app-hint)]"
                data-testid="codex-direct-send-phase-reasoning"
                role="status"
                aria-label="Reasoning"
            >
                <span aria-hidden="true">Reasoning<span className="inline-block w-[3ch]">{reducedMotion ? '...' : '.'.repeat(Math.floor(elapsed / 500) % 3 + 1)}</span></span>
                <span className="shrink-0 tabular-nums" aria-hidden="true">{formatNativeSendWait(elapsed)}</span>
            </div>
        )
    }

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
