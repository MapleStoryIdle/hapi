import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nContext, type Locale } from '@/lib/i18n-context'
import { SessionThinkingIndicator } from './SessionThinkingIndicator'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({ useReducedMotion: () => motion.reduced }))

afterEach(() => {
    cleanup()
    vi.useRealTimers()
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
    it('rotates a small, deterministic set of localized processing labels', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderIndicator({ startedAt: 99_000 })

        const status = screen.getByRole('status', { name: 'Thinking' })
        expect(status).toHaveTextContent('Thinking1s')
        expect(status).toHaveAttribute('aria-label', 'Thinking')
        expect(status.querySelector('svg')).toHaveClass('session-thinking__glyph')
        expect(status).toHaveAttribute('data-reduced-motion', 'false')
        expect(status).toHaveAttribute('data-tone', 'default')

        await act(async () => { vi.advanceTimersByTime(12_000) })
        expect(screen.getByRole('status', { name: 'Pondering' })).toHaveTextContent('Pondering13s')
        expect(status).toHaveAttribute('data-tone', 'warm')

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('uses the matching Chinese phrase and freezes its animation and label with reduced motion', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        motion.reduced = true
        const view = renderIndicator({ startedAt: 100_000 }, 'zh-CN')

        const status = screen.getByRole('status', { name: '思考中' })
        expect(status).toHaveTextContent('思考中0s')
        expect(status).toHaveAttribute('data-reduced-motion', 'true')

        await act(async () => { vi.advanceTimersByTime(24_000) })
        expect(screen.getByRole('status', { name: '思考中' })).toHaveTextContent('思考中24s')
        expect(status).toHaveAttribute('aria-label', '思考中')

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('warms at ten seconds and resets the clock, tone, and phrase for a new turn', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(100_000)
        const view = renderIndicator({ startedAt: 100_000 })
        const status = screen.getByRole('status')

        await act(async () => { vi.advanceTimersByTime(9_000) })
        expect(status).toHaveAttribute('data-tone', 'default')
        await act(async () => { vi.advanceTimersByTime(1_000) })
        expect(status).toHaveAttribute('data-tone', 'warm')
        await act(async () => { vi.advanceTimersByTime(2_000) })
        expect(status).toHaveAccessibleName('Pondering')

        view.rerender(
            <I18nContext.Provider value={{ locale: 'en', t: (key) => key, setLocale: () => {} }}>
                <SessionThinkingIndicator startedAt={112_000} />
            </I18nContext.Provider>
        )
        expect(status).toHaveTextContent('Thinking0s')
        expect(status).toHaveAttribute('data-tone', 'default')
        expect(vi.getTimerCount()).toBe(1)
        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
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
