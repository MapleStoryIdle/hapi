import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { FileDiffIcon } from '@/components/ToolCard/icons'

export type GitCodeBlockStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export type GitCodeBlockFile = {
    path: string
    oldPath?: string
    status: GitCodeBlockStatus
    added: number
    removed: number
}

export type GitCodeBlockSummary = {
    kind: 'status' | 'diff'
    files: GitCodeBlockFile[]
    added: number
    removed: number
}

const VISIBLE_ROW_LIMIT = 6

function normalizeCodeLines(code: string): string[] {
    return code
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
}

function statusFromShortCode(code: string): GitCodeBlockStatus | null {
    if (code.includes('U')) return 'conflicted'
    if (code.includes('?')) return 'untracked'
    if (code.includes('R')) return 'renamed'
    if (code.includes('D')) return 'deleted'
    if (code.includes('A')) return 'added'
    if (code.includes('M')) return 'modified'
    return null
}

function parseTrailingCounts(text: string): { path: string; added: number; removed: number } {
    const match = text.match(/^(.*?)\s+\+(\d+)\s+-(\d+)$/)
    if (!match) {
        return { path: text.trim(), added: 0, removed: 0 }
    }
    return {
        path: match[1].trim(),
        added: Number(match[2]),
        removed: Number(match[3])
    }
}

function parseGitStatusBlock(code: string): GitCodeBlockSummary | null {
    const lines = normalizeCodeLines(code)
    if (lines.length === 0) return null

    const files: GitCodeBlockFile[] = []
    for (const line of lines) {
        if (line.startsWith('## ')) {
            continue
        }

        const match = line.match(/^([ MADRCU?!]{1,2})\s+(.+)$/)
        if (!match) return null

        const status = statusFromShortCode(match[1])
        if (!status) return null

        const parsed = parseTrailingCounts(match[2])
        const renameParts = parsed.path.split(/\s+->\s+/)
        files.push({
            path: renameParts[1] ?? parsed.path,
            oldPath: renameParts[1] ? renameParts[0] : undefined,
            status,
            added: parsed.added,
            removed: parsed.removed
        })
    }

    if (files.length === 0) return null

    return {
        kind: 'status',
        files,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0)
    }
}

function stripGitPrefix(path: string): string {
    return path.replace(/^[ab]\//, '')
}

function parseDiffHeader(line: string): string | null {
    const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/)
    if (!match) return null
    return match[2]
}

function parseGitDiffBlock(code: string): GitCodeBlockSummary | null {
    if (!code.includes('diff --git') && !code.includes('@@')) return null

    const lines = code.replace(/\r\n/g, '\n').split('\n')
    const files: GitCodeBlockFile[] = []

    for (const line of lines) {
        const diffPath = parseDiffHeader(line)
        if (diffPath) {
            files.push({
                path: diffPath,
                status: 'modified',
                added: 0,
                removed: 0
            })
            continue
        }

        const current = files[files.length - 1]
        if (!current) continue

        if (line.startsWith('new file mode')) {
            current.status = 'added'
            continue
        }
        if (line.startsWith('deleted file mode')) {
            current.status = 'deleted'
            continue
        }
        if (line.startsWith('rename from ')) {
            current.status = 'renamed'
            current.oldPath = line.slice('rename from '.length).trim()
            continue
        }
        if (line.startsWith('rename to ')) {
            current.status = 'renamed'
            current.path = line.slice('rename to '.length).trim()
            continue
        }
        if (line.startsWith('+++ ')) {
            const nextPath = stripGitPrefix(line.slice(4).trim())
            if (nextPath && nextPath !== '/dev/null') {
                current.path = nextPath
            }
            continue
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
            current.added += 1
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            current.removed += 1
        }
    }

    if (files.length === 0) return null

    return {
        kind: 'diff',
        files,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0)
    }
}

function parseDiffStatTotals(line: string): { added: number; removed: number } | null {
    if (!/\bfiles? changed\b/.test(line)) return null

    return {
        added: Number(line.match(/(\d+)\s+insertions?\(\+\)/)?.[1] ?? 0),
        removed: Number(line.match(/(\d+)\s+deletions?\(-\)/)?.[1] ?? 0)
    }
}

