import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { formatCodexPatchHunk, getCodexPatchChanges, type CodexPatchChange } from '@/components/ToolCard/codexPatch'
import { basename, resolveDisplayPath } from '@/utils/path'
import { cn } from '@/lib/utils'

function PatchStats(props: { change: CodexPatchChange }) {
    if (props.change.additions === 0 && props.change.deletions === 0) return null

    return (
        <span className="ml-auto inline-flex shrink-0 items-center gap-2 font-mono text-xs">
            {props.change.additions > 0 ? <span className="text-emerald-600">+{props.change.additions}</span> : null}
            {props.change.deletions > 0 ? <span className="text-red-600">−{props.change.deletions}</span> : null}
        </span>
    )
}

function PatchHunkRanges(props: { change: CodexPatchChange }) {
    if (props.change.hunks.length === 0) return null

    const visible = props.change.hunks.slice(0, 2)
    const hiddenCount = props.change.hunks.length - visible.length
    return (
        <div className="font-mono text-[11px] text-[var(--app-hint)]">
            {visible.map(formatCodexPatchHunk).join(' · ')}
            {hiddenCount > 0 ? ` · ${hiddenCount} more ranges` : ''}
        </div>
    )
}

function PatchContent(props: { diff: string }) {
    const lines = props.diff.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()

    return (
        <div className="overflow-hidden rounded-xl bg-[var(--app-code-bg)]">
            <div className="max-h-[min(62vh,560px)] overflow-auto">
                <div className="w-max min-w-full font-mono text-[13px] leading-6">
                    {lines.map((line, index) => {
                        const isAdded = line.startsWith('+') && !line.startsWith('+++')
                        const isDeleted = line.startsWith('-') && !line.startsWith('---')
                        const isRange = line.startsWith('@@')
                        return (
                            <div
                                key={index}
                                className={cn(
                                    'min-w-full whitespace-pre px-3',
                                    isAdded && 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]',
                                    isDeleted && 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]',
                                    isRange && 'border-y border-[var(--app-border)] text-[11px] text-[var(--app-hint)]'
                                )}
                            >
                                {line}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

export function CodexPatchView(props: ToolViewProps) {
    const changes = getCodexPatchChanges(props.block.tool.input)
    if (changes.length === 0) return null

    const isDialog = props.surface === 'dialog'
    const visible = isDialog ? changes : changes.slice(0, 3)
    const hiddenCount = changes.length - visible.length

    if (isDialog) {
        return (
            <div className="flex flex-col gap-4" data-file-mutation-content>
                {visible.map((change) => {
                    const display = resolveDisplayPath(change.path, props.metadata)
                    return (
                        <section key={change.path} className="min-w-0">
                            {visible.length > 1 ? (
                                <div className="mb-2 flex min-w-0 items-center gap-3 px-1">
                                    <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-[var(--app-fg)]" title={display}>
                                        {basename(display)}
                                    </span>
                                    <PatchStats change={change} />
                                </div>
                            ) : null}
                            {change.diff ? <PatchContent diff={change.diff} /> : null}
                        </section>
                    )
                })}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            {visible.map((change) => {
                const display = resolveDisplayPath(change.path, props.metadata)
                return (
                    <div key={change.path} className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--app-fg)]" title={display}>
                                {basename(display)}
                            </span>
                            <PatchStats change={change} />
                        </div>
                        <PatchHunkRanges change={change} />
                    </div>
                )
            })}
            {hiddenCount > 0 ? (
                <div className="px-1 text-xs text-[var(--app-hint)]">{hiddenCount} more files</div>
            ) : null}
        </div>
    )
}
