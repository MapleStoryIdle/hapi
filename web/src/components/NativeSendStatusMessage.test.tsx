import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { formatNativeSendWait, NativeSendStatusMessage } from './NativeSendStatusMessage'

afterEach(() => { cleanup(); vi.useRealTimers() })

async function tick(count: number) {
    for (let i = 0; i < count; i++) await act(async () => { vi.advanceTimersByTime(40) })
}

describe('NativeSendStatusMessage', () => {
    it.each([[1_000, '1s'], [60_000, '1m'], [300_000, '5m'], [3_600_000, '1h'], [3_903_000, '1h5m3s']])('formats %i ms as %s', (ms, text) => {
        expect(formatNativeSendWait(ms)).toBe(text)
    })

    it('types, erases, replaces and leaves after real output without retaining timers', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = render(<NativeSendStatusMessage phase="launching" label="启动连接中" startedAt={99_000} />)
        await tick(3)
        expect(screen.getByRole('status')).toHaveTextContent('启动')
        expect(screen.getByRole('status')).not.toHaveTextContent('启动连接中')
        await tick(5)
        expect(screen.getByRole('status')).toHaveTextContent('启动连接中1s')

        view.rerender(<NativeSendStatusMessage phase="matching" label="匹配 Agent" startedAt={Date.now()} />)
        await tick(1)
        expect(screen.getByRole('status')).toHaveTextContent('启动连接')
        expect(screen.getByRole('status')).not.toHaveTextContent('匹配')
        await tick(15)
        expect(screen.getByRole('status')).toHaveTextContent('匹配 Agent')

        view.rerender(<NativeSendStatusMessage phase={null} label="" startedAt={null} />)
        await tick(1)
        expect(screen.getByRole('status')).toHaveTextContent('匹配 Agen')
        await tick(12)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('uses the newest phase when status changes again while erasing', async () => {
        vi.useFakeTimers()
        const view = render(<NativeSendStatusMessage phase="launching" label="启动连接中" startedAt={1} />)
        await tick(8)
        view.rerender(<NativeSendStatusMessage phase="matching" label="匹配 Agent" startedAt={2} />)
        await tick(1)
        view.rerender(<NativeSendStatusMessage phase="connected" label="Agent 已连接" startedAt={3} />)
        await tick(20)
        expect(screen.getByRole('status')).toHaveTextContent('Agent 已连接')
        expect(screen.queryByText('匹配 Agent')).toBeNull()
    })
})
