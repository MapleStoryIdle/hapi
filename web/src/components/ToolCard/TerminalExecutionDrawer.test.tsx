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
        const outputPanel = drawer.querySelector<HTMLElement>('[data-terminal-execution-panel="output"]')
        if (!outputPanel) throw new Error('expected output panel')

        expect(outputPanel).toHaveClass('relative', 'isolate')
        expect(outputPanel).not.toHaveAttribute('hidden')
        expect(outputPanel.className).not.toContain('--app-safe-area-bottom')
        expect(drawer.querySelector('[data-chat-drawer-body]')).toHaveClass('overflow-y-auto', 'overscroll-contain')
        expect(drawer.querySelectorAll('[role="tabpanel"]')).toHaveLength(3)
        expect(drawer.querySelector('[data-terminal-execution-panel="input"]')).toHaveAttribute('hidden')
        expect(drawer.querySelector('[data-terminal-execution-panel="environment"]')).toHaveAttribute('hidden')
        expect(drawer.querySelector('[data-terminal-execution-input]')).toBeInTheDocument()
        expect(drawer.querySelector('[data-terminal-execution-output]')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-execution-close')).toHaveClass('h-11', 'w-11')
        expect(screen.getByTestId('terminal-execution-close')).toHaveAccessibleName('Close')
    })

    it('defaults to output and switches accessible tab panels by click and keyboard', () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        const outputTab = screen.getByRole('tab', { name: 'Output' })
        const inputTab = screen.getByRole('tab', { name: 'Input' })
        const environmentTab = screen.getByRole('tab', { name: 'Environment' })
        const tabs = [outputTab, inputTab, environmentTab]
        const drawer = screen.getByTestId('terminal-execution-drawer')

        expect(screen.getByRole('tablist', { name: 'bun run test:web' })).toBeInTheDocument()
        expect(outputTab).toHaveAttribute('aria-selected', 'true')
        expect(outputTab).toHaveAttribute('tabindex', '0')
        expect(outputTab).toHaveClass('chat-segment')
        expect(inputTab).toHaveAttribute('aria-selected', 'false')
        expect(inputTab).toHaveAttribute('tabindex', '-1')

        const outputPanel = screen.getByRole('tabpanel')
        expect(outputPanel).toHaveAttribute('id', outputTab.getAttribute('aria-controls'))
        expect(outputPanel).toHaveAttribute('aria-labelledby', outputTab.id)
        expect(outputPanel).toHaveTextContent('1418 tests passed')
        expect(outputPanel).toHaveTextContent('one warning emitted')
        expect(outputPanel).toHaveTextContent('Stdout')
        expect(outputPanel).toHaveTextContent('Stderr')

        for (const tab of tabs) {
            const panelId = tab.getAttribute('aria-controls')
            if (!panelId) throw new Error('expected a tab panel id')

            const panel = document.getElementById(panelId)
            if (!panel) throw new Error('expected tab panel')

            expect(panel).toHaveAttribute('role', 'tabpanel')
            expect(panel).toHaveAttribute('aria-labelledby', tab.id)
        }

        expect(drawer.querySelector('[data-chat-drawer-body]')).toContainElement(outputPanel)

        fireEvent.click(inputTab)

        const inputPanel = screen.getByRole('tabpanel')
        expect(inputTab).toHaveAttribute('aria-selected', 'true')
        expect(inputPanel).toHaveAttribute('id', inputTab.getAttribute('aria-controls'))
        expect(inputPanel).toHaveAttribute('aria-labelledby', inputTab.id)
        expect(inputPanel).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(inputPanel).not.toHaveTextContent('1418 tests passed')
        expect(drawer).toContainElement(outputPanel)
        expect(outputPanel).toHaveAttribute('hidden')
        expect(inputPanel).not.toHaveAttribute('hidden')

        fireEvent.keyDown(inputTab, { key: 'ArrowRight' })

        const environmentPanel = screen.getByRole('tabpanel')
        expect(environmentTab).toHaveFocus()
        expect(environmentTab).toHaveAttribute('aria-selected', 'true')
        expect(environmentPanel).toHaveAttribute('id', environmentTab.getAttribute('aria-controls'))
        expect(environmentPanel).toHaveAttribute('aria-labelledby', environmentTab.id)
        expect(environmentPanel).toHaveTextContent('Status')
        expect(environmentPanel).toHaveTextContent('Working directory')
        expect(environmentPanel).toHaveTextContent('/workspace/hapi')
        expect(environmentPanel).toHaveTextContent('Duration')
        expect(environmentPanel).toHaveTextContent('2.3s')
        expect(environmentPanel).toHaveTextContent('Exit code')
        expect(environmentPanel).toHaveTextContent('exit 0')
        expect(environmentPanel).not.toHaveTextContent('SECRET_TOKEN=must-not-render')
        expect(environmentPanel).not.toHaveTextContent('1418 tests passed')

        fireEvent.keyDown(environmentTab, { key: 'Home' })
        expect(outputTab).toHaveFocus()
        expect(outputTab).toHaveAttribute('aria-selected', 'true')

        fireEvent.keyDown(outputTab, { key: 'End' })
        expect(environmentTab).toHaveFocus()
        expect(environmentTab).toHaveAttribute('aria-selected', 'true')

        fireEvent.keyDown(environmentTab, { key: 'ArrowLeft' })
        expect(inputTab).toHaveFocus()
        expect(inputTab).toHaveAttribute('aria-selected', 'true')
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

    it('resets to output after closing and reopening', async () => {
        render(
            <I18nProvider>
                <ResetDrawerHarness />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('tab', { name: 'Environment' }))
        expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })

        fireEvent.click(screen.getByRole('button', { name: 'Reopen drawer' }))
        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
        })
    })

    it('resets to output when the tool block changes', async () => {
        const view = render(
            <I18nProvider>
                <TerminalExecutionDrawer block={makeBlock()} open onOpenChange={() => undefined} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('tab', { name: 'Environment' }))
        expect(screen.getByRole('tab', { name: 'Environment' })).toHaveAttribute('aria-selected', 'true')

        view.rerender(
            <I18nProvider>
                <TerminalExecutionDrawer block={makeBlock('terminal-drawer-next')} open onOpenChange={() => undefined} />
            </I18nProvider>
        )

        await waitFor(() => {
            expect(screen.getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
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
