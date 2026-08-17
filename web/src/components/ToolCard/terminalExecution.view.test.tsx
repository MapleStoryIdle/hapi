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
                status: 'failed'
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
})
