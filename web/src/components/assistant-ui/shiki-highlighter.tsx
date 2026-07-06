import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import type { CSSProperties } from 'react'
import { useShikiHighlighter } from '@/lib/shiki'
import { GitCodeBlockCard, parseGitCodeBlock } from '@/components/assistant-ui/git-codeblock'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

const PLAIN_TEXT_LANGUAGES = new Set(['', 'unknown', 'text', 'txt', 'plain', 'plaintext'])
const CODE_BLOCK_SURFACE_CLASS = 'min-w-0 w-full max-w-full border border-[var(--app-border)] bg-[var(--app-code-bg)]'
const CODE_BLOCK_MONO_CLASS = 'font-mono text-[0.93rem] leading-6'
const CODE_BLOCK_COPY_BUTTON_CLASS = 'rounded-md p-0.5 text-[var(--app-hint)] opacity-70 transition-colors hover:bg-[var(--app-code-copy-hover-bg)] hover:text-[var(--app-fg)] hover:opacity-100'

export function isPlainTextCodeLanguage(language?: string): boolean {
    const normalized = language?.trim().toLowerCase() ?? ''
    return PLAIN_TEXT_LANGUAGES.has(normalized)
}

function countCodeLines(code: string): number {
    if (code.length === 0) return 1
    const lines = code.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    return Math.max(lines.length, 1)
}

function HighlightedCodeBlock(props: SyntaxHighlighterProps) {
    const highlighted = useShikiHighlighter(props.code, props.language)
    const lineCount = countCodeLines(props.code)
    const lineNumberWidth = Math.max(String(lineCount).length, 3)
    const lineNumbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n')
    const codeGridStyle = {
        gridTemplateColumns: `${lineNumberWidth}ch max-content`
    } satisfies CSSProperties

    return (
        <div className={`aui-md-codeblock ${CODE_BLOCK_SURFACE_CLASS} overflow-x-auto overflow-y-hidden rounded-b-[18px] border-t-0`}>
            <div className={`grid w-max min-w-full ${CODE_BLOCK_MONO_CLASS}`} style={codeGridStyle}>
                <pre
                    aria-hidden="true"
                    className="m-0 select-none py-3 pl-4 pr-3 text-left text-[var(--app-hint)]/65"
                >
                    {lineNumbers}
                </pre>
                <pre className="shiki m-0 py-3 pl-1 pr-4">
                    <code className="block">{highlighted ?? props.code}</code>
                </pre>
            </div>
        </div>
    )
}

function PlainTextCodeBlock(props: SyntaxHighlighterProps) {
    const { copied, copy } = useCopyToClipboard()

    return (
        <div className={`aui-md-plaintext-block group/code relative ${CODE_BLOCK_SURFACE_CLASS} overflow-hidden rounded-[18px]`}>
            <button
                type="button"
                onClick={() => copy(props.code)}
                className={`absolute right-3 top-3 ${CODE_BLOCK_COPY_BUTTON_CLASS}`}
                title="Copy"
            >
                {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
            </button>
            <div className="mr-12 min-w-0 overflow-x-auto">
                <pre className={`m-0 w-max min-w-full whitespace-pre py-3 pl-4 pr-0 ${CODE_BLOCK_MONO_CLASS} text-[var(--app-fg)]`}>
                    <code>{props.code}</code>
                </pre>
            </div>
        </div>
    )
}

export function SyntaxHighlighter(props: SyntaxHighlighterProps) {
    const gitSummary = parseGitCodeBlock(props.code, props.language)
    if (gitSummary) {
        return <GitCodeBlockCard summary={gitSummary} code={props.code} />
    }

    if (isPlainTextCodeLanguage(props.language)) {
        return <PlainTextCodeBlock {...props} />
    }

    return <HighlightedCodeBlock {...props} />
}
