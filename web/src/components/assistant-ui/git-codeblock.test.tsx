import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { GitCodeBlockCard, parseGitCodeBlock } from '@/components/assistant-ui/git-codeblock'

describe('git-codeblock parser', () => {
    it('parses git status short output into readable file statuses', () => {
        const summary = parseGitCodeBlock('?? design-qa.md\nM web/src/components/SessionChat.tsx\nD deleted.txt', 'text')

        expect(summary?.kind).toBe('status')
        expect(summary?.files).toMatchObject([
            { path: 'design-qa.md', status: 'untracked' },
            { path: 'web/src/components/SessionChat.tsx', status: 'modified' },
            { path: 'deleted.txt', status: 'deleted' }
        ])
    })

    it('parses git status short output with a branch header', () => {
        const summary = parseGitCodeBlock([
            '## dev',
            ' M web/src/components/AssistantChat/ComposerButtons.tsx',
            ' M web/src/components/AssistantChat/HappyComposer.tsx',
            '?? web/src/components/assistant-ui/git-codeblock.tsx'
        ].join('\n'), 'text')

        expect(summary?.kind).toBe('status')
        expect(summary?.files).toMatchObject([
            { path: 'web/src/components/AssistantChat/ComposerButtons.tsx', status: 'modified' },
            { path: 'web/src/components/AssistantChat/HappyComposer.tsx', status: 'modified' },
            { path: 'web/src/components/assistant-ui/git-codeblock.tsx', status: 'untracked' }
        ])
    })

    it('parses git diff output and totals additions and removals', () => {
        const summary = parseGitCodeBlock([
            'diff --git a/foo.ts b/foo.ts',
            'index 111..222 100644',
            '--- a/foo.ts',
            '+++ b/foo.ts',
            '@@ -1,2 +1,3 @@',
            '-old',
            '+new',
            '+extra'
        ].join('\n'), 'diff')

        expect(summary?.kind).toBe('diff')
        expect(summary?.files[0]).toMatchObject({
            path: 'foo.ts',
            status: 'modified',
            added: 2,
            removed: 1
        })
        expect(summary?.added).toBe(2)
        expect(summary?.removed).toBe(1)
    })

    it('parses git diff stat output and displays summary counts', () => {
        const summary = parseGitCodeBlock([
            ' web/src/a.ts | 10 +++++++---',
            ' web/src/b.ts | 25 ++++++++++++++++++-------',
            ' 2 files changed, 25 insertions(+), 10 deletions(-)'
        ].join('\n'), 'text')

        expect(summary?.kind).toBe('diff')
        expect(summary?.files).toHaveLength(2)
        expect(summary?.added).toBe(25)
        expect(summary?.removed).toBe(10)
    })
})

describe('GitCodeBlockCard', () => {
    it('collapses file rows by default and expands on summary click', () => {
        // 验证 git 摘要卡片默认只占一行摘要空间，点击摘要后才展开文件列表。
        const summary = parseGitCodeBlock('?? design-qa.md\nM web/src/components/SessionChat.tsx', 'text')
        expect(summary).not.toBeNull()

        render(
            <I18nProvider>
                <GitCodeBlockCard summary={summary!} code="?? design-qa.md" />
            </I18nProvider>
        )

        const summaryButton = screen.getByText('Modified 2 file(s)').closest('button')
        expect(summaryButton).not.toBeNull()
        expect(screen.queryByText('Untracked')).not.toBeInTheDocument()
        expect(screen.queryByText('Modified')).not.toBeInTheDocument()

        fireEvent.click(summaryButton!)

        expect(screen.getByText('Untracked')).toBeInTheDocument()
        expect(screen.getByText('Modified')).toBeInTheDocument()
        expect(screen.queryByText('??')).not.toBeInTheDocument()
        expect(screen.queryByTitle('Copy')).not.toBeInTheDocument()
    })
})
