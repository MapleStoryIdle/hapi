import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { TerminalTranscript } from './TerminalTranscript'
import type { TerminalExecutionDetails } from './terminalExecution'

const copy = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copy, copied: false }) }))
afterEach(() => { cleanup(); copy.mockReset(); copy.mockResolvedValue(true) })
const details: TerminalExecutionDetails = {
    command: 'echo "hello"', stdout: 'hello', stderr: 'a harmless warning',
    cwd: '/workspace', durationMs: 100, status: null, exitCode: 0
}

describe('TerminalTranscript', () => {
    it('keeps the command before output, toggles wrapping, and copies original content', async () => {
        const view = render(<I18nProvider><TerminalTranscript details={details} state="completed" /></I18nProvider>)
        const sections = view.container.querySelectorAll('pre')
        expect([...sections].map((pre) => pre.textContent)).toEqual([details.command, details.stdout, details.stderr])
        const input = view.container.querySelector('[data-terminal-execution-input]')!
        const output = view.container.querySelector('[data-terminal-execution-output]')!
        expect(input).toHaveClass('terminal-transcript-section')
        expect(output).toHaveClass('terminal-transcript-section')
        expect(input.parentElement).toBe(output.parentElement)
        expect(input.parentElement).toHaveClass('terminal-transcript-surface')
        expect(view.container.querySelectorAll('.terminal-transcript-surface')).toHaveLength(1)
        expect(view.container.querySelectorAll('.terminal-transcript-toolbar')).toHaveLength(2)
        expect(view.container.querySelectorAll('.terminal-transcript-label')).toHaveLength(2)
        expect(screen.getByText('$')).toHaveAttribute('aria-hidden', 'true')
        for (const label of ['Wrap lines', 'Copy command', 'Copy output']) {
            const button = screen.getByRole('button', { name: label })
            expect(button).toHaveAttribute('title', label)
            expect(button.textContent).toBe('')
            expect(button.querySelector('svg')).not.toBeNull()
        }
        expect(screen.getByRole('button', { name: 'Copy output' }).closest('[data-terminal-execution-output]')).not.toBeNull()
        expect(screen.getByRole('button', { name: 'Copy command' }).closest('[data-terminal-execution-input]')).not.toBeNull()
        const wrap = screen.getByRole('button', { name: 'Wrap lines' })
        expect(wrap).toHaveAttribute('aria-pressed', 'false')
        fireEvent.click(wrap)
        expect(wrap).toHaveAttribute('aria-pressed', 'true')
        for (const section of sections) expect(section).toHaveClass('whitespace-pre-wrap')
        fireEvent.click(wrap)
        for (const section of sections) expect(section).toHaveClass('whitespace-pre')
        fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
        await waitFor(() => expect(copy).toHaveBeenCalledWith(details.command))
        fireEvent.click(screen.getByRole('button', { name: 'Copy output' }))
        await waitFor(() => expect(copy).toHaveBeenCalledWith('stdout:\nhello\n\nstderr:\na harmless warning'))
        expect(screen.getByText('stderr')).not.toHaveClass('text-[var(--app-badge-error-text)]')
    })

    it('reports copy failure without claiming success', async () => {
        copy.mockResolvedValue(false)
        render(<I18nProvider><TerminalTranscript details={{ ...details, stdout: null, stderr: null }} state="running" /></I18nProvider>)
        expect(screen.getByText('Waiting for terminal output…')).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Copy output' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
        await screen.findByText('Copy failed. Try again.')
        expect(screen.queryByText('Copied')).toBeNull()
    })

    it('highlights stderr only on a failed execution', () => {
        render(<I18nProvider><TerminalTranscript details={details} state="failed" /></I18nProvider>)
        expect(screen.getByText('stderr')).toHaveClass('text-[var(--app-badge-error-text)]')
    })

    it('preserves multiline shell text and does not invent a missing command', () => {
        const command = 'printf "%s\\n" "$HOME"\ncat <<\'EOF\'\n<script>alert(1)</script>\nEOF'
        const view = render(<I18nProvider><TerminalTranscript details={{ ...details, command }} state="completed" /></I18nProvider>)
        expect(view.container.querySelector('[data-terminal-execution-input] code')?.textContent).toBe(command)
        expect(view.container.querySelector('script')).toBeNull()
        view.rerender(<I18nProvider><TerminalTranscript details={{ ...details, command: null }} state="completed" /></I18nProvider>)
        expect(screen.queryByText('$')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
    })
})
