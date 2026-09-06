import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nContext, type Locale } from '@/lib/i18n-context'
import { SessionThinkingIndicator } from './SessionThinkingIndicator'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({ useReducedMotion: () => motion.reduced }))

beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    motion.reduced = false
})

function renderIndicator(props: ComponentProps<typeof SessionThinkingIndicator>, locale: Locale = 'en') {
    return render(
        <I18nContext.Provider value={{ locale, t: (key) => key, setLocale: () => {} }}>
            <SessionThinkingIndicator {...props} />
        </I18nContext.Provider>
    )
}

describe('SessionThinkingIndicator', () => {
    it('randomly selects another phrase only after eight seconds', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderIndicator({ startedAt: 99_000 })

        const status = screen.getByRole('status', { name: 'Thinking' })
        expect(status).toHaveTextContent('Thinking1s')
        expect(status).toHaveAttribute('aria-label', 'Thinking')
        expect(status.querySelector('svg')).toHaveClass('session-thinking__glyph')
        expect(status).toHaveAttribute('data-reduced-motion', 'false')
        expect(status).toHaveAttribute('data-tone', 'warm')

        vi.mocked(Math.random).mockReturnValue(0.99)
        await act(async () => { vi.advanceTimersByTime(7_999) })
        expect(status).toHaveTextContent('Thinking8s')
        await act(async () => { vi.advanceTimersByTime(1) })
        expect(screen.getByRole('status', { name: 'Thinking' })).toHaveTextContent('Working9s')
        await act(async () => { vi.advanceTimersByTime(8_000) })
        expect(status).toHaveTextContent('Pondering17s')
        vi.mocked(Math.random).mockReturnValue(0)
        await act(async () => { vi.advanceTimersByTime(8_000) })
        expect(status).toHaveTextContent('Working25s')
        expect(status).toHaveAttribute('data-tone', 'warm')

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('uses the matching Chinese phrase and disables animation but still rotates Chinese text with reduced motion', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        motion.reduced = true
        const view = renderIndicator({ startedAt: 100_000 }, 'zh-CN')

        const status = screen.getByRole('status', { name: '思考中' })
        expect(status).toHaveTextContent('思考中0s')
        expect(status).toHaveAttribute('data-reduced-motion', 'true')

        await act(async () => { vi.advanceTimersByTime(8_000) })
        expect(screen.getByRole('status', { name: '思考中' })).toHaveTextContent('推敲中8s')
        expect(status).toHaveAttribute('aria-label', '思考中')

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('starts warm immediately and resets the clock and phrase for a new turn', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderIndicator({ startedAt: 100_000 })
        const status = screen.getByRole('status')

        expect(status).toHaveTextContent('Thinking0s')
        expect(status).toHaveAttribute('data-tone', 'warm')
        await act(async () => { vi.advanceTimersByTime(8_000) })
        expect(status).toHaveTextContent('Pondering8s')
        expect(status).toHaveAccessibleName('Thinking')

        view.rerender(
            <I18nContext.Provider value={{ locale: 'en', t: (key) => key, setLocale: () => {} }}>
                <SessionThinkingIndicator startedAt={108_000} />
            </I18nContext.Provider>
        )
        expect(status).toHaveTextContent('Thinking0s')
        expect(status).toHaveAttribute('data-tone', 'warm')
        expect(vi.getTimerCount()).toBe(1)
        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('randomizes the first phrase and keeps it stable through ordinary rerenders', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        vi.mocked(Math.random).mockReturnValue(0.99)
        const view = renderIndicator({ startedAt: 99_000 })
        const status = screen.getByRole('status', { name: 'Thinking' })
        expect(status).toHaveTextContent('Working1s')
        view.rerender(
            <I18nContext.Provider value={{ locale: 'en', t: (key) => key, setLocale: () => {} }}>
                <SessionThinkingIndicator startedAt={99_000} compact />
            </I18nContext.Provider>
        )
        expect(Math.random).toHaveBeenCalledTimes(1)
        await act(async () => { vi.advanceTimersByTime(7_000) })
        expect(status).toHaveTextContent('Working8s')
        expect(Math.random).toHaveBeenCalledTimes(1)
    })

    it('never replaces a real connection label or treats a long connection as thinking', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        renderIndicator({ label: 'Matching agent', startedAt: 100_000 })
        await act(async () => { vi.advanceTimersByTime(60_000) })
        const status = screen.getByRole('status', { name: 'Matching agent' })
        expect(status).toHaveTextContent('Matching agent1m')
        expect(status).toHaveAttribute('data-tone', 'default')
    })

    it('renders a supplied label whole and keeps the changing timer out of the accessible name', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderIndicator({ label: 'Checking workspace', startedAt: 99_000, compact: true })

        const status = screen.getByRole('status', { name: 'Checking workspace' })
        expect(status).toHaveTextContent('Checking workspace1s')
        expect(status.querySelector('span:last-child')).toHaveAttribute('aria-hidden', 'true')

        await act(async () => { vi.advanceTimersByTime(1_000) })
        expect(screen.getByRole('status', { name: 'Checking workspace' })).toHaveTextContent('Checking workspace2s')

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })
})
