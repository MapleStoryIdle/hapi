import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitFileStatus, GitStatusFiles } from '@/types/api'
import { getDetachedBranchLabel } from '@/lib/files-i18n'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const VISIBLE_DIFF_ROW_LIMIT = 6

type DiffFileRow = {
    path: string
    fileName: string
    status: GitFileStatus['status']
    added: number
    removed: number
    staged: boolean
    unstaged: boolean
}

type DiffSummary = {
    rows: DiffFileRow[]
    fileCount: number
    added: number
    removed: number
}

const STATUS_LABELS: Record<GitFileStatus['status'], string> = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    untracked: '?',
    conflicted: 'U'
}

function mergeFile(rows: Map<string, DiffFileRow>, file: GitFileStatus): void {
    const existing = rows.get(file.fullPath)
    if (!existing) {
        rows.set(file.fullPath, {
            path: file.fullPath,
            fileName: file.fileName || file.fullPath,
            status: file.status,
            added: file.linesAdded,
            removed: file.linesRemoved,
            staged: file.isStaged,
            unstaged: !file.isStaged
        })
        return
    }

    existing.added += file.linesAdded
    existing.removed += file.linesRemoved
    existing.staged = existing.staged || file.isStaged
    existing.unstaged = existing.unstaged || !file.isStaged
    if (existing.status === 'modified' && file.status !== 'modified') {
        existing.status = file.status
    }
}

export function summarizeGitStatusFiles(status: GitStatusFiles | null): DiffSummary | null {
    if (!status) return null

    const byPath = new Map<string, DiffFileRow>()
    for (const file of status.stagedFiles) {
        mergeFile(byPath, file)
    }
    for (const file of status.unstagedFiles) {
        mergeFile(byPath, file)
    }

    const rows = [...byPath.values()].sort((a, b) => {
        const changed = (b.added + b.removed) - (a.added + a.removed)
        if (changed !== 0) return changed
        return a.path.localeCompare(b.path)
    })

    if (rows.length === 0) return null

    return {
        rows,
        fileCount: rows.length,
        added: rows.reduce((sum, file) => sum + file.added, 0),
        removed: rows.reduce((sum, file) => sum + file.removed, 0)
    }
}

function formatPath(path: string, fileName: string): string {
    const parts = path.split('/').filter(Boolean)
    if (parts.length <= 2) return path
    return `${parts[parts.length - 2]}/${fileName}`
}

export function GitDiffSummary(props: {
    status: GitStatusFiles | null
    onViewDiff: () => void
    onViewFileDiff?: (file: DiffFileRow) => void
    onExpandedChange?: (expanded: boolean) => void
}) {
    const { t } = useTranslation()
    const [expanded, setExpanded] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const summary = useMemo(() => summarizeGitStatusFiles(props.status), [props.status])

    useEffect(() => {
        props.onExpandedChange?.(expanded)
    }, [expanded, props.onExpandedChange])

    useEffect(() => {
        if (!expanded) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Node && rootRef.current?.contains(target)) {
                return
            }
            setExpanded(false)
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setExpanded(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [expanded])

    if (!summary) return null

    const visibleRows = summary.rows.slice(0, VISIBLE_DIFF_ROW_LIMIT)
    const hiddenCount = Math.max(0, summary.rows.length - visibleRows.length)
    const showViewAll = hiddenCount > 0
    const branchLabel = getDetachedBranchLabel(props.status?.branch, t)

    return (
        <div ref={rootRef} className="pointer-events-none relative mx-auto flex w-full max-w-content justify-center px-3 [font-family:var(--app-chat-font-family)]">
            {expanded ? (
                <div
                    className="pointer-events-auto absolute bottom-14 left-6 right-6 z-20 max-h-64 origin-bottom overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-[var(--app-code-bg)] shadow-[0_18px_45px_rgba(15,23,42,0.16)] animate-diff-pop"
                    role="dialog"
                    aria-label={t('gitDiff.summary.title')}
                >
                    <div className="flex items-start justify-between gap-3 px-6 pb-3 pt-5">
                        <div className="min-w-0">
                            <button
                                type="button"
                                className="block min-w-0 text-left text-[0.95rem] font-semibold text-[var(--app-fg)]"
                                onClick={() => setExpanded(false)}
                            >
                                {t('gitDiff.summary.changedFiles', { count: summary.fileCount })}
                            </button>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs leading-4 text-[var(--app-hint)]">
                                <span className="shrink-0">{t('gitDiff.summary.branch')}</span>
                                <span className="min-w-0 truncate font-semibold text-[var(--app-fg)]">{branchLabel}</span>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-3 text-[0.95rem] font-semibold">
                            <span className="text-[var(--app-git-staged-color)]">+{summary.added}</span>
                            <span className="text-[var(--app-git-deleted-color)]">-{summary.removed}</span>
                        </div>
                    </div>
                    <div className="max-h-36 overflow-y-auto pb-4">
                        {visibleRows.map((file) => (
                            <button
                                key={file.path}
                                type="button"
                                className="flex w-full items-center gap-2 px-6 py-1.5 text-left text-[0.82rem] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)]"
                                onClick={() => {
                                    setExpanded(false)
                                    props.onViewFileDiff?.(file)
                                }}
                            >
                                <span className={cn(
                                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-semibold',
                                    file.status === 'added' || file.status === 'untracked'
                                        ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-git-staged-color)]'
                                        : file.status === 'deleted'
                                            ? 'bg-[var(--app-diff-removed-bg)] text-[var(--app-git-deleted-color)]'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
                                )}>
                                    {STATUS_LABELS[file.status]}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-[var(--app-fg)]">
                                    {formatPath(file.path, file.fileName)}
                                </span>
                                <span className="shrink-0 text-[var(--app-git-staged-color)]">+{file.added}</span>
                                <span className="shrink-0 text-[var(--app-git-deleted-color)]">-{file.removed}</span>
                            </button>
                        ))}
                        {hiddenCount > 0 ? (
                            <div className="px-6 py-1.5 text-[0.82rem] text-[var(--app-hint)]">
                                {t('gitDiff.summary.moreFiles', { count: hiddenCount })}
                            </div>
                        ) : null}
                    </div>
                    {showViewAll ? (
                        <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-5 py-3">
                            <button
                                type="button"
                                className="rounded-full bg-[var(--app-button)] px-3 py-1.5 text-xs font-medium text-[var(--app-button-text)]"
                                onClick={() => {
                                    setExpanded(false)
                                    props.onViewDiff()
                                }}
                            >
                                {t('gitDiff.summary.viewAll')}
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <button
                type="button"
                className="pointer-events-auto inline-flex h-[34px] items-center gap-3 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-4 text-sm font-medium shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-all duration-150 ease-out hover:-translate-y-0.5 hover:shadow-[0_12px_30px_rgba(15,23,42,0.16)] animate-diff-pill"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
            >
                <span className="text-[var(--app-hint)]">
                    {t('gitDiff.summary.files', { count: summary.fileCount })}
                </span>
                <span className="text-[var(--app-git-staged-color)] transition-opacity">+{summary.added}</span>
                <span className="text-[var(--app-git-deleted-color)] transition-opacity">-{summary.removed}</span>
            </button>
        </div>
    )
}
