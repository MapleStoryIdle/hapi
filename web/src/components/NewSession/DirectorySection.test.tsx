import { createRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@/components/ChatInput/Autocomplete', () => ({
    Autocomplete: () => null
}))

vi.mock('@/components/ChatInput/FloatingOverlay', () => ({
    FloatingOverlay: (props: { children: ReactNode }) => <>{props.children}</>
}))

import { DirectorySection } from './DirectorySection'

afterEach(() => {
    cleanup()
})

function renderDirectory(props: Partial<Parameters<typeof DirectorySection>[0]> = {}) {
    return render(
        <DirectorySection
            directory=""
            suggestions={[]}
            selectedIndex={-1}
            isDisabled={false}
            recentPaths={['/Users/alice/Projects/shapi']}
            sessionType="simple"
            worktreeName=""
            worktreeInputRef={createRef<HTMLInputElement>()}
            onDirectoryChange={vi.fn()}
            onDirectoryFocus={vi.fn()}
            onDirectoryBlur={vi.fn()}
            onDirectoryKeyDown={vi.fn()}
            onSuggestionSelect={vi.fn()}
            onPathClick={vi.fn()}
            onSessionTypeChange={vi.fn()}
            onWorktreeNameChange={vi.fn()}
            {...props}
        />
    )
}

describe('DirectorySection', () => {
    it('keeps recent projects before selection and reveals session type after a project is chosen', () => {
        const { rerender } = renderDirectory()

        expect(screen.getByText('newSession.recent:')).toBeTruthy()
        expect(screen.queryByRole('radiogroup', { name: 'newSession.type' })).toBeNull()

        rerender(
            <DirectorySection
                directory="/Users/alice/Projects/shapi"
                suggestions={[]}
                selectedIndex={-1}
                isDisabled={false}
                recentPaths={['/Users/alice/Projects/shapi']}
                sessionType="simple"
                worktreeName=""
                worktreeInputRef={createRef<HTMLInputElement>()}
                onDirectoryChange={vi.fn()}
                onDirectoryFocus={vi.fn()}
                onDirectoryBlur={vi.fn()}
                onDirectoryKeyDown={vi.fn()}
                onSuggestionSelect={vi.fn()}
                onPathClick={vi.fn()}
                onSessionTypeChange={vi.fn()}
                onWorktreeNameChange={vi.fn()}
            />
        )

        expect(screen.queryByText('newSession.recent:')).toBeNull()
        expect(screen.getByRole('radiogroup', { name: 'newSession.type' })).toBeTruthy()
    })

    it('only reveals the worktree name after a project path exists', () => {
        const { rerender } = renderDirectory({ sessionType: 'worktree' })

        expect(screen.queryByPlaceholderText('newSession.type.worktree.placeholder')).toBeNull()

        rerender(
            <DirectorySection
                directory="/Users/alice/Projects/shapi"
                suggestions={[]}
                selectedIndex={-1}
                isDisabled={false}
                recentPaths={[]}
                sessionType="worktree"
                worktreeName=""
                worktreeInputRef={createRef<HTMLInputElement>()}
                onDirectoryChange={vi.fn()}
                onDirectoryFocus={vi.fn()}
                onDirectoryBlur={vi.fn()}
                onDirectoryKeyDown={vi.fn()}
                onSuggestionSelect={vi.fn()}
                onPathClick={vi.fn()}
                onSessionTypeChange={vi.fn()}
                onWorktreeNameChange={vi.fn()}
            />
        )

        expect(screen.getByPlaceholderText('newSession.type.worktree.placeholder')).toBeTruthy()
    })
})
