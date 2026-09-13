import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonitorTokenReveal } from './MonitorTokenReveal'

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('MonitorTokenReveal', () => {
    it('shows the credential and copies the URL or complete POST command without network requests', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        const writeText = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('navigator', { clipboard: { writeText } })
        render(<MonitorTokenReveal token="one-time-webhook-token" baseUrl="https://hub.example" t={(key) => key} />)

        expect(screen.getByTestId('monitor-token-reveal')).toBeInTheDocument()
        expect(screen.getByTestId('monitor-token-reveal')).toHaveTextContent('one-time-webhook-token')
        fireEvent.click(screen.getByRole('button', { name: 'monitors.copy.url' }))
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://hub.example/hooks/events?token=one-time-webhook-token'))
        fireEvent.click(screen.getByRole('button', { name: 'monitors.copy.curl' }))
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('curl -X POST')))
        expect(writeText.mock.calls.at(-1)?.[0]).toContain('--data-raw \'{"prompt":"YOUR_PROMPT","data":{"key":"value"}}\'')
        expect(writeText.mock.calls.at(-1)?.[0]).toContain('token=one-time-webhook-token')
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
