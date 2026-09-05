import { SessionThinkingIndicator } from '@/components/SessionThinkingIndicator'

export type NativeSendConnectionPhase = 'launching' | 'matching' | 'connected' | 'retrying'

/** Retained for callers that still provide connection-transition history. */
export type NativeSendStatusEntry = { phase: NativeSendConnectionPhase; label: string; startedAt: number }

export function formatNativeSendWait(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor(seconds / 60) % 60
    const remainder = seconds % 60
    return [hours && `${hours}h`, minutes && `${minutes}m`, remainder && `${remainder}s`]
        .filter(Boolean).join('') || '0s'
}

/**
 * Ephemeral direct-send status. It reflects only the latest runner state:
 * transition history remains accepted for parent compatibility but never
 * delays a reply or replays stale stages.
 */
export function NativeSendStatusMessage(props: {
    phase: NativeSendConnectionPhase | null
    label: string
    startedAt: number | null
    history?: readonly NativeSendStatusEntry[]
    historyStartedAt?: number
    waitingForOutput?: boolean
    waitingStartedAt?: number | null
}) {
    if (props.phase === 'connected' && props.waitingForOutput === true) {
        return <SessionThinkingIndicator startedAt={props.waitingStartedAt} />
    }

    if (!props.phase || !props.label) return null

    return (
        <div data-testid={`codex-direct-send-phase-${props.phase}`}>
            <SessionThinkingIndicator label={props.label} startedAt={props.startedAt} />
        </div>
    )
}
