import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    formatNativeSendWait,
    NativeSendStatusMessage,
    type NativeSendConnectionPhase,
    type NativeSendStatusEntry
} from './NativeSendStatusMessage'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({ useReducedMotion: () => motion.reduced }))

type NativeSendProps = ComponentProps<typeof NativeSendStatusMessage>

afterEach(() => {
    cleanup()
    vi.useRealTimers()
    motion.reduced = false
})

function statusMessage(props: NativeSendProps) {
    return (
        <I18nProvider>
            <NativeSendStatusMessage {...props} />
        </I18nProvider>
    )
}

describe('NativeSendStatusMessage', () => {
    it.each([[1_000, '1s'], [60_000, '1m'], [300_000, '5m'], [3_600_000, '1h'], [3_903_000, '1h5m3s']])('formats %i ms as %s', (ms, text) => {
        expect(formatNativeSendWait(ms)).toBe(text)
    })

    it('shows each current phase immediately and never replays rapid switches', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = render(statusMessage({ phase: 'launching', label: 'Starting connection', startedAt: 99_000 }))

        expect(screen.getByRole('status', { name: 'Starting connection' })).toHaveTextContent('Starting connection1s')
        expect(screen.getByTestId('codex-direct-send-phase-launching')).toBeInTheDocument()

        view.rerender(statusMessage({ phase: 'matching', label: 'Matching agent', startedAt: 99_100 }))
        expect(screen.queryByRole('status', { name: 'Starting connection' })).toBeNull()
        expect(screen.getByRole('status', { name: 'Matching agent' })).toHaveTextContent('Matching agent0s')

        view.rerender(statusMessage({ phase: 'connected', label: 'Agent connected', startedAt: 99_200 }))
        expect(screen.queryByRole('status', { name: 'Matching agent' })).toBeNull()
        expect(screen.getByRole('status', { name: 'Agent connected' })).toHaveTextContent('Agent connected0s')

        view.rerender(statusMessage({ phase: null, label: '', startedAt: null }))
        expect(screen.queryByRole('status')).toBeNull()
        await act(async () => { vi.advanceTimersByTime(60_000) })
        expect(screen.queryByRole('status')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('removes a null phase immediately even when history is supplied', () => {
        const history: NativeSendStatusEntry[] = [
            { phase: 'launching', label: 'Starting connection', startedAt: 100_000 },
            { phase: 'matching', label: 'Matching agent', startedAt: 100_100 }
        ]

        render(statusMessage({
            phase: null,
            label: '',
            startedAt: null,
            history,
            historyStartedAt: 100_000,
            waitingForOutput: true,
            waitingStartedAt: 100_100
        }))

        expect(screen.queryByRole('status')).toBeNull()
    })

    it('uses the shared thinking indicator only while the current phase is connected', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = render(statusMessage({
            phase: 'connected',
            label: 'Agent connected',
            startedAt: 100_000,
            waitingForOutput: true,
            waitingStartedAt: 99_000
        }))

        expect(screen.getByTestId('session-thinking-indicator')).toBeInTheDocument()
        expect(screen.getByRole('status', { name: 'Thinking' })).toHaveTextContent('Thinking1s')
        expect(screen.queryByTestId('codex-direct-send-phase-connected')).toBeNull()

        await act(async () => { vi.advanceTimersByTime(1_000) })
        expect(screen.getByRole('status', { name: 'Thinking' })).toHaveTextContent('Thinking2s')

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each<NativeSendConnectionPhase>(['launching', 'matching', 'connected', 'retrying'])('keeps the supplied %s label whole with elapsed time', (phase) => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const label = `Current ${phase} phase`
        render(statusMessage({ phase, label, startedAt: 99_000 }))
        expect(screen.getByRole('status', { name: label })).toHaveTextContent(`${label}1s`)
    })
})