function parseGitDiffStatBlock(code: string): GitCodeBlockSummary | null {
    const lines = normalizeCodeLines(code)
    if (lines.length === 0) return null

    const files: GitCodeBlockFile[] = []
    let summaryTotals: { added: number; removed: number } | null = null

    for (const line of lines) {
        const totals = parseDiffStatTotals(line)
        if (totals) {
            summaryTotals = totals
            continue
        }

        const numstatMatch = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/)
        if (numstatMatch) {
            const added = numstatMatch[1] === '-' ? 0 : Number(numstatMatch[1])
            const removed = numstatMatch[2] === '-' ? 0 : Number(numstatMatch[2])
            files.push({
                path: numstatMatch[3].trim(),
                status: added > 0 && removed === 0 ? 'added' : removed > 0 && added === 0 ? 'deleted' : 'modified',
                added,
                removed
            })
            continue
        }

        const statMatch = line.match(/^(.+?)\s+\|\s+(\d+)\s+([+\-]+)$/)
        if (!statMatch) continue

        const graph = statMatch[3]
        const added = (graph.match(/\+/g) ?? []).length
        const removed = (graph.match(/-/g) ?? []).length
        files.push({
            path: statMatch[1].trim(),
            status: added > 0 && removed === 0 ? 'added' : removed > 0 && added === 0 ? 'deleted' : 'modified',
            added,
            removed
        })
    }

    if (files.length === 0) return null

    return {
        kind: 'diff',
        files,
        added: summaryTotals?.added ?? files.reduce((sum, file) => sum + file.added, 0),
        removed: summaryTotals?.removed ?? files.reduce((sum, file) => sum + file.removed, 0)
    }
}

function shouldAttemptGitParse(language?: string): boolean {
    if (!language || language === 'unknown') return true
    return ['text', 'txt', 'git', 'diff', 'patch', 'bash', 'sh', 'shell', 'shellscript', 'zsh'].includes(language.toLowerCase())
}

export function parseGitCodeBlock(code: string, language?: string): GitCodeBlockSummary | null {
    if (!shouldAttemptGitParse(language)) return null
    return parseGitDiffBlock(code) ?? parseGitDiffStatBlock(code) ?? parseGitStatusBlock(code)
}

function statusTone(status: GitCodeBlockStatus): string {
    switch (status) {
        case 'untracked':
            return 'bg-[#EAF2FF] text-[#2563EB]'
        case 'modified':
        case 'renamed':
        case 'conflicted':
            return 'bg-[#FFF2E5] text-[#F97316]'
        case 'added':
            return 'bg-[#EAFBF0] text-[#16A34A]'
        case 'deleted':
            return 'bg-[#FEECEC] text-[#EF4444]'
    }
}

function fileName(path: string): string {
    const parts = path.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? path
}

function parentPath(path: string): string {
    const parts = path.split('/').filter(Boolean)
    if (parts.length <= 1) return ''
    if (parts.length <= 3) return `${parts.slice(0, -1).join('/')}/`
    return `${parts[0]}/.../${parts[parts.length - 2]}/`
}

export function GitCodeBlockCard(props: {
    summary: GitCodeBlockSummary
    code: string
}) {
    const { t } = useTranslation()
    const visibleFiles = useMemo(() => props.summary.files.slice(0, VISIBLE_ROW_LIMIT), [props.summary.files])
    const hiddenCount = props.summary.files.length - visibleFiles.length
    const hasLineCounts = props.summary.added > 0 || props.summary.removed > 0

    return (
        <div className="aui-md-gitblock min-w-0 w-full max-w-full overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_8px_22px_rgba(15,23,42,0.06)]">
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                        <FileDiffIcon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                        <div className="truncate text-[1rem] font-bold leading-5 text-[var(--app-fg)]">
                            {t('gitCodeBlock.changedFiles', { count: props.summary.files.length })}
                        </div>
                        {hasLineCounts ? (
                            <div className="mt-1 flex items-center gap-2 font-mono text-[0.92rem] font-semibold leading-5">
                                <span className="text-[var(--app-git-staged-color)]">+{props.summary.added}</span>
                                <span className="text-[var(--app-git-deleted-color)]">-{props.summary.removed}</span>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>

            <div className="border-t border-[var(--app-border)] py-1">
                {visibleFiles.map((file, index) => (
                    <div
                        key={`${file.status}:${file.path}:${index}`}
                        className="grid min-w-0 grid-cols-[4.35rem_minmax(0,1fr)_auto] items-center gap-2 px-4 py-1.5 text-[0.92rem] leading-5"
                    >
                        <span className={cn('inline-flex h-6 items-center justify-center rounded-md px-2 text-xs font-semibold', statusTone(file.status))}>
                            {t(`gitCodeBlock.status.${file.status}`)}
                        </span>
                        <span className="min-w-0 truncate font-mono text-[var(--app-fg)]">
                            <span className="text-[var(--app-hint)]">{parentPath(file.path)}</span>
                            {fileName(file.path)}
                        </span>
                        {file.added > 0 || file.removed > 0 ? (
                            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[0.88rem] font-semibold">
                                <span className="text-[var(--app-git-staged-color)]">+{file.added}</span>
                                <span className="text-[var(--app-git-deleted-color)]">-{file.removed}</span>
                            </span>
                        ) : null}
                    </div>
                ))}
                {hiddenCount > 0 ? (
                    <div className="px-4 py-2 text-[0.82rem] text-[var(--app-hint)]">
                        {t('gitDiff.summary.moreFiles', { count: hiddenCount })}
                    </div>
                ) : null}
            </div>
        </div>
    )
}
