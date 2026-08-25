import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function makeBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'terminal-card',
        localId: null,
        createdAt: 100,
        children: [],
        tool: {
            id: 'terminal-card',
            name: 'Bash',
            state: 'completed',
            input: { command: 'bun run test:web' },
            result: { stdout: 'tests passed', exit_code: 0 },
            createdAt: 100,
            startedAt: 100,
            completedAt: 2_350,
            description: null,
        }
    }
}

describe('ToolCard terminal execution detail', () => {
    afterEach(() => {
        cleanup()
    })

    it('opens command details in the dedicated modal instead of the generic dialog', async () => {
        render(
            <I18nProvider>
                <ToolCard
                    api={{} as ApiClient}
                    sessionId="session-1"
                    metadata={null}
                    terminalToolDisplayMode="detailed"
                    disabled={false}
                    onDone={vi.fn()}
                    block={makeBlock()}
                />
            </I18nProvider>
        )

        const trigger = screen.getByRole('button', { name: /terminal.*bun run test:web/i })
        expect(trigger).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('tests passed')).not.toBeInTheDocument()

        fireEvent.click(trigger)

        await waitFor(() => {
            expect(screen.getByTestId('terminal-execution-drawer')).toBeInTheDocument()
        })
        expect(trigger).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('dialog')).toHaveAttribute('data-testid', 'terminal-execution-drawer')
        expect(screen.getByRole('dialog')).toHaveTextContent('tests passed')
    })
})
