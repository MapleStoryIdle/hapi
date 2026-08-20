import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'
import { ToastProvider } from '@/lib/toast-context'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { SessionHeader } from './SessionHeader'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-lang')
})

function createSession(): Session {
    return {
        id: 'mobile-layout-contract-session',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: '/workspace/hapi',
            host: 'localhost',
            flavor: 'claude'
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        remoteServerId: null
    }
}

function fireWebKitTouchPointerUp(target: Element) {
    const event = createEvent.pointerUp(target, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
        button: { value: -1 },
        pointerType: { value: 'touch' },
    })
    fireEvent(target, event)
}

describe('mobile layout contract', () => {
    it('keeps the full title-bar shell transparent without changing the control surface', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const shell = screen.getByTestId(MOBILE_LAYOUT_CONTRACT.header.testId)
        expect(shell).toHaveAttribute('data-mobile-layout-contract', MOBILE_LAYOUT_CONTRACT.header.state)
        expect(shell.style.backgroundColor).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backgroundVariable})`)
        expect(shell.style.backdropFilter).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backdropFilterVariable})`)
        expect(shell).toHaveClass('pointer-events-auto', 'z-40', 'isolate', 'touch-manipulation')

        const controls = screen.getByTestId('session-header-controls')
        expect(controls).toHaveClass('pointer-events-auto', 'h-11', 'bg-[var(--app-bg)]')
        expect(screen.getByTestId('session-header-row')).toHaveClass('h-14')
    })
})

describe('SessionHeader back action', () => {
    it('uses the explicit back callback from the floating header control', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const onBack = vi.fn()

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={onBack}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const backButton = screen.getByTestId('session-header-back')
        expect(backButton).toHaveClass('pointer-events-auto', 'touch-manipulation', 'h-11', 'w-11')
        expect(screen.getByTestId(MOBILE_LAYOUT_CONTRACT.header.testId)).not.toHaveClass('pointer-events-none')
        fireEvent.click(backButton)

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('uses pointer-up as the iOS PWA fallback without double-navigating on its follow-up click', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const onBack = vi.fn()

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={onBack}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const backButton = screen.getByTestId('session-header-back')
        fireEvent.pointerUp(backButton, { button: 0, pointerType: 'touch' })
        fireEvent.click(backButton)

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('accepts a standalone WebKit touch pointer-up without a mouse button value', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const onBack = vi.fn()

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={onBack}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireWebKitTouchPointerUp(screen.getByTestId('session-header-back'))

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('keeps the title details control in the explicit touch hit-test layer', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const titleButton = screen.getByRole('button', { name: 'hapi' })
        expect(titleButton).toHaveClass('pointer-events-auto', 'touch-manipulation')
        fireEvent.click(titleButton)

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
    })

    it('uses pointer-up for title details without closing it again on the follow-up click', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const titleButton = screen.getByRole('button', { name: 'hapi' })
        fireWebKitTouchPointerUp(titleButton)
        fireEvent.click(titleButton)

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
    })

    it('uses the selected locale for session detail labels', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'hapi' }))

        expect(screen.getByRole('dialog', { name: '会话详情' })).toBeInTheDocument()
        expect(screen.getByText('完整名称')).toBeInTheDocument()
        expect(screen.getByText('项目路径')).toBeInTheDocument()
    })
})

describe('SessionHeader details', () => {
    it('does not fetch or show the branch in the title details popover', () => {
        const getGitStatus = vi.fn()
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={{ getGitStatus } as unknown as ApiClient}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'hapi' }))

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
        expect(screen.queryByText('Current branch')).not.toBeInTheDocument()
        expect(getGitStatus).not.toHaveBeenCalled()
    })
})
