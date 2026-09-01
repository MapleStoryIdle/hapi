import { fireEvent, render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function makePatchBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'patch-1',
        localId: null,
        createdAt: 1_000,
        children: [],
        tool: {
            id: 'patch-1',
            name: 'CodexPatch',
            state: 'completed',
            input: {
                changes: [{
                    path: '/workspace/web/src/App.tsx',
                    kind: { type: 'update', move_path: null },
                    diff: '@@ -32,2 +32,3 @@\n old\n-old value\n+new value\n+another line\n'
                }]
            },
            createdAt: 1_000,
            startedAt: 1_000,
            completedAt: 1_050,
            description: null,
            result: { success: true }
        }
    }
}

describe('Codex patch card', () => {
    it('shows the changed file, line counts, and exact hunk range inline', () => {
        const view = render(
            <I18nProvider>
                <ToolCard
                    api={{} as ApiClient}
                    sessionId="session-1"
                    metadata={null}
                    terminalToolDisplayMode="compact"
                    disabled={false}
                    onDone={vi.fn()}
                    block={makePatchBlock()}
                />
            </I18nProvider>
        )

        expect(view.getByText('Modify file')).toBeInTheDocument()
        expect(view.getByText('App.tsx')).toBeInTheDocument()
        expect(view.getByText('+2')).toBeInTheDocument()
        expect(view.getByText('−1')).toBeInTheDocument()
        expect(view.getByText('L32–33 → L32–34')).toBeInTheDocument()
    })

    it('opens a focused change dialog with the file, stats, and patch content', () => {
        const view = render(
            <I18nProvider>
                <ToolCard
                    api={{} as ApiClient}
                    sessionId="session-1"
                    metadata={null}
                    terminalToolDisplayMode="compact"
                    disabled={false}
                    onDone={vi.fn()}
                    block={makePatchBlock()}
                />
            </I18nProvider>
        )

        fireEvent.click(within(view.container).getByText('Modify file').closest('button')!)

        const dialog = within(view.getByRole('dialog'))
        expect(dialog.getByRole('heading', { name: 'App.tsx' })).toBeInTheDocument()
        expect(dialog.getByText('+2')).toBeInTheDocument()
        expect(dialog.getByText('−1')).toBeInTheDocument()
        expect(dialog.getByText('+new value')).toBeInTheDocument()
        expect(dialog.getByText('-old value')).toBeInTheDocument()
        expect(dialog.queryByText('Input')).not.toBeInTheDocument()
        expect(dialog.queryByText('Result')).not.toBeInTheDocument()
        expect(dialog.queryByText('Patch')).not.toBeInTheDocument()
    })
})
