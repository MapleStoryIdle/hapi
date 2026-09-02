export type NativeSnapshotVersion = {
    runnerEpoch: string
    revision: number
}

export function isNativeSnapshotVersion(value: unknown): value is NativeSnapshotVersion {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return typeof record.runnerEpoch === 'string'
        && record.runnerEpoch.length > 0
        && typeof record.revision === 'number'
        && Number.isSafeInteger(record.revision)
        && record.revision >= 1
}

export function isNativeSnapshotVersionCovered(
    current: NativeSnapshotVersion | null,
    required: NativeSnapshotVersion | null
): boolean {
    if (!required) return false
    return current?.runnerEpoch === required.runnerEpoch
        && current.revision >= required.revision
}

type RefreshRequest = {
    /** Reconcile even when no newer transcript revision is known. */
    authoritative?: boolean
    /** Latest runner version announced by SSE. */
    requiredVersion?: NativeSnapshotVersion | null
    /** Short grace lets a reconnect replay arrive before the HTTP fallback. */
    delayMs?: number
}

export type NativeSnapshotRefreshCoordinator = {
    request: (request?: RefreshRequest) => void
    dispose: () => void
}

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const

function readErrorField(error: unknown, field: 'status' | 'code'): unknown {
    if (!error || typeof error !== 'object') return undefined
    return (error as Record<string, unknown>)[field]
}

/** Retry transport failures, Hub/runner outages, and an offline runner only. */
export function isRetryableNativeSnapshotRefreshError(error: unknown): boolean {
    const status = readErrorField(error, 'status')
    const code = readErrorField(error, 'code')
    if (typeof status === 'number') {
        return status === 408
            || status === 429
            || status >= 500
            || code === 'runner_offline'
            || code === 'no_machine_online'
    }
    return error instanceof TypeError
}

/**
 * Coalesces native-detail recovery signals into one conditional snapshot read.
 * A request already in flight is never cancelled; updates arriving meanwhile
 * become at most one trailing read for the newest required version.
 */
export function createNativeSnapshotRefreshCoordinator(options: {
    getCurrentVersion: () => NativeSnapshotVersion | null
    isVisible: () => boolean
    refresh: () => Promise<void>
    random?: () => number
    shouldRetry?: (error: unknown) => boolean
    maxRetryAttempts?: number
}): NativeSnapshotRefreshCoordinator {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let scheduledAt = Number.POSITIVE_INFINITY
    let inFlight = false
    let pending = false
    let authoritative = false
    let requiredVersion: NativeSnapshotVersion | null = null
    let pendingDelayMs = Number.POSITIVE_INFINITY
    let retryAttempt = 0
    let epochMismatchConfirmationPending = false
    const random = options.random ?? Math.random
    const shouldRetry = options.shouldRetry ?? isRetryableNativeSnapshotRefreshError
    const maxRetryAttempts = options.maxRetryAttempts ?? RETRY_DELAYS_MS.length

    const mergeRequiredVersion = (incoming: NativeSnapshotVersion | null | undefined) => {
        if (!incoming) return
        if (!requiredVersion || requiredVersion.runnerEpoch !== incoming.runnerEpoch) {
            requiredVersion = incoming
            return
        }
        if (incoming.revision > requiredVersion.revision) {
            requiredVersion = incoming
        }
    }

    const clearTimer = () => {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }
        scheduledAt = Number.POSITIVE_INFINITY
    }

    const run = async () => {
        clearTimer()
        if (disposed || inFlight || !pending) return
        if (!options.isVisible()) return

        if (!authoritative && isNativeSnapshotVersionCovered(options.getCurrentVersion(), requiredVersion)) {
            pending = false
            requiredVersion = null
            pendingDelayMs = Number.POSITIVE_INFINITY
            return
        }

        const requestedVersion = requiredVersion
        const isEpochMismatchConfirmation = epochMismatchConfirmationPending
        epochMismatchConfirmationPending = false
        pending = false
        authoritative = false
        requiredVersion = null
        pendingDelayMs = Number.POSITIVE_INFINITY
        inFlight = true
        try {
            await options.refresh()
            retryAttempt = 0
            const currentVersion = options.getCurrentVersion()
            if (
                requestedVersion
                && currentVersion?.runnerEpoch === requestedVersion.runnerEpoch
                && currentVersion.revision < requestedVersion.revision
                && !disposed
            ) {
                pending = true
                mergeRequiredVersion(requestedVersion)
                pendingDelayMs = Math.min(pendingDelayMs, 250)
            } else if (
                requestedVersion
                && (!currentVersion || currentVersion.runnerEpoch !== requestedVersion.runnerEpoch)
                && !isEpochMismatchConfirmation
                && !disposed
            ) {
                // The request may have been pinned to a retiring runner while
                // SSE already announced its replacement. A retiring legacy
                // runner can also return a full snapshot without a version.
                // One bounded authoritative read resolves which runner now
                // owns the session without turning stale replay into a loop.
                pending = true
                authoritative = true
                epochMismatchConfirmationPending = true
                pendingDelayMs = Math.min(pendingDelayMs, 250)
            }
        } catch (error) {
            if (!disposed && shouldRetry(error) && retryAttempt < maxRetryAttempts) {
                pending = true
                authoritative = true
                mergeRequiredVersion(requestedVersion)
                const baseDelay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)]
                retryAttempt += 1
                const jitter = 0.8 + random() * 0.4
                pendingDelayMs = Math.min(pendingDelayMs, Math.round(baseDelay * jitter))
            } else if (!pending) {
                // Permanent errors and exhausted retry rounds wait for a new
                // SSE, foreground, reconnect, or manual recovery signal.
                retryAttempt = 0
            }
        } finally {
            inFlight = false
            if (!disposed && pending && timer === null && options.isVisible()) {
                schedule(Number.isFinite(pendingDelayMs) ? pendingDelayMs : 0)
            }
        }
    }

    const schedule = (delayMs: number) => {
        if (disposed || inFlight || !options.isVisible()) return
        const normalizedDelay = Math.max(0, delayMs)
        const deadline = Date.now() + normalizedDelay
        if (timer !== null && scheduledAt <= deadline) return
        clearTimer()
        scheduledAt = deadline
        timer = setTimeout(() => {
            void run()
        }, normalizedDelay)
    }

    return {
        request(request = {}) {
            if (disposed) return
            if (
                !request.authoritative
                && request.requiredVersion
                && isNativeSnapshotVersionCovered(options.getCurrentVersion(), request.requiredVersion)
            ) {
                return
            }
            mergeRequiredVersion(request.requiredVersion)
            pending = true
            authoritative ||= request.authoritative === true
            pendingDelayMs = Math.min(pendingDelayMs, request.delayMs ?? 250)
            // A fresh transport/event/manual signal should not remain behind
            // an old failure backoff.
            schedule(pendingDelayMs)
        },
        dispose() {
            disposed = true
            clearTimer()
            pending = false
            requiredVersion = null
            pendingDelayMs = Number.POSITIVE_INFINITY
            epochMismatchConfirmationPending = false
        }
    }
}
