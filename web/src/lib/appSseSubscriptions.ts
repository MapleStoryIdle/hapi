export type AppGlobalSseSubscription = {
    all: true
}

export type AppSessionSseSubscription = {
    sessionId: string
}

export function getAppGlobalSseSubscription(): AppGlobalSseSubscription {
    return { all: true }
}

export function getAppSessionSseSubscription(
    selectedSessionId: string | null | undefined
): AppSessionSseSubscription | null {
    if (!selectedSessionId) {
        return null
    }
    return { sessionId: selectedSessionId }
}

/**
 * The global stream is a fallback while the selected-session stream starts or
 * reconnects. Once the narrow stream is healthy it owns message delivery, so
 * the same row is not merged twice on the main thread.
 */
export function shouldUseGlobalMessageFallback(input: {
    eventSessionId: string
    selectedSessionId: string | null
    sessionStreamConnected: boolean
}): boolean {
    return input.eventSessionId === input.selectedSessionId
        && !input.sessionStreamConnected
}

export function shouldReconcileMessageSequenceGap(input: {
    knownFrontier: number | null
    incomingSeq: number | null
}): boolean {
    return input.knownFrontier !== null
        && input.incomingSeq !== null
        && input.incomingSeq > input.knownFrontier + 1
}
