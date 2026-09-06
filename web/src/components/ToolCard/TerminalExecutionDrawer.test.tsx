import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { TerminalExecutionDrawer } from '@/components/ToolCard/TerminalExecutionDrawer'
import { I18nProvider } from '@/lib/i18n-context'

function makeBlock(id = 'terminal-drawer'): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 100,
        children: [],
        tool: {
            id,
            name: 'CodexBash',
            state: 'completed',
            input: {
                command: '/bin/zsh -lc "bun run test:web"',
                cwd: '/workspace/hapi',
            },
            result: {
                stdout: '1418 tests passed',
                stderr: 'one warning emitted',
                exit_code: 0,
                environment: 'SECRET_TOKEN=must-not-render',
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

function ResetDrawerHarness() {
    const [open, setOpen] = useState(true)

    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>Reopen drawer</button>
            <TerminalExecutionDrawer block={makeBlock()} open={open} onOpenChange={setOpen} />
        </>
    )
}

describe('TerminalExecutionDrawer', () => {
    afterEach(() => {
        cleanup()
    })

    it('uses a safe-area-aware mobile bottom drawer and a centered desktop modal', () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        const drawer = screen.getByTestId('terminal-execution-drawer')
        expect(drawer).toHaveClass('question-drawer', 'inset-x-0', 'w-full', 'rounded-t-[28px]', 'overflow-hidden')
        expect(drawer).toHaveAttribute('data-chat-detail-drawer', 'true')
        expect(drawer).not.toHaveClass('pt-[var(--app-safe-area-top)]')
        expect(drawer.className).not.toContain('backdrop-blur')
        expect(drawer).toHaveTextContent('bun run test:web')
        expect(drawer).toHaveTextContent('Completed')
        expect(drawer).toHaveTextContent('2.3s')
        expect(drawer).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(drawer).toHaveTextContent('1418 tests passed')
        expect(drawer).toHaveTextContent('one warning emitted')
        expect(drawer.querySelector('[data-terminal-execution-overview]')).not.toBeInTheDocument()
        expect(drawer.querySelector('[data-question-drawer-handle]')).toHaveClass('touch-none')
        expect(drawer.querySelector('[data-chat-drawer-body]')).toHaveClass('overflow-y-auto')
        const outputPanel = drawer.querySelector<HTMLElement>('[data-terminal-execution-panel="transcript"]')
        if (!outputPanel) throw new Error('expected output panel')

        expect(outputPanel).toHaveClass('relative', 'isolate')
        expect(outputPanel).not.toHaveAttribute('hidden')
        expect(outputPanel.className).not.toContain('--app-safe-area-bottom')
        expect(drawer.querySelector('[data-chat-drawer-body]')).toHaveClass('overflow-y-auto', 'overscroll-contain')
        expect(drawer.querySelectorAll('[role="tabpanel"]')).toHaveLength(2)
        expect(drawer.querySelector('[data-terminal-execution-panel="details"]')).toHaveAttribute('hidden')
        expect(drawer.querySelector('[data-terminal-execution-input]')).toBeInTheDocument()
        expect(drawer.querySelector('[data-terminal-execution-output]')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-execution-close')).toHaveClass('h-11', 'w-11')
        expect(screen.getByTestId('terminal-execution-close')).toHaveAccessibleName('Close')
    })

    it('shows command and output together, with accessible click and keyboard tabs', () => {
        render(<I18nProvider><DrawerHarness /></I18nProvider>)
        const transcript = screen.getByRole('tab', { name: 'Command & output' })
        const details = screen.getByRole('tab', { name: 'Details' })
        expect(screen.getAllByRole('tab')).toHaveLength(2)
        expect(transcript).toHaveAttribute('aria-selected', 'true')
        expect(transcript).toHaveClass('chat-segment')
        const panel = screen.getByRole('tabpanel')
        expect(panel).toHaveAttribute('id', transcript.getAttribute('aria-controls'))
        expect(panel).toHaveAttribute('aria-labelledby', transcript.id)
        expect(panel).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(panel).toHaveTextContent('1418 tests passed')
        expect(panel).toHaveTextContent('one warning emitted')
        expect(panel).toHaveTextContent('stdout')
        expect(panel).toHaveTextContent('stderr')
        expect(screen.getByText('Completed')).toBeInTheDocument() // stderr alone is not a failure.
        expect(document.querySelector('[data-terminal-execution-command-strip]')).toBeNull()
        fireEvent.click(details)
        const info = screen.getByRole('tabpanel')
        expect(info).toHaveAttribute('id', details.getAttribute('aria-controls'))
        expect(info).toHaveAttribute('aria-labelledby', details.id)
        expect(info).toHaveTextContent('/workspace/hapi')
        expect(info).toHaveTextContent('exit 0')
        expect(info).not.toHaveTextContent('Duration')
        expect(info).not.toHaveTextContent('Status')
        expect(info).not.toHaveTextContent('SECRET_TOKEN=must-not-render')
        expect(info).not.toHaveTextContent('1418 tests passed')
        expect(panel).toHaveAttribute('hidden')
        fireEvent.keyDown(details, { key: 'ArrowRight' })
        expect(transcript).toHaveFocus()
        expect(transcript).toHaveAttribute('aria-selected', 'true')
        fireEvent.keyDown(transcript, { key: 'End' })
        expect(details).toHaveFocus()
        fireEvent.keyDown(details, { key: 'Home' })
        expect(transcript).toHaveFocus()
        fireEvent.keyDown(transcript, { key: 'ArrowLeft' })
        expect(details).toHaveFocus()
    })

    it('uses the remote action and host instead of the generic execution title', () => {
        const block = makeBlock('remote-terminal')
        block.tool.input = {
            command: 'ssh deploy@192.0.2.18 systemctl status hapi-hub.service'
        }

        render(
            <I18nProvider>
                <TerminalExecutionDrawer block={block} open onOpenChange={() => undefined} />
            </I18nProvider>
        )

        expect(screen.getByText('ssh · 192.0.2.18')).toBeInTheDocument()
        expect(screen.queryByText('Terminal execution')).not.toBeInTheDocument()
        expect(screen.queryByText('Run remotely')).not.toBeInTheDocument()
    })

    it('resets to command and output after closing and reopening', async () => {
        render(
            <I18nProvider>
                <ResetDrawerHarness />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
        expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })

        fireEvent.click(screen.getByRole('button', { name: 'Reopen drawer' }))
        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Command & output' })).toHaveAttribute('aria-selected', 'true')
        })
    })

    it('resets to command and output when the tool block changes', async () => {
        const view = render(
            <I18nProvider>
                <TerminalExecutionDrawer block={makeBlock()} open onOpenChange={() => undefined} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
        expect(screen.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')

        view.rerender(
            <I18nProvider>
                <TerminalExecutionDrawer block={makeBlock('terminal-drawer-next')} open onOpenChange={() => undefined} />
            </I18nProvider>
        )

        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Command & output' })).toHaveAttribute('aria-selected', 'true')
        })
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

        // Radix attaches its outside-pointer listener after mount.
        await new Promise((resolve) => setTimeout(resolve, 0))
        const overlay = screen.getByTestId('terminal-execution-overlay')
        fireEvent.pointerDown(overlay, { button: 0, pointerType: 'mouse' })
        fireEvent.click(overlay)

        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })
    })
})
