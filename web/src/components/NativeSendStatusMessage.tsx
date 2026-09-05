import { useEffect, useState } from 'react'

export type NativeSendConnectionPhase = 'launching' | 'matching' | 'connected' | 'retrying'

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
    const [display, setDisplay] = useState({ label: '', text: '', phase: props.phase, startedAt: props.startedAt ?? Date.now() })
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const label = props.phase ? props.label : ''
        if (display.text === label && display.label === label) return
        const timer = window.setTimeout(() => {
            setDisplay((current) => {
                // Finish erasing the old label before beginning the new one.
                if (current.label !== label && current.text) {
                    return { ...current, text: Array.from(current.text).slice(0, -1).join('') }
                }
                if (current.label !== label) {
                    return { label, text: '', phase: props.phase, startedAt: props.startedAt ?? Date.now() }
                }
                if (current.text !== label) {
                    return {
                        ...current,
                        ...(current.text ? {} : { startedAt: props.startedAt ?? Date.now(), phase: props.phase }),
                        text: Array.from(label).slice(0, Array.from(current.text).length + 1).join('')
                    }
                }
                return current
            })
        }, 40)
        return () => window.clearTimeout(timer)
    }, [props.phase, props.label, props.startedAt, display.label, display.text])

    useEffect(() => {
        if (!props.phase && !display.text) return
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1_000)
        return () => window.clearInterval(timer)
    }, [props.phase, Boolean(display.text)])

    if (!display.text && !props.phase) return null

    return (
        <div
            className="flex min-h-6 items-baseline gap-2 break-words text-[var(--app-hint)]"
            data-testid={`codex-direct-send-phase-${display.phase ?? props.phase}`}
            role="status"
            aria-label={props.phase ? props.label : undefined}
        >
            <span aria-hidden="true">{display.text}</span>
            {display.text && display.text === display.label && display.label === props.label && props.phase ? (
                <span className="shrink-0 tabular-nums" aria-hidden="true">
                    {formatNativeSendWait(now - display.startedAt)}
                </span>
            ) : null}
        </div>
    )
}
