import type { ToolGroupBlock } from '@/chat/toolGroups'

export type ToolGroupExpansionState = 'auto-open' | 'auto-closed' | 'user-open' | 'user-closed'

export type ToolGroupExpansionStates = Record<string, ToolGroupExpansionState>

export type ToolGroupRunSnapshot = {
    runActive: boolean
    completionKey: string | null
}

function uniqueKeys(keys: readonly string[]): string[] {
    return Array.from(new Set(keys.filter((key) => key.length > 0)))
}

/**
 * A result-details group replaces one or more live tool groups when the turn
 * finishes. Carry source group keys so it inherits the user's choice instead
 * of remounting as an unrelated, closed card.
 */
export function getToolGroupExpansionStateKeys(block: ToolGroupBlock): string[] {
    const declaredKeys = block.expansionStateKeys ?? []
    const keys = uniqueKeys(declaredKeys)
    return keys.length > 0 ? keys : [block.id]
}

export function getPrimaryToolGroupExpansionStateKey(block: ToolGroupBlock): string {
    return getToolGroupExpansionStateKeys(block)[0]!
}

export function isToolGroupExpansionOpen(state: ToolGroupExpansionState): boolean {
    return state === 'auto-open' || state === 'user-open'
}

export function getDefaultToolGroupExpansionState(open: boolean): ToolGroupExpansionState {
    return open ? 'auto-open' : 'auto-closed'
}

/**
 * Prefer the newest explicit user choice when multiple live groups collapse
 * into one completed result-details group. Automatic state is only a fallback.
 */
export function resolveToolGroupExpansionState(
    block: ToolGroupBlock,
    states: ToolGroupExpansionStates | undefined,
    fallback: ToolGroupExpansionState
): ToolGroupExpansionState {
    const keys = getToolGroupExpansionStateKeys(block)

    for (const key of [...keys].reverse()) {
        const state = states?.[key]
        if (state === 'user-open' || state === 'user-closed') {
            return state
        }
    }

    for (const key of [...keys].reverse()) {
        const state = states?.[key]
        if (state) {
            return state
        }
    }

    return fallback
}

/** Only auto-expanded cards close on an explicit completed-turn signal. */
export function closeAutoExpandedToolGroups(states: ToolGroupExpansionStates): ToolGroupExpansionStates {
    let changed = false
    const next: ToolGroupExpansionStates = {}

    for (const [key, state] of Object.entries(states)) {
        const nextState = state === 'auto-open' ? 'auto-closed' : state
        next[key] = nextState
        changed ||= nextState !== state
    }

    return changed ? next : states
}

/**
 * A completion marker can arrive while the session still reports an active
 * turn. The session state wins: consume the marker, but close only after the
 * run becomes idle. The active-to-idle edge is also the fallback when a
 * completion message never reaches the current message window.
 */
export function shouldCloseAutoExpandedToolGroups(
    previous: ToolGroupRunSnapshot,
    current: ToolGroupRunSnapshot
): boolean {
    if (current.runActive) return false
    if (previous.runActive) return true
    return current.completionKey !== null && current.completionKey !== previous.completionKey
}
