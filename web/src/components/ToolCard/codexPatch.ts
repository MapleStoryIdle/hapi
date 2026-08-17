import { isObject } from '@hapi/protocol'
import { getInputStringAny } from '@/lib/toolInputUtils'

export type CodexPatchHunk = {
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
}

export type CodexPatchChange = {
    path: string
    kind: string | null
    diff: string | null
    additions: number
    deletions: number
    hunks: CodexPatchHunk[]
}

function normalizeChangedPath(path: string): string | null {
    const normalized = path
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
        .replace(/^(?:a|b)\//, '')

    return normalized.length > 0 && normalized !== '/dev/null' ? normalized : null
}

function getRecord(value: unknown): Record<string, unknown> | null {
    return Array.isArray(value) || !isObject(value) ? null : value
}

function getChangePath(value: unknown): string | null {
    return getInputStringAny(value, ['path', 'file', 'filePath', 'file_path'])
}

function getChangeKind(value: unknown): string | null {
    const record = getRecord(value)
    if (!record) return null
    if (typeof record.kind === 'string') return record.kind

    const kind = getRecord(record.kind)
    if (kind && typeof kind.type === 'string') return kind.type
    return typeof record.type === 'string' ? record.type : null
}

function getChangeDiff(value: unknown): string | null {
    if (typeof value === 'string') return value
    return getInputStringAny(value, ['diff', 'unified_diff', 'patch'])
}

function parseHunks(diff: string | null): CodexPatchHunk[] {
    if (!diff) return []

    const hunks: CodexPatchHunk[] = []
    for (const line of diff.split('\n')) {
        const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
        if (!match) continue

        hunks.push({
            oldStart: Number(match[1]),
            oldCount: match[2] === undefined ? 1 : Number(match[2]),
            newStart: Number(match[3]),
            newCount: match[4] === undefined ? 1 : Number(match[4])
        })
    }
    return hunks
}

function countChangedLines(diff: string | null): { additions: number; deletions: number } {
    if (!diff) return { additions: 0, deletions: 0 }

    let additions = 0
    let deletions = 0
    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
        if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    }
    return { additions, deletions }
}

function toPatchChange(value: unknown, fallbackPath: string | null): CodexPatchChange | null {
    const path = getChangePath(value) ?? fallbackPath
    if (!path) return null

    const diff = getChangeDiff(value)
    const { additions, deletions } = countChangedLines(diff)
    return {
        path,
        kind: getChangeKind(value),
        diff,
        additions,
        deletions,
        hunks: parseHunks(diff)
    }
}

export function getCodexPatchChanges(input: unknown): CodexPatchChange[] {
    const record = getRecord(input)
    if (!record) return []

    const changes = record.changes
    if (Array.isArray(changes)) {
        return changes.flatMap((change) => {
            const normalized = toPatchChange(change, null)
            return normalized ? [normalized] : []
        })
    }

    const changesRecord = getRecord(changes)
    if (!changesRecord) return []

    const direct = toPatchChange(changesRecord, null)
    if (direct) return [direct]

    return Object.entries(changesRecord).flatMap(([path, change]) => {
        const normalized = toPatchChange(change, path)
        return normalized ? [normalized] : []
    })
}

/**
 * Extract changed paths from Codex's cumulative `turn/diff` payload.  A
 * `CodexPatch` has per-file changes; a `CodexDiff` is the broad fallback
 * emitted by the app server and uses standard unified-diff file headers.
 */
export function getCodexDiffPaths(input: unknown): string[] {
    const unifiedDiff = getInputStringAny(input, ['unified_diff', 'diff', 'patch'])
    if (!unifiedDiff) return []

    const paths: string[] = []
    let oldPath: string | null = null
    for (const line of unifiedDiff.split('\n')) {
        if (line.startsWith('--- ')) {
            oldPath = normalizeChangedPath(line.slice(4).split('\t', 1)[0] ?? '')
            continue
        }
        if (!line.startsWith('+++ ')) continue

        const nextPath = normalizeChangedPath(line.slice(4).split('\t', 1)[0] ?? '')
            ?? oldPath
        oldPath = null
        if (nextPath && !paths.includes(nextPath)) {
            paths.push(nextPath)
        }
    }

    return paths
}

export function isSameCodexChangedPath(left: string, right: string): boolean {
    const normalizedLeft = normalizeChangedPath(left)
    const normalizedRight = normalizeChangedPath(right)
    if (!normalizedLeft || !normalizedRight) return false

    return normalizedLeft === normalizedRight
        || normalizedLeft.endsWith(`/${normalizedRight}`)
        || normalizedRight.endsWith(`/${normalizedLeft}`)
}

export function formatCodexPatchLineRange(start: number, count: number): string {
    if (count <= 0) return `L${start} (empty)`
    if (count === 1) return `L${start}`
    return `L${start}\u2013${start + count - 1}`
}

export function formatCodexPatchHunk(hunk: CodexPatchHunk): string {
    return `${formatCodexPatchLineRange(hunk.oldStart, hunk.oldCount)} \u2192 ${formatCodexPatchLineRange(hunk.newStart, hunk.newCount)}`
}

export function getCodexPatchTotals(changes: CodexPatchChange[]): { additions: number; deletions: number } {
    return changes.reduce((totals, change) => ({
        additions: totals.additions + change.additions,
        deletions: totals.deletions + change.deletions
    }), { additions: 0, deletions: 0 })
}
