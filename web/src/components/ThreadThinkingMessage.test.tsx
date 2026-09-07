import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ThreadThinkingMessage } from './ThreadThinkingMessage'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('ThreadThinkingMessage', () => {
    it('keeps a single separate row and one clock through connection and processing', () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const tree = (label?: string, running = true, waitingForUser = false) => (
            <I18nProvider><ThreadThinkingMessage running={running} waitingForUser={waitingForUser} label={label} startedAt={100_000} /></I18nProvider>
        )
        const view = render(tree('Starting connection'))
        const row = screen.getByTestId('thread-thinking-message')
        expect(row).toHaveClass('w-full', 'shrink-0', 'px-2')
        act(() => { vi.advanceTimersByTime(2_000) })
        view.rerender(tree('Matching agent'))
        expect(row).toHaveTextContent('2s')
        view.rerender(tree())
        expect(screen.getAllByTestId('session-thinking-indicator')).toHaveLength(1)
        expect(row).toHaveTextContent('2s')
        expect(screen.getByTestId('session-thinking-indicator')).toHaveAttribute('data-tone', 'warm')
        view.rerender(tree(undefined, true, true))
        expect(screen.queryByTestId('thread-thinking-message')).toBeNull()
        view.rerender(tree(undefined, false))
        expect(vi.getTimerCount()).toBe(0)
        act(() => { vi.advanceTimersByTime(5_000) })
        view.rerender(tree())
        expect(screen.getByTestId('thread-thinking-message')).toHaveTextContent('7s')
    })
    it('does not show waiting feedback for an idle/queued-only session', () => {
        render(<I18nProvider><ThreadThinkingMessage running={false} /></I18nProvider>)
        expect(screen.queryByRole('status')).toBeNull()
    })
    it('stops once the current turn has a visible process row', () => {
        const view = render(<I18nProvider><ThreadThinkingMessage running startedAt={100_000} /></I18nProvider>)
        expect(screen.getByTestId('thread-thinking-message')).toBeInTheDocument()
        view.rerender(<I18nProvider><ThreadThinkingMessage running startedAt={100_000} hasProcess /></I18nProvider>)
        expect(screen.queryByTestId('thread-thinking-message')).toBeNull()
    })
    it('restores the task clock on remount and accepts a new turn without an idle render', () => {
        vi.useFakeTimers()
        vi.setSystemTime(200_000)
        const tree = (startedAt?: number) => <I18nProvider><ThreadThinkingMessage running startedAt={startedAt} /></I18nProvider>
        const first = render(tree(100_000))
        expect(screen.getByRole('status')).toHaveTextContent('1m40s')
        first.unmount()
        vi.setSystemTime(210_000)
        const second = render(tree(100_000))
        expect(screen.getByRole('status')).toHaveTextContent('1m50s')
        second.rerender(tree(205_000))
        expect(screen.getByRole('status')).toHaveTextContent('5s')
        second.rerender(tree())
        expect(screen.getByRole('status').textContent).not.toMatch(/\d/)
        second.rerender(tree(205_000))
        expect(screen.getByRole('status')).toHaveTextContent('5s')
    })
    it.each([undefined, null, NaN, Infinity, 0, -1, 300_000])('hides unreliable timestamp %s', (startedAt) => {
        vi.useFakeTimers()
        vi.setSystemTime(200_000)
        render(<I18nProvider><ThreadThinkingMessage running startedAt={startedAt} /></I18nProvider>)
        expect(screen.getByRole('status').textContent).not.toMatch(/\d/)
    })
})
