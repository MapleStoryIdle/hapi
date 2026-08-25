import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { TerminalExecutionDrawer } from '@/components/ToolCard/TerminalExecutionDrawer'
import { I18nProvider } from '@/lib/i18n-context'

function makeBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'terminal-drawer',
        localId: null,
        createdAt: 100,
        children: [],
        tool: {
            id: 'terminal-drawer',
            name: 'CodexBash',
            state: 'completed',
            input: {
                command: '/bin/zsh -lc "bun run test:web"',
                cwd: '/workspace/hapi',
            },
            result: {
                stdout: '1418 tests passed',
                exit_code: 0,
            },
            createdAt: 100,
            startedAt: 200,
            completedAt: 2_450,
            description: null,
        }
    }
}

function DrawerHarness() {
    const [open, setOpen] = useState(true)
    return <TerminalExecutionDrawer block={makeBlock()} open={open} onOpenChange={setOpen} />
}

describe('TerminalExecutionDrawer', () => {
    afterEach(() => {
        cleanup()
    })

    it('uses a bounded modal on mobile and larger screens', () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        const drawer = screen.getByTestId('terminal-execution-drawer')
        expect(drawer).toHaveClass(
            'left-1/2',
            'top-1/2',
            'h-[min(75dvh,50rem)]',
            'max-h-[calc(100dvh-var(--app-safe-area-top)-var(--app-safe-area-bottom)-2rem)]',
            'w-[min(92vw,60rem)]',
            'sm:w-[min(75vw,60rem)]',
            '-translate-x-1/2',
            '-translate-y-1/2',
            'pt-[var(--app-safe-area-top)]',
            'rounded-2xl',
            'isolate',
            'overflow-hidden'
        )
        expect(drawer).toHaveTextContent('Terminal execution')
        expect(drawer).toHaveTextContent('Completed')
        expect(drawer).toHaveTextContent('2.3s')
        expect(drawer).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(drawer).toHaveTextContent('1418 tests passed')
        expect(drawer.querySelector('[data-terminal-execution-overview]')).not.toBeInTheDocument()
        expect(drawer.querySelector('header')).toHaveClass('relative', 'z-10', 'bg-[var(--app-dialog-bg)]')
        expect(drawer.querySelector('[data-terminal-execution-detail]')).toHaveClass('relative', 'isolate', 'flex-1', 'overscroll-contain')
        expect(drawer.querySelector('[data-terminal-execution-input]')).toHaveClass('shrink-0')
        expect(drawer.querySelector('[data-terminal-execution-output]')).toHaveClass('shrink-0')
        expect(screen.getByTestId('terminal-execution-close')).toHaveTextContent('Close')
    })

    it('closes through the modal close control', async () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))

        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })
    })

    it('closes when the modal overlay is clicked', async () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        fireEvent.click(screen.getByTestId('terminal-execution-overlay'))

        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })
    })
})
