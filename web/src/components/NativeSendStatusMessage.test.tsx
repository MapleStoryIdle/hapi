import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { formatNativeSendWait, NativeSendStatusMessage, type NativeSendConnectionPhase } from './NativeSendStatusMessage'

afterEach(() => { cleanup(); vi.useRealTimers() })

async function tick(count: number) {
    for (let i = 0; i < count; i++) await act(async () => { vi.advanceTimersByTime(40) })
}

async function waitForFullLabel(label: string) {
    for (let i = 0; i < 100; i++) {
        if (screen.queryByRole('status')?.firstElementChild?.textContent === label) return
        await tick(1)
    }
    expect(screen.getByRole('status').firstElementChild).toHaveTextContent(label)
}

describe('NativeSendStatusMessage', () => {
    it.each([[1_000, '1s'], [60_000, '1m'], [300_000, '5m'], [3_600_000, '1h'], [3_903_000, '1h5m3s']])('formats %i ms as %s', (ms, text) => {
        expect(formatNativeSendWait(ms)).toBe(text)
    })

    it('finishes typing and holds every observed phase for a full second even after real output', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const phases: Array<[NativeSendConnectionPhase, string]> = [
            ['launching', '启动连接中'], ['matching', '匹配 Agent'],
            ['connected', 'Agent 已连接'], ['retrying', '重试发送中']
        ]
        const view = render(<NativeSendStatusMessage phase={null} label="" startedAt={null} />)
        for (const [phase, label] of phases) {
            view.rerender(<NativeSendStatusMessage phase={phase} label={label} startedAt={99_000} />)
            await tick(1)
        }
        view.rerender(<NativeSendStatusMessage phase={null} label="" startedAt={null} />)

        for (const [phase, label] of phases) {
            await waitForFullLabel(label)
            const row = screen.getByRole('status', { name: label })
            expect(row).toHaveAttribute('data-testid', `codex-direct-send-phase-${phase}`)
            expect(row.children).toHaveLength(2) // Wait time remains visible during the minimum hold.
            await act(async () => { vi.advanceTimersByTime(999) })
            expect(row.firstElementChild?.textContent).toBe(label)
            await act(async () => { vi.advanceTimersByTime(1) })
            expect(row.firstElementChild?.textContent).toBe(Array.from(label).slice(0, -1).join(''))
        }
        await tick(20)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not restart the hold or enqueue duplicates when the same phase refreshes', async () => {
        vi.useFakeTimers()
        const view = render(<NativeSendStatusMessage phase="connected" label="Agent 已连接" startedAt={Date.now()} />)
        await waitForFullLabel('Agent 已连接')
        await tick(20)
        view.rerender(<NativeSendStatusMessage phase="connected" label="Agent 已连接" startedAt={Date.now()} />)
        view.rerender(<NativeSendStatusMessage phase={null} label="" startedAt={null} />)
        await act(async () => { vi.advanceTimersByTime(199) })
        expect(screen.getByRole('status').firstElementChild?.textContent).toBe('Agent 已连接')
        await act(async () => { vi.advanceTimersByTime(1) })
        expect(screen.getByRole('status').firstElementChild?.textContent).toBe('Agent 已连')
        await tick(20)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps a slow phase visible until it changes, then cleans up on unmount', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = render(<NativeSendStatusMessage phase="launching" label="Starting connection" startedAt={99_000} />)
        await waitForFullLabel('Starting connection')
        await tick(50)
        expect(screen.getByRole('status')).toHaveTextContent('Starting connection3s')
        view.rerender(<NativeSendStatusMessage phase="matching" label="Matching Agent" startedAt={Date.now()} />)
        await tick(1)
        expect(screen.getByRole('status').firstElementChild?.textContent).toBe('Starting connectio')
        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('does not delay the reply or clicks and does not invent unobserved phases', async () => {
        vi.useFakeTimers()
        const onClick = vi.fn()
        const view = render(<NativeSendStatusMessage phase="launching" label="启动连接中" startedAt={Date.now()} />)
        // Codex replies before even the first character is typed.
        view.rerender(<>
            <NativeSendStatusMessage phase={null} label="" startedAt={null} />
            <p>Codex reply</p>
            <button onClick={onClick}>Continue</button>
        </>)
        expect(screen.getByText('Codex reply')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        expect(onClick).toHaveBeenCalledOnce()

        await waitForFullLabel('启动连接中')
        await tick(24)
        expect(screen.getByRole('status').firstElementChild?.textContent).toBe('启动连接中')
        await tick(10)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })
})
