import { render } from '@testing-library/react'
import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { describe, expect, it } from 'vitest'
import { SyntaxHighlighter, isPlainTextCodeLanguage } from '@/components/assistant-ui/shiki-highlighter'

const markdownComponents: SyntaxHighlighterProps['components'] = {
    Pre: (props) => <pre {...props} />,
    Code: (props) => <code {...props} />,
}

describe('SyntaxHighlighter plaintext rendering', () => {
    it('treats txt/text/plaintext aliases as plain text languages', () => {
        expect(isPlainTextCodeLanguage('txt')).toBe(true)
        expect(isPlainTextCodeLanguage('text')).toBe(true)
        expect(isPlainTextCodeLanguage('plaintext')).toBe(true)
        expect(isPlainTextCodeLanguage('typescript')).toBe(false)
    })

    it('renders txt blocks without the numbered code-block layout', () => {
        const view = render(
            <SyntaxHighlighter
                code="错误 / 权限 > 版本更新 > 当前任务完成"
                language="txt"
                components={markdownComponents}
            />
        )

        // Plain text blocks use the shared code/text surface but skip line numbers.
        expect(view.container.querySelector('.aui-md-plaintext-block')).toHaveClass('overflow-hidden', 'rounded-[18px]')
        expect(view.container.querySelector('.aui-md-plaintext-block > div')).toHaveClass('overflow-x-auto')
        expect(view.container.querySelector('pre')).toHaveClass('whitespace-pre')
        expect(view.container.querySelector('.aui-md-codeblock')).toBeNull()
        expect(view.container.querySelector('button[title="Copy"]')).not.toBeNull()
        expect(view.getByText('错误 / 权限 > 版本更新 > 当前任务完成')).toBeInTheDocument()
    })

    it('renders highlighted blocks with the shared code/text body scale', () => {
        const view = render(
            <SyntaxHighlighter
                code="const value = 1"
                language="typescript"
                components={markdownComponents}
            />
        )

        // Highlighted blocks keep line numbers but share the same radius and text scale.
        expect(view.container.querySelector('.aui-md-codeblock')).toHaveClass('rounded-b-[18px]', 'overflow-x-auto')
        expect(view.container.querySelector('.aui-md-codeblock > div')).toHaveClass('text-[0.93rem]', 'leading-6')
    })
})
