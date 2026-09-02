/**
 * Opaque runner-local version for a native Codex transcript page. The epoch
 * changes whenever the runner restarts, so revisions from different runners
 * are never compared numerically.
 */
export type CodexLocalSessionSnapshotVersion = {
    runnerEpoch: string
    revision: number
}
