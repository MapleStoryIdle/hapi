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
        expect(drawer).toHaveClass(
            'inset-x-0',
            'bottom-0',
            'h-[60dvh]',
            'w-full',
            'rounded-t-[28px]',
            'sm:left-1/2',
            'sm:top-1/2',
            'sm:bottom-auto',
            'sm:h-[min(75dvh,50rem)]',
            'sm:max-h-[calc(100dvh-2rem)]',
            'sm:w-[min(75vw,60rem)]',
            'sm:-translate-x-1/2',
            'sm:-translate-y-1/2',
            'sm:rounded-2xl',
            'isolate',
            'overflow-hidden'
        )
        expect(drawer).not.toHaveClass('pt-[var(--app-safe-area-top)]')
        expect(drawer.className).not.toContain('backdrop-blur')
        expect(drawer).toHaveTextContent('Terminal execution')
        expect(drawer).toHaveTextContent('Completed')
        expect(drawer).toHaveTextContent('2.3s')
        expect(drawer).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(drawer).toHaveTextContent('1418 tests passed')
        expect(drawer).toHaveTextContent('one warning emitted')
        expect(drawer.querySelector('[data-terminal-execution-overview]')).not.toBeInTheDocument()
        expect(drawer.querySelector('header')).toHaveClass('relative', 'z-10', 'bg-[var(--app-dialog-bg)]')
        expect(drawer.querySelector('[data-terminal-execution-drag-handle]')).toHaveClass('sm:hidden')
        expect(drawer.querySelector('[data-terminal-execution-drag-handle]')).toHaveAttribute('aria-hidden', 'true')
        expect(drawer.querySelector('[data-terminal-execution-command-strip]')).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        const outputPanel = drawer.querySelector<HTMLElement>('[data-terminal-execution-panel="output"]')
        if (!outputPanel) throw new Error('expected output panel')

        expect(outputPanel).toHaveClass(
            'relative',
            'isolate',
            'flex-1',
            'overflow-y-auto',
            'overscroll-contain',
            'pb-[max(var(--app-safe-area-bottom),1.25rem)]'
        )
        expect(outputPanel).not.toHaveAttribute('hidden')
        expect((`${drawer.className} ${outputPanel.className}`).match(/--app-safe-area-bottom/g)).toHaveLength(1)
        expect(drawer.querySelectorAll('[role="tabpanel"]')).toHaveLength(3)
        expect(drawer.querySelector('[data-terminal-execution-panel="input"]')).toHaveAttribute('hidden')
        expect(drawer.querySelector('[data-terminal-execution-panel="environment"]')).toHaveAttribute('hidden')
        expect(drawer.querySelector('[data-terminal-execution-input]')).toBeInTheDocument()
        expect(drawer.querySelector('[data-terminal-execution-output]')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-execution-close')).toHaveClass('h-11', 'w-11')
        expect(screen.getByTestId('terminal-execution-close')).toHaveTextContent('Close')
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

        expect(screen.getByRole('tablist', { name: 'Terminal execution' })).toBeInTheDocument()
        expect(outputTab).toHaveAttribute('aria-selected', 'true')
        expect(outputTab).toHaveAttribute('tabindex', '0')
        expect(outputTab).toHaveClass('min-h-11')
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

        outputPanel.scrollTop = 120

        fireEvent.click(inputTab)

        const inputPanel = screen.getByRole('tabpanel')
        expect(inputTab).toHaveAttribute('aria-selected', 'true')
        expect(inputPanel).toHaveAttribute('id', inputTab.getAttribute('aria-controls'))
        expect(inputPanel).toHaveAttribute('aria-labelledby', inputTab.id)
        expect(inputPanel).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(inputPanel).not.toHaveTextContent('1418 tests passed')
        expect(inputPanel.scrollTop).toBe(0)
        expect(outputPanel.scrollTop).toBe(120)
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

        fireEvent.click(screen.getByTestId('terminal-execution-overlay'))

        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })
    })
})
