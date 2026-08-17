import { isObject } from '@hapi/protocol'
import { getCodexPatchChanges, getCodexPatchTotals } from '@/components/ToolCard/codexPatch'
import { getInputStringAny } from '@/lib/toolInputUtils'

export type FileLineRange = {
    start: number
    end: number
}

export type FileReadTarget = {
    path: string
    lineRange: FileLineRange | null
}

export type FilePatchTarget = {
    path: string
    fileCount: number
    additions: number
    deletions: number
}

const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'file']
const START_LINE_KEYS = ['start_line', 'startLine', 'line_start', 'lineStart']
const END_LINE_KEYS = ['end_line', 'endLine', 'line_end', 'lineEnd']
const OFFSET_KEYS = ['offset', 'line']
const LIMIT_KEYS = ['limit', 'line_limit', 'lineLimit']

function positiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function firstPositiveInteger(record: Record<string, unknown>, keys: string[]): number | null {
    for (const key of keys) {
        const value = positiveInteger(record[key])
        if (value !== null) return value
    }
    return null
}

function lineRangeFromRecord(record: Record<string, unknown>, allowDefaultStart: boolean): FileLineRange | null {
    const start = firstPositiveInteger(record, START_LINE_KEYS)
    const end = firstPositiveInteger(record, END_LINE_KEYS)
    if (start !== null && end !== null && end >= start) {
        return { start, end }
    }

    const nestedRange = [record.line_range, record.lineRange, record.range]
        .find((value): value is Record<string, unknown> => isObject(value))
    if (nestedRange) {
        const nestedStart = firstPositiveInteger(nestedRange, ['start', ...START_LINE_KEYS])
        const nestedEnd = firstPositiveInteger(nestedRange, ['end', ...END_LINE_KEYS])
        if (nestedStart !== null && nestedEnd !== null && nestedEnd >= nestedStart) {
            return { start: nestedStart, end: nestedEnd }
        }
    }

    const limit = firstPositiveInteger(record, LIMIT_KEYS)
    const offset = firstPositiveInteger(record, OFFSET_KEYS) ?? (allowDefaultStart && limit !== null ? 1 : null)
    if (offset !== null && limit !== null) {
        return { start: offset, end: offset + limit - 1 }
    }

    return null
}

function getFilePath(input: unknown): string | null {
    return getInputStringAny(input, FILE_PATH_KEYS)?.trim() || null
}

export function formatFileLineRange(range: FileLineRange | null): string | null {
    if (!range) return null
    return range.start === range.end ? `L${range.start}` : `L${range.start}\u2013${range.end}`
}

export function formatFileReadTarget(target: FileReadTarget, displayPath: string): string {
    const range = formatFileLineRange(target.lineRange)
    return range ? `${displayPath} \u00b7 ${range}` : displayPath
}

/** A native Read tool records an actual file access, so a missing range is valid. */
export function getNativeReadTarget(input: unknown): FileReadTarget | null {
    if (!isObject(input)) return null
    const path = getFilePath(input)
    if (!path) return null

    return {
        path,
        lineRange: lineRangeFromRecord(input, true)
    }
}

function isShellExecutable(value: string): boolean {
    return /(?:^|\/)(?:zsh|bash|sh)$/.test(value)
}

export function getTerminalCommand(input: unknown): string | null {
    if (!isObject(input)) return null
    const command = input.command
    if (Array.isArray(command)) {
        const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
        if (parts.length === 3 && isShellExecutable(parts[0]!) && parts[1] === '-lc') {
            return parts[2]!
        }
        return parts.length > 0 ? parts.join(' ') : null
    }

    const raw = getInputStringAny(input, ['command', 'cmd'])?.trim()
    if (!raw) return null

    const wrapper = raw.match(/^(?:\S*\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)$/)
    if (!wrapper) return raw

    const quote = wrapper[1]!
    const quotedCommand = wrapper[2]!
    if (!quotedCommand.endsWith(quote)) return null
    return quotedCommand.slice(0, -quote.length).trim()
}

