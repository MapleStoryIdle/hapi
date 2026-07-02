import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import type { CSSProperties } from 'react'
import { useShikiHighlighter } from '@/lib/shiki'

function countCodeLines(code: string): number {
    if (code.length === 0) return 1
    const lines = code.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    return Math.max(lines.length, 1)
}

export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    const highlighted = useShikiHighlighter(props.code, props.language)
    const lineCount = countCodeLines(props.code)
    const lineNumberWidth = Math.max(String(lineCount).length, 3)
    const lineNumbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')
    const codeGridStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch max-content`
    } satisfies CSSProperties

    return (
        <div className="aui-md-codeblock min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-b-[22px] border border-t-0 border-[var(--app-border)] bg-[var(--app-code-bg)]">
            <div className="grid w-max min-w-full font-mono text-[0.95rem] leading-7" style={codeGridStyle}>
                <pre
                    aria-hidden="true"
                    className="m-0 select-none px-5 pb-5 pt-0 text-left text-[var(--app-hint)]/65"
                >
                    {lineNumbers}
                </pre>
                <pre className="shiki m-0 px-6 pb-5 pt-0">
                    <code className="block">{highlighted ?? props.code}</code>
                </pre>
            </div>
        </div>
    )
}
