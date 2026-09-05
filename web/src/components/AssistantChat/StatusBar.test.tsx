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
    it('uses the shared thinking indicator', () => {
        vi.useFakeTimers()
        const view = render(statusBar())

        expect(screen.getByTestId('session-thinking-indicator')).toBeInTheDocument()
        expect(screen.getByRole('status', { name: 'Thinking' })).toBeInTheDocument()

        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps voice, offline, permission, and idle states ahead of the thinking branch', () => {
        const permissionState: AgentState = {
            requests: {
                permission: { tool: 'Bash', arguments: {}, createdAt: null }
            }
        }
        const view = render(statusBar({ voiceStatus: 'connecting' }))

        expect(screen.getByText('voice.connecting')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()

        view.rerender(statusBar({ active: false }))
        expect(screen.getByText('misc.offline')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()

        view.rerender(statusBar({ agentState: permissionState }))
        expect(screen.getByText('misc.permissionRequired')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()

        view.rerender(statusBar({ thinking: false }))
        expect(screen.getByText('misc.online')).toBeInTheDocument()
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
    })
})
