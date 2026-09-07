import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nContext } from '@/lib/i18n-context'
import type { AgentState } from '@/types/api'
import { StatusBar, type StatusBarProps } from './StatusBar'

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

function statusBar(props: Partial<StatusBarProps> = {}) {
    const defaults: StatusBarProps = {
        active: true,
        thinking: true,
        agentState: null
    }

    return (
        <I18nContext.Provider value={{ locale: 'en', t: (key) => key, setLocale: () => {} }}>
            <StatusBar {...defaults} {...props} />
        </I18nContext.Provider>
    )
}

describe('StatusBar thinking state', () => {
    it('leaves thinking to the message thread', () => {
        vi.useFakeTimers()
        const view = render(statusBar())

        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
        expect(screen.queryByRole('status', { name: 'Thinking' })).toBeNull()

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps voice, offline, permission, and idle states ahead of the thinking branch', () => {
        vi.useFakeTimers()
        const permissionState: AgentState = {
            requests: {
                permission: { tool: 'Bash', arguments: {}, createdAt: null }
            }
        }
        const view = render(statusBar())
        expect(vi.getTimerCount()).toBe(0)
        view.rerender(statusBar({ voiceStatus: 'connecting' }))

        expect(screen.getByText('voice.connecting')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)

        view.rerender(statusBar({ active: false }))
        expect(screen.getByText('misc.offline')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()

        view.rerender(statusBar())
        expect(vi.getTimerCount()).toBe(0)
        view.rerender(statusBar({ agentState: permissionState }))
        expect(screen.getByText('misc.permissionRequired')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)

        view.rerender(statusBar())
        expect(vi.getTimerCount()).toBe(0)
        view.rerender(statusBar({ thinking: false }))
        expect(screen.getByText('misc.online')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
    })
})
