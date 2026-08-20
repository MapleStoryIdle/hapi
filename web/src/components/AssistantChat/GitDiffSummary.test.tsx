import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GitStatusFiles } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { GitDiffSummary, summarizeGitStatusFiles } from './GitDiffSummary'

function makeGitFile(index: number, overrides: Partial<GitStatusFiles['unstagedFiles'][number]> = {}): GitStatusFiles['unstagedFiles'][number] {
    return {
        fileName: `changed-${index}.ts`,
        filePath: 'web/src',
        fullPath: `web/src/changed-${index}.ts`,
        status: 'modified',
        isStaged: false,
        linesAdded: index,
        linesRemoved: 1,
        ...overrides
    }
}

function renderSummary(status: GitStatusFiles | null, onViewDiff = vi.fn(), onViewFileDiff = vi.fn()) {
    return {
        onViewDiff,
        onViewFileDiff,
        ...render(
            <I18nProvider>
                <GitDiffSummary status={status} onViewDiff={onViewDiff} onViewFileDiff={onViewFileDiff} />
            </I18nProvider>
        )
    }
}

function makeStatus(overrides: Partial<GitStatusFiles> = {}): GitStatusFiles {
    return {
        stagedFiles: [],
        unstagedFiles: [],
        branch: 'main',
        totalStaged: 0,
        totalUnstaged: 0,
        ...overrides
    }
}

afterEach(() => {
    cleanup()
})

beforeEach(() => {
    localStorage.setItem('hapi-lang', 'en')
})

describe('GitDiffSummary', () => {
    it('按唯一文件统计，并把 staged 与 unstaged 行数合并', () => {
        const summary = summarizeGitStatusFiles(makeStatus({
            stagedFiles: [{
                fileName: 'router.tsx',
                filePath: 'web/src',
                fullPath: 'web/src/router.tsx',
                status: 'modified',
                isStaged: true,
                linesAdded: 10,
                linesRemoved: 2
            }],
            unstagedFiles: [{
                fileName: 'router.tsx',
                filePath: 'web/src',
                fullPath: 'web/src/router.tsx',
                status: 'modified',
                isStaged: false,
                linesAdded: 3,
                linesRemoved: 4
            }]
        }))

        expect(summary?.fileCount).toBe(1)
        expect(summary?.added).toBe(13)
        expect(summary?.removed).toBe(6)
        expect(summary?.rows[0]).toMatchObject({ staged: true, unstaged: true })
    })

    it('没有 git 状态或没有变更时隐藏', () => {
        const { container, rerender } = render(
            <I18nProvider>
                <GitDiffSummary status={null} onViewDiff={() => {}} />
            </I18nProvider>
        )
        expect(container.textContent).toBe('')

        rerender(
            <I18nProvider>
                <GitDiffSummary status={makeStatus()} onViewDiff={() => {}} />
            </I18nProvider>
        )
        expect(container.textContent).toBe('')
    })

    it('点击胶囊展开文件列表，少量文件不展示底部按钮行', () => {
        const { onViewFileDiff } = renderSummary(makeStatus({
            unstagedFiles: [{
                fileName: 'GitDiffSummary.tsx',
                filePath: 'web/src/components/AssistantChat',
                fullPath: 'web/src/components/AssistantChat/GitDiffSummary.tsx',
                status: 'added',
                isStaged: false,
                linesAdded: 42,
                linesRemoved: 0
            }]
        }))

        fireEvent.click(screen.getByRole('button', { name: /1 file/i }))
        expect(screen.getByRole('dialog', { name: 'Git changes' })).toBeTruthy()
        expect(screen.getByText('Branch')).toBeInTheDocument()
        expect(screen.getByText('main')).toBeInTheDocument()
        const row = screen.getByRole('button', { name: /AssistantChat\/GitDiffSummary\.tsx/i })
        expect(row).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Copy summary' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'View all' })).toBeNull()

        fireEvent.click(row)
        expect(onViewFileDiff).toHaveBeenCalledWith(expect.objectContaining({
            path: 'web/src/components/AssistantChat/GitDiffSummary.tsx'
        }))
    })

    it('文件列表被截断时才展示查看全部，并调用跳转回调', () => {
        const { onViewDiff } = renderSummary(makeStatus({
            unstagedFiles: Array.from({ length: 7 }, (_, index) => makeGitFile(index + 1))
        }))

        fireEvent.click(screen.getByRole('button', { name: /7 file\(s\)/i }))
        expect(screen.getByText('+1 more file(s)')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Copy summary' })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'View all' }))
        expect(onViewDiff).toHaveBeenCalledOnce()
    })

    it('统计数字使用 Git 语义色，而不是 diff 行文本色', () => {
        const { container } = renderSummary(makeStatus({
            unstagedFiles: [{
                fileName: 'changed.ts',
                filePath: 'src',
                fullPath: 'src/changed.ts',
                status: 'modified',
                isStaged: false,
                linesAdded: 12,
                linesRemoved: 5
            }]
        }))

        expect(container.querySelector('.text-\\[var\\(--app-git-staged-color\\)\\]')?.textContent).toBe('+12')
        expect(container.querySelector('.text-\\[var\\(--app-git-deleted-color\\)\\]')?.textContent).toBe('-5')
        expect(container.querySelector('.text-\\[var\\(--app-diff-added-text\\)\\]')).toBeNull()
        expect(container.querySelector('.text-\\[var\\(--app-diff-removed-text\\)\\]')).toBeNull()
    })

    it('uses the same font family as chat messages', () => {
        const { container } = renderSummary(makeStatus({
            unstagedFiles: [makeGitFile(1)]
        }))

        expect(container.firstElementChild?.className).toContain('[font-family:var(--app-chat-font-family)]')
    })
})
