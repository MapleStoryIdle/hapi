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
        const toggle = screen.getByTestId('native-status-toggle')
        expect(notice).toHaveAttribute('data-status-collapsed', 'false')
        expect(notice).toHaveTextContent('Return to the local Codex session')
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBeInTheDocument()

        act(() => vi.advanceTimersByTime(5_000))

        expect(notice).toHaveAttribute('data-status-collapsed', 'true')
        expect(screen.getByText('Return to the local Codex session')).not.toBeVisible()
        const compactToggle = screen.getByTestId('native-status-toggle')
        expect(compactToggle).toHaveAttribute('aria-expanded', 'false')
        expect(compactToggle).toHaveAccessibleName('Waiting for local input')
        expect(compactToggle).toHaveAttribute('title', 'Waiting for local input')
        expect(compactToggle).toHaveClass('h-11', 'w-11')
        expect(compactToggle.parentElement).toHaveClass('ml-12')
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

    it('toggles between the compact control and the expanded notice', () => {
        vi.useFakeTimers()
        renderNotice()
        act(() => vi.advanceTimersByTime(5_000))

        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')
        expect(screen.getByTestId('native-status-toggle')).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Return to the local Codex session')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'true')
        expect(screen.getByTestId('native-status-toggle')).toHaveAttribute('aria-expanded', 'false')
    })

    it('lets a manual expansion stay open instead of applying an older auto-collapse timer', () => {
        vi.useFakeTimers()
        renderNotice()

        act(() => vi.advanceTimersByTime(1_000))
        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'true')

        act(() => vi.advanceTimersByTime(1_000))
        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')

        act(() => vi.advanceTimersByTime(5_000))
        expect(screen.getByTestId('native-status')).toHaveAttribute('data-status-collapsed', 'false')
    })

    it('keeps keyboard focus on the toggle while it is manually expanded or collapsed', () => {
        vi.useFakeTimers()
        renderNotice()

        const toggle = screen.getByTestId('native-status-toggle')
        toggle.focus()
        fireEvent.click(toggle)
        expect(screen.getByTestId('native-status-toggle')).toHaveFocus()
        fireEvent.click(screen.getByTestId('native-status-toggle'))
        expect(screen.getByTestId('native-status-toggle')).toHaveFocus()
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
