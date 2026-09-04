import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { NativeCodexFloatingStatusNotice } from './NativeCodexFloatingStatusNotice'

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

function renderNotice(props: Partial<ComponentProps<typeof NativeCodexFloatingStatusNotice>> = {}) {
    return render(
        <NativeCodexFloatingStatusNotice
            tone="warning"
            title="Waiting for local input"
            detail="Return to the local Codex session"
            noticeKey="waiting-for-input"
            statusLabel="Waiting for local input"
            testId="native-status"
            {...props}
        />
    )
}

describe('NativeCodexFloatingStatusNotice', () => {
    it('starts expanded, then collapses into an accessible compact warning control', () => {
        vi.useFakeTimers()
        renderNotice()

        const notice = screen.getByTestId('native-status')
        expect(notice).toHaveAttribute('data-status-collapsed', 'false')
        expect(notice).toHaveTextContent('Return to the local Codex session')
        expect(screen.queryByTestId('native-status-toggle')).not.toBeInTheDocument()

        act(() => vi.advanceTimersByTime(5_000))

        expect(notice).toHaveAttribute('data-status-collapsed', 'true')
        expect(screen.queryByText('Return to the local Codex session')).not.toBeInTheDocument()
        const compactToggle = screen.getByTestId('native-status-toggle')
        expect(compactToggle).toHaveAttribute('aria-expanded', 'false')
        expect(compactToggle).toHaveAccessibleName('Waiting for local input')
        expect(compactToggle).toHaveAttribute('title', 'Waiting for local input')
        expect(compactToggle).toHaveClass('h-11', 'w-11')
        expect(notice).toHaveClass('left-0')
        expect(compactToggle.parentElement).toHaveClass('relative')
        expect(compactToggle.parentElement).not.toHaveClass('ml-12')
        expect(compactToggle).toHaveClass('rounded-l-none')
        expect(compactToggle.querySelector('.lucide-circle-alert')).toHaveClass('text-amber-500')
    })

    it('uses a red icon for an error', () => {
        vi.useFakeTimers()
        renderNotice({
            tone: 'error',
            title: 'Could not create new session',
            statusLabel: 'Could not create new session'
        })

        act(() => vi.advanceTimersByTime(5_000))

        const compactToggle = screen.getByTestId('native-status-toggle')
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-tone', 'error')
        expect(compactToggle.querySelector('.lucide-circle-alert')).toHaveClass('text-red-500')
    })

    it('expands the compact control without showing a second prompt icon', () => {
        vi.useFakeTimers()
        renderNotice()
        act(() => vi.advanceTimersByTime(5_000))

        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')
        expect(screen.getByText('Return to the local Codex session')).toBeInTheDocument()
        expect(screen.queryByTestId('native-status-toggle')).not.toBeInTheDocument()
    })

    it('lets a manual expansion stay open instead of applying an older auto-collapse timer', () => {
        vi.useFakeTimers()
        renderNotice()

        act(() => vi.advanceTimersByTime(5_000))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'true')

        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')

        act(() => vi.advanceTimersByTime(5_000))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')
    })

    it('keeps the compact toggle keyboard-focusable after auto-collapse', () => {
        vi.useFakeTimers()
        renderNotice()

        act(() => vi.advanceTimersByTime(5_000))
        const toggle = screen.getByTestId('native-status-toggle')
        toggle.focus()
        expect(toggle).toHaveFocus()
    })

    it('moves action focus back to the compact toggle on auto-collapse', () => {
        vi.useFakeTimers()
        renderNotice({ action: { label: 'Retry', onClick: vi.fn() } })

        const retryButton = screen.getByRole('button', { name: 'Retry' })
        retryButton.focus()
        act(() => vi.advanceTimersByTime(5_000))
        expect(screen.getByTestId('native-status-toggle')).toHaveFocus()
    })

    it('resets to expanded and starts a fresh timer when the active notice changes', () => {
        vi.useFakeTimers()
        const { rerender } = renderNotice()
        act(() => vi.advanceTimersByTime(5_000))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'true')

        rerender(
            <NativeCodexFloatingStatusNotice
                tone="error"
                title="Could not create new session"
                detail="Runner unavailable"
                noticeKey="fork-error:runner-unavailable"
                statusLabel="Could not create new session"
                testId="native-status"
            />
        )

        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')
        expect(screen.getByText('Runner unavailable')).toBeInTheDocument()
        act(() => vi.advanceTimersByTime(4_999))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')
        act(() => vi.advanceTimersByTime(1))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'true')
    })

    it('keeps an expanded notice action usable', () => {
        const retry = vi.fn()
        renderNotice({
            tone: 'error',
            title: 'Could not create new session',
            statusLabel: 'Could not create new session',
            action: { label: 'Retry', onClick: retry }
        })

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(retry).toHaveBeenCalledTimes(1)
    })
})
