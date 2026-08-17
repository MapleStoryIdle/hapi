import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'
import { formatCodexPatchHunk, getCodexPatchChanges, type CodexPatchChange } from '@/components/ToolCard/codexPatch'
import { basename, resolveDisplayPath } from '@/utils/path'

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

export function CodexPatchView(props: ToolViewProps) {
    const changes = getCodexPatchChanges(props.block.tool.input)
    if (changes.length === 0) return null

    const isDialog = props.surface === 'dialog'
    const visible = isDialog ? changes : changes.slice(0, 3)
    const hiddenCount = changes.length - visible.length

    return (
        <div className="flex flex-col gap-2">
            {visible.map((change) => {
                const display = resolveDisplayPath(change.path, props.metadata)
                return (
                    <div key={change.path} className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--app-fg)]" title={display}>
                                {isDialog ? display : basename(display)}
                            </span>
                            <PatchStats change={change} />
                        </div>
                        <PatchHunkRanges change={change} />
                        {isDialog && change.diff ? (
                            <div className="mt-2">
                                <CodeBlock code={change.diff} language="diff" title="Patch" size="comfortable" scrollY />
                            </div>
                        ) : null}
                    </div>
                )
            })}
            {hiddenCount > 0 ? (
                <div className="px-1 text-xs text-[var(--app-hint)]">{hiddenCount} more files</div>
            ) : null}
        </div>
    )
}
