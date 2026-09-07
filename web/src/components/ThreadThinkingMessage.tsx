import { SessionThinkingIndicator } from './SessionThinkingIndicator'

/** One transient row at the end of the thread; never part of the composer. */
export function ThreadThinkingMessage(props: {
    running: boolean
    waitingForUser?: boolean
    /** A Process row already represents the current turn's live activity. */
    hasProcess?: boolean
    label?: string
    startedAt?: number | null
    phase?: string | null
}) {
    // Only a task-owned timestamp is meaningful across navigation. Never freeze
    // the first render's value: authoritative status may arrive later.
    const startedAt = typeof props.startedAt === 'number' && Number.isFinite(props.startedAt)
        && props.startedAt > 0 && props.startedAt <= Date.now() ? props.startedAt : null
    if (!props.running || props.waitingForUser || props.hasProcess) return null
    return (
        <div className="w-full min-w-0 shrink-0 px-2" data-testid="thread-thinking-message">
            <div data-testid={props.phase ? `codex-direct-send-phase-${props.phase}` : undefined}>
                <SessionThinkingIndicator label={props.label} startedAt={startedAt} showElapsed={startedAt !== null} />
            </div>
        </div>
    )
}