function tokenizeSimpleCommand(command: string): string[] | null {
    if (!command || /[\r\n]/.test(command)) return null

    const tokens: string[] = []
    let cursor = 0
    while (cursor < command.length) {
        while (cursor < command.length && /\s/.test(command[cursor]!)) cursor += 1
        if (cursor >= command.length) break

        const quote = command[cursor]
        let token = ''
        if (quote === "'" || quote === '"') {
            const end = command.indexOf(quote, cursor + 1)
            if (end === -1) return null
            token = command.slice(cursor + 1, end)
            cursor = end + 1
            if (cursor < command.length && !/\s/.test(command[cursor]!)) return null
        } else {
            const start = cursor
            while (cursor < command.length && !/\s/.test(command[cursor]!)) cursor += 1
            token = command.slice(start, cursor)
        }

        if (!token || /[;&|<>`$()]/.test(token)) return null
        tokens.push(token)
    }

    return tokens.length > 0 ? tokens : null
}

function validRequestedPath(value: string | undefined): value is string {
    return Boolean(value && value.trim().length > 0 && value !== '--' && !value.startsWith('-'))
}

function getSimpleTerminalReadRequest(command: string): FileReadTarget | null {
    const tokens = tokenizeSimpleCommand(command)
    if (!tokens) return null

    if (tokens[0] === 'cat') {
        const args = tokens.slice(1)
        const path = args[0] === '--' ? args[1] : args[0]
        if (args.length !== (args[0] === '--' ? 2 : 1) || !validRequestedPath(path)) return null
        return { path, lineRange: null }
    }

    if (tokens[0] !== 'sed' || tokens[1] !== '-n') return null
    const expression = tokens[2]
    const range = expression?.match(/^(\d+)(?:,(\d+))?p$/)
    if (!range) return null

    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : start
    const args = tokens.slice(3)
    const path = args[0] === '--' ? args[1] : args[0]
    if (start < 1 || end < start || args.length !== (args[0] === '--' ? 2 : 1) || !validRequestedPath(path)) return null

    return { path, lineRange: { start, end } }
}

function splitSequentialShellCommands(command: string): string[] | null {
    const segments: string[] = []
    let segmentStart = 0
    let quote: "'" | '"' | null = null
    let escaped = false
    let substitutionDepth = 0
    let inBackticks = false

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index]!

        if (escaped) {
            escaped = false
            continue
        }
        if (char === '\\' && quote !== "'") {
            escaped = true
            continue
        }
        if (quote) {
            if (char === quote) quote = null
            continue
        }
        if (inBackticks) {
            if (char === '`') inBackticks = false
            continue
        }
        if (char === '`') {
            inBackticks = true
            continue
        }
        if (char === '$' && command[index + 1] === '(') {
            substitutionDepth += 1
            index += 1
            continue
        }
        if (substitutionDepth > 0) {
            if (char === '(') substitutionDepth += 1
            if (char === ')') substitutionDepth -= 1
            continue
        }
        if (char === "'" || char === '"') {
            quote = char
            continue
        }

        if (char === ';' || char === '\n') {
            const segment = command.slice(segmentStart, index).trim()
            if (segment) segments.push(segment)
            segmentStart = index + 1
            continue
        }
        if (char === '&' && command[index + 1] === '&') {
            const segment = command.slice(segmentStart, index).trim()
            if (segment) segments.push(segment)
            segmentStart = index + 2
            index += 1
            continue
        }
    }

    if (quote || escaped || substitutionDepth > 0 || inBackticks) return null
    const finalSegment = command.slice(segmentStart).trim()
    if (finalSegment) segments.push(finalSegment)
    return segments.length > 0 ? segments : null
}

function changesDirectory(segments: string[]): boolean {
    return segments.some((segment) => {
        const tokens = tokenizeSimpleCommand(segment)
        return tokens?.[0] === 'cd' || tokens?.[0] === 'pushd' || tokens?.[0] === 'popd'
    })
}

/**
 * Shell commands are only requests to read; they do not prove the file was
 * accessed. Accept only explicit cat/sed segments. Sequential shell scripts
 * are supported so the UI can name files without claiming a successful read.
 */
export function getTerminalReadRequests(input: unknown): FileReadTarget[] {
    const command = getTerminalCommand(input)
    if (!command) return []

    const segments = splitSequentialShellCommands(command)
    if (!segments || changesDirectory(segments)) return []

    const targets: FileReadTarget[] = []
    for (const segment of segments) {
        const target = getSimpleTerminalReadRequest(segment)
        if (!target) continue
        if (targets.some((existing) => (
            existing.path === target.path
            && existing.lineRange?.start === target.lineRange?.start
            && existing.lineRange?.end === target.lineRange?.end
        ))) continue
        targets.push(target)
    }
    return targets
}

export function getTerminalReadRequest(input: unknown): FileReadTarget | null {
    return getTerminalReadRequests(input)[0] ?? null
}

/** MCP reads need both a path and a complete line range before being semanticized. */
export function getMcpReadTarget(input: unknown): FileReadTarget | null {
    if (!isObject(input)) return null
    const path = getFilePath(input)
    const lineRange = lineRangeFromRecord(input, false)
    return path && lineRange ? { path, lineRange } : null
}

function isPatchText(value: string): boolean {
    return /(?:^|\n)(?:\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)|diff --git |@@ |--- |\+\+\+ )/.test(value)
}

function extractPatchPath(patch: string): string | null {
    for (const line of patch.split('\n')) {
        const applyPatchPath = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/)?.[1]?.trim()
        if (applyPatchPath) return applyPatchPath

        const unifiedPath = line.match(/^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/)?.[1]?.trim()
        if (unifiedPath && unifiedPath !== '/dev/null') return unifiedPath

        const gitPath = line.match(/^diff --git a\/(.+?) b\/(.+)$/)?.[2]?.trim()
        if (gitPath) return gitPath
    }
    return null
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
    return patch.split('\n').reduce((totals, line) => ({
        additions: totals.additions + (line.startsWith('+') && !line.startsWith('+++') ? 1 : 0),
        deletions: totals.deletions + (line.startsWith('-') && !line.startsWith('---') ? 1 : 0)
    }), { additions: 0, deletions: 0 })
}

/** MCP patches must carry recognizable patch data and a concrete file path. */
export function getMcpPatchTarget(input: unknown): FilePatchTarget | null {
    const changes = getCodexPatchChanges(input).filter((change) => change.diff !== null)
    if (changes.length > 0) {
        const first = changes[0]!
        const totals = getCodexPatchTotals(changes)
        return {
            path: first.path,
            fileCount: changes.length,
            additions: totals.additions,
            deletions: totals.deletions
        }
    }

    if (!isObject(input)) return null
    const patch = getInputStringAny(input, ['patch', 'diff', 'unified_diff'])
    if (!patch || !isPatchText(patch)) return null

    const path = getFilePath(input) ?? extractPatchPath(patch)
    if (!path) return null

    return {
        path,
        fileCount: 1,
        ...countPatchLines(patch)
    }
}
