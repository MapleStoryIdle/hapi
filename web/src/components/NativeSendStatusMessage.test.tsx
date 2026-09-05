import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { formatNativeSendWait, NativeSendStatusMessage, type NativeSendConnectionPhase, type NativeSendStatusEntry } from './NativeSendStatusMessage'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({ useReducedMotion: () => motion.reduced }))

afterEach(() => { cleanup(); vi.useRealTimers(); motion.reduced = false })

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

    it('plays every stage from one coalesced snapshot even when real output arrived in the same render', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const history: NativeSendStatusEntry[] = [
            { phase: 'launching', label: '启动连接中', startedAt: 100_000 },
            { phase: 'matching', label: '匹配 Agent', startedAt: 100_001 },
            { phase: 'connected', label: 'Agent 已连接', startedAt: 100_002 },
            { phase: 'retrying', label: '重试发送中', startedAt: 100_003 }
        ]
        const view = render(<NativeSendStatusMessage phase="launching" label="启动连接中" startedAt={100_000} />)
        view.rerender(<NativeSendStatusMessage phase={null} label="" startedAt={null} history={history} historyStartedAt={100_000} />)

        for (const entry of history) {
            await waitForFullLabel(entry.label)
            // Repeated snapshots, including new object identities, cannot replay stages.
            view.rerender(<NativeSendStatusMessage phase={null} label="" startedAt={null} history={[...history]} historyStartedAt={100_000} />)
            await tick(24)
            expect(screen.getByRole('status').firstElementChild?.textContent).toBe(entry.label)
            await tick(1)
            expect(screen.getByRole('status').firstElementChild?.textContent).not.toBe(entry.label)
        }
        await tick(20)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('waits with cycling Reasoning dots and elapsed time after playback, stopping on real output', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const history: NativeSendStatusEntry[] = [
            { phase: 'launching', label: '启动连接中', startedAt: 100_000 },
            { phase: 'matching', label: '匹配 Agent', startedAt: 100_001 },
            { phase: 'connected', label: 'Agent 已连接', startedAt: 100_002 }
        ]
        const props = {
            phase: 'connected' as const, label: 'Agent 已连接', startedAt: 100_002,
            history, historyStartedAt: 100_000, waitingForOutput: true, waitingStartedAt: 100_002
        }
        const view = render(<NativeSendStatusMessage {...props} />)
        for (const entry of history) {
            await waitForFullLabel(entry.label)
            await tick(24)
            expect(screen.getByRole('status').firstElementChild?.textContent).toBe(entry.label)
            await tick(1)
        }
        await tick(20)
        const waiting = screen.getByRole('status', { name: 'Reasoning' })
        expect(waiting.children[1]?.textContent).toMatch(/^\d+s$/)
        const frames: string[] = []
        for (let i = 0; i < 4; i++) {
            frames.push(waiting.firstElementChild?.textContent ?? '')
            await act(async () => { vi.advanceTimersByTime(500) })
        }
        expect(new Set(frames.slice(0, 3))).toEqual(new Set(['Reasoning.', 'Reasoning..', 'Reasoning...']))
        expect(frames[3]).toBe(frames[0])

        view.rerender(<NativeSendStatusMessage {...props} phase={null} label="" waitingForOutput={false} />)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('starts a new send without duplicating its local launch or replaying an older history', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const first: NativeSendStatusEntry[] = [{ phase: 'connected', label: 'Agent 已连接', startedAt: 100_000 }]
        const view = render(<NativeSendStatusMessage phase={null} label="" startedAt={null} history={first} historyStartedAt={100_000} />)
        await tick(70)
        expect(screen.queryByRole('status')).toBeNull()

        view.rerender(<NativeSendStatusMessage phase="launching" label="启动连接中" startedAt={200_000} />)
        const second: NativeSendStatusEntry[] = [
            { phase: 'launching', label: '启动连接中', startedAt: 200_001 },
            { phase: 'matching', label: '匹配 Agent', startedAt: 200_002 }
        ]
        view.rerender(<NativeSendStatusMessage phase={null} label="" startedAt={null} history={second} historyStartedAt={200_001} />)
        await waitForFullLabel('启动连接中')
        await tick(25)
        await waitForFullLabel('匹配 Agent') // No second launch can occur before matching.
        await tick(25)
        await tick(20)
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps full labels and a static ellipsis when reduced motion is requested', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        motion.reduced = true
        const view = render(<NativeSendStatusMessage phase="connected" label="Agent 已连接" startedAt={100_000} waitingForOutput waitingStartedAt={100_000} />)
        await tick(1)
        expect(screen.getByRole('status').firstElementChild?.textContent).toBe('Agent 已连接')
        await tick(24)
        expect(screen.getByRole('status').firstElementChild?.textContent).toBe('Agent 已连接')
        await tick(1)
        expect(screen.getByRole('status', { name: 'Reasoning' }).firstElementChild?.textContent).toBe('Reasoning...')
        await tick(50)
        expect(screen.getByRole('status', { name: 'Reasoning' })).toHaveTextContent('Reasoning...3s')
        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })
})
