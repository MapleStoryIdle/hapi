import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider, useToast } from './toast-context'

function ToastProbe() {
    const { addToast, toasts } = useToast()

    return (
        <>
            <button type="button" onClick={() => addToast({ title: 'First error', kind: 'error' })}>First</button>
            <button type="button" onClick={() => addToast({ title: 'Latest success', kind: 'success' })}>Latest</button>
            <output>{toasts.map((toast) => `${toast.title}:${toast.kind}`).join(',')}</output>
        </>
    )
}

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe('ToastProvider', () => {
    it('keeps one contextual toast and replaces older events', () => {
        render(
            <ToastProvider>
                <ToastProbe />
            </ToastProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'First' }))
        fireEvent.click(screen.getByRole('button', { name: 'Latest' }))

        expect(screen.getByRole('status')).toHaveTextContent('Latest success:success')
        expect(screen.getByRole('status')).not.toHaveTextContent('First error')
    })

    it('uses the semantic success duration and keeps errors until dismissed', async () => {
        vi.useFakeTimers()
        render(
            <ToastProvider>
                <ToastProbe />
            </ToastProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Latest' }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000)
        })
        expect(screen.getByRole('status')).toBeEmptyDOMElement()

        fireEvent.click(screen.getByRole('button', { name: 'First' }))
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10_000)
        })
        expect(screen.getByRole('status')).toHaveTextContent('First error:error')
    })
})
