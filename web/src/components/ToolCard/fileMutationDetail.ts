import { diffLines } from 'diff'
import { isObject } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import { getCodexDiffPaths, getCodexPatchChanges, getCodexPatchTotals } from '@/components/ToolCard/codexPatch'
import { getInputStringAny } from '@/lib/toolInputUtils'
import type { SessionMetadataSummary } from '@/types/api'
import { basename, resolveDisplayPath } from '@/utils/path'

export type FileMutationDialogSummary = {
    fileNames: string[]
    title: string
    additions: number
    deletions: number
}

type ChangeStats = {
    additions: number
    deletions: number
}

function splitLines(value: string): string[] {
    if (value.length === 0) return []
    const lines = value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
}

function countTextChanges(oldText: string, newText: string): ChangeStats {
    return diffLines(oldText, newText).reduce((totals, part) => {
        if (part.added) totals.additions += splitLines(part.value).length
        if (part.removed) totals.deletions += splitLines(part.value).length
        return totals
    }, { additions: 0, deletions: 0 })
}

function countUnifiedDiffChanges(unifiedDiff: string): ChangeStats {
    return unifiedDiff.split('\n').reduce((totals, line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) totals.additions += 1
        if (line.startsWith('-') && !line.startsWith('---')) totals.deletions += 1
        return totals
    }, { additions: 0, deletions: 0 })
}

function sumStats(stats: ChangeStats[]): ChangeStats {
    return stats.reduce((totals, item) => ({
        additions: totals.additions + item.additions,
        deletions: totals.deletions + item.deletions
    }), { additions: 0, deletions: 0 })
}

function getDisplayFileNames(paths: string[], metadata: SessionMetadataSummary | null): string[] {
    return paths
        .map((path) => basename(resolveDisplayPath(path, metadata)))
        .filter((name) => name.length > 0)
}

function createSummary(paths: string[], stats: ChangeStats, metadata: SessionMetadataSummary | null): FileMutationDialogSummary {
    const fileNames = getDisplayFileNames(paths, metadata)
    const firstName = fileNames[0] ?? 'Modified'
    return {
        fileNames,
        title: fileNames.length > 1 ? `${firstName} +${fileNames.length - 1}` : firstName,
        ...stats
    }
}

export function getFileMutationDialogSummary(
    block: ToolCallBlock,
    metadata: SessionMetadataSummary | null
): FileMutationDialogSummary | null {
    if (block.tool.state === 'error') return null

    const input = block.tool.input

    if (block.tool.name === 'CodexPatch') {
        const changes = getCodexPatchChanges(input)
        if (changes.length === 0) return null
        return createSummary(changes.map((change) => change.path), getCodexPatchTotals(changes), metadata)
    }

    if (block.tool.name === 'CodexDiff') {
        const unifiedDiff = getInputStringAny(input, ['unified_diff', 'diff', 'patch'])
        if (!unifiedDiff) return null
        return createSummary(getCodexDiffPaths(input), countUnifiedDiffChanges(unifiedDiff), metadata)
    }

    if (!isObject(input)) return null
    const path = getInputStringAny(input, ['file_path', 'path', 'file', 'filePath'])
    const paths = path ? [path] : []

    if (block.tool.name === 'Edit') {
        if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null
        return createSummary(paths, countTextChanges(input.old_string, input.new_string), metadata)
    }

    if (block.tool.name === 'MultiEdit') {
        if (!Array.isArray(input.edits)) return null
        const stats = input.edits.flatMap((edit) => {
            if (!isObject(edit)) return []
            const oldText = typeof edit.old_string === 'string' ? edit.old_string : ''
            const newText = typeof edit.new_string === 'string' ? edit.new_string : ''
            return oldText.length > 0 || newText.length > 0 ? [countTextChanges(oldText, newText)] : []
        })
        if (stats.length === 0) return null
        return createSummary(paths, sumStats(stats), metadata)
    }

    if (block.tool.name === 'Write') {
        const content = typeof input.content === 'string'
            ? input.content
            : typeof input.text === 'string'
                ? input.text
                : null
        if (content === null) return null
        return createSummary(paths, countTextChanges('', content), metadata)
    }

    return null
}
