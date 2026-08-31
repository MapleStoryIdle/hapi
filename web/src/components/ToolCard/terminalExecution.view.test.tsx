import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { TerminalExecutionDetail } from '@/components/ToolCard/terminalExecution'
import { I18nProvider } from '@/lib/i18n-context'

function makeBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'terminal-layout',
        localId: null,
        createdAt: 100,
        children: [],
        tool: {
            id: 'terminal-layout',
            name: 'CodexBash',
            state: 'error',
            input: {
                command: '/bin/zsh -lc "bun test"',
                cwd: '/workspace/hapi'
            },
            result: {
                stdout: 'test output',
                stderr: 'test failure',
                exit_code: 1,
                status: 'failed',
                environment: 'SECRET_TOKEN=must-not-render'
            },
            createdAt: 100,
            startedAt: 200,
            completedAt: 1_450,
            description: null
        }
    }
}

describe('TerminalExecutionDetail', () => {
    it('places the exit code below the output', () => {
        const view = render(
            <I18nProvider>
                <TerminalExecutionDetail block={makeBlock()} />
            </I18nProvider>
        )

        const sections = Array.from(view.container.querySelectorAll(
            '[data-terminal-execution-overview], [data-terminal-execution-input], [data-terminal-execution-output]'
        ))
        expect(sections).toHaveLength(3)
        expect(sections[0]).toHaveAttribute('data-terminal-execution-overview')
        expect(sections[1]).toHaveAttribute('data-terminal-execution-input')
        expect(sections[2]).toHaveAttribute('data-terminal-execution-output')

        const exitCode = view.container.querySelector<HTMLElement>('[data-terminal-execution-exit-code]')
        if (!exitCode) throw new Error('expected exit-code detail')

        expect(screen.getByText('Status')).toBeInTheDocument()
        expect(screen.getByText('Duration')).toBeInTheDocument()
        expect(sections[0]).not.toHaveTextContent('Exit code')
        expect(sections[2]).toContainElement(exitCode)
        expect(exitCode).toHaveTextContent('Exit code')
        expect(exitCode).toHaveTextContent('exit 1')
        expect(screen.getByText('1.3s')).toBeInTheDocument()
        expect(screen.getByText('Input')).toBeInTheDocument()
        expect(screen.getByText('Output')).toBeInTheDocument()
        expect(screen.getByText('Working directory')).toBeInTheDocument()
        expect(screen.getByText('/workspace/hapi')).toBeInTheDocument()
    })

    it('keeps drawer environment metadata separate from command and output', () => {
        const view = render(
            <I18nProvider>
                <TerminalExecutionDetail
                    block={makeBlock()}
                    drawerTab="environment"
                    labelledBy="terminal-tab-environment"
                    panelId="terminal-panel-environment"
                    surface="drawer"
                />
            </I18nProvider>
        )

        const panel = view.container.querySelector<HTMLElement>('[data-terminal-execution-panel="environment"]')
        if (!panel) throw new Error('expected environment panel')

        expect(panel).toHaveAttribute('role', 'tabpanel')
        expect(panel).toHaveAttribute('id', 'terminal-panel-environment')
        expect(panel).toHaveAttribute('aria-labelledby', 'terminal-tab-environment')
        expect(panel).toHaveClass('overflow-y-auto', 'overscroll-contain', 'pb-[max(var(--app-safe-area-bottom),1.25rem)]')
        expect(panel).toHaveTextContent('Status')
        expect(panel).toHaveTextContent('Failed')
        expect(panel).toHaveTextContent('Working directory')
        expect(panel).toHaveTextContent('/workspace/hapi')
        expect(panel).toHaveTextContent('Duration')
        expect(panel).toHaveTextContent('1.3s')
        expect(panel).toHaveTextContent('Exit code')
        expect(panel).toHaveTextContent('exit 1')
        expect(panel).not.toHaveTextContent('/bin/zsh -lc "bun test"')
        expect(panel).not.toHaveTextContent('test output')
        expect(panel).not.toHaveTextContent('test failure')
        expect(panel).not.toHaveTextContent('SECRET_TOKEN=must-not-render')
    })
})
