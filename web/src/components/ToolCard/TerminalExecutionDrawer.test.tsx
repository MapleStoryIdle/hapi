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
        expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument()
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
        expect(drawer.querySelectorAll('[role="tabpanel"], [role="tab"]')).toHaveLength(0)
        expect(drawer.querySelector('[data-terminal-execution-input]')).toBeInTheDocument()
        expect(drawer.querySelector('[data-terminal-execution-output]')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-execution-close')).toHaveClass('h-11', 'w-11')
        expect(screen.getByTestId('terminal-execution-close')).toHaveAccessibleName('Close')
    })

    it('shows three header rows, no tabs, and the exit code under output', () => {
        const view = render(<I18nProvider><DrawerHarness /></I18nProvider>)
        expect(screen.queryByRole('tab')).toBeNull()
        const header = view.baseElement.querySelector('.terminal-drawer-heading')!
        expect(header.querySelector('[data-terminal-directory]')).toHaveTextContent('/workspace/hapi')
        const status = header.querySelector('[data-terminal-status]')!
        expect(status.textContent).toBe('2.3s')
        expect(status).not.toHaveTextContent(';')
        expect(screen.queryByText('Completed')).toBeNull()
        expect(screen.getByRole('img', { name: 'Completed' })).toHaveClass('text-[var(--app-badge-success-text)]')
        const output = view.baseElement.querySelector('[data-terminal-execution-output]')!
        expect(output.lastElementChild).toHaveAttribute('data-terminal-execution-exit-code')
        expect(output.lastElementChild).toHaveTextContent('Exit code0')
        expect(view.baseElement).not.toHaveTextContent('SECRET_TOKEN')
    })

    it.each([
        ['error', 'Failed', 'failed', 'lucide-x'],
        ['running', 'Running', 'running', 'lucide-loader-circle'],
        ['pending', 'Pending', 'pending', 'lucide-clock3'],
    ] as const)('shows the %s icon with no visible state label', (state, label, status, icon) => {
        const block = makeBlock()
        block.tool.state = state
        render(<I18nProvider><TerminalExecutionDrawer block={block} open onOpenChange={() => undefined} /></I18nProvider>)
        const indicator = document.querySelector(`[data-terminal-status="${status}"]`)!
        expect(indicator.querySelector('svg')).toHaveClass(icon)
        expect(indicator).not.toHaveTextContent(label)
        expect(indicator.querySelector('[role="img"]')).toHaveAttribute('aria-label')
        if (state === 'error') expect(indicator.querySelector('[role="img"]')).toHaveClass('text-[var(--app-badge-error-text)]')
        if (state === 'running') expect(indicator.querySelector('svg')).toHaveClass('animate-spin', 'motion-reduce:animate-none')
    })

    it('expands a long directory without exposing other metadata', () => {
        const block = makeBlock()
        const cwd = '/workspace/' + 'long-project-directory/'.repeat(4) + 'shapi'
        block.tool.input = { command: 'git status', cwd }
        render(<I18nProvider><TerminalExecutionDrawer block={block} open onOpenChange={() => undefined} /></I18nProvider>)
        const path = screen.getByRole('button', { name: `Working directory: ${cwd}` })
        expect(path.textContent).toContain('…')
        fireEvent.click(path)
        expect(path.textContent).toBe(cwd)
        expect(path).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('button', { name: 'Copy directory' })).toBeInTheDocument()
    })

    it('hides unavailable directory, exit code and duration', () => {
        const block = makeBlock()
        block.tool.input = { command: 'git status' }
        block.tool.result = {}
        block.tool.completedAt = null
        render(<I18nProvider><TerminalExecutionDrawer block={block} open onOpenChange={() => undefined} /></I18nProvider>)
        expect(document.querySelector('[data-terminal-directory]')).toBeNull()
        expect(document.querySelector('[data-terminal-execution-exit-code]')).toBeNull()
        expect(document.querySelector('[data-terminal-status]')?.textContent).toBe('')
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

    it('reopens command and output directly', async () => {
        render(<I18nProvider><ResetDrawerHarness /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument())
        fireEvent.click(screen.getByRole('button', { name: 'Reopen drawer' }))
        expect(await screen.findByText('1418 tests passed')).toBeVisible()
        expect(screen.queryByRole('tab')).toBeNull()
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
