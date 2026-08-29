import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nContext, I18nProvider } from '@/lib/i18n-context'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'
import { SessionConnectionProvider } from '@/lib/session-connection-context'
import { ToastProvider } from '@/lib/toast-context'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { SessionConnectionRecoveryControl, SessionHeader, SessionTitleDetails } from './SessionHeader'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-lang')
    vi.useRealTimers()
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
        clientX: { value: 0 },
        clientY: { value: 0 },
        pointerType: { value: 'touch' },
        pointerId: { value: 1 },
    })
    fireEvent(target, event)
}

function fireWebKitTouchPointerDown(target: Element) {
    const event = createEvent.pointerDown(target, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
        button: { value: -1 },
        clientX: { value: 0 },
        clientY: { value: 0 },
        pointerType: { value: 'touch' },
        pointerId: { value: 1 },
    })
    fireEvent(target, event)
}

function fireWebKitTouchPointerMove(target: Element, clientY: number) {
    const event = createEvent.pointerMove(target, { bubbles: true, cancelable: true, clientY })
    Object.defineProperties(event, {
        button: { value: -1 },
        clientX: { value: 0 },
        clientY: { value: clientY },
        pointerType: { value: 'touch' },
        pointerId: { value: 1 },
    })
    fireEvent(target, event)
}

function fireWebKitTouchEnd(target: Element) {
    const event = createEvent.touchEnd(target, { bubbles: true, cancelable: true })
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
        expect(controls).toHaveClass('pointer-events-auto', 'h-11', 'gap-0', 'bg-[var(--app-bg)]')
        expect(screen.getByRole('button', { name: 'hapi' })).toHaveClass('pl-1', 'pr-2')
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
        fireEvent.click(backButton, { detail: 1 })

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

    it('keeps the click fallback available after a cancelled standalone touch', () => {
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
        fireWebKitTouchPointerDown(backButton)
        fireEvent.pointerCancel(backButton)
        fireEvent.click(backButton, { detail: 1 })

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('uses touch-end when a busy standalone WebKit view loses pointer-up', () => {
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
        fireWebKitTouchPointerDown(backButton)
        fireWebKitTouchEnd(backButton)
        fireEvent.click(backButton, { detail: 1 })

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('runs one action when WebKit dispatches both pointer-up and touch-end', () => {
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
        fireWebKitTouchPointerDown(backButton)
        fireWebKitTouchPointerUp(backButton)
        fireWebKitTouchEnd(backButton)
        fireEvent.click(backButton, { detail: 1 })

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('does not treat a scrolling gesture as a header tap', () => {
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
        fireWebKitTouchPointerDown(backButton)
        fireWebKitTouchPointerMove(backButton, 16)
        fireWebKitTouchPointerUp(backButton)
        fireWebKitTouchEnd(backButton)
        fireEvent.click(backButton, { detail: 1 })

        expect(onBack).not.toHaveBeenCalled()
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
        expect(titleButton).toHaveClass('pointer-events-auto', 'touch-manipulation', 'h-11')
        fireEvent.click(titleButton)

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
    })

    it('reads the newest stable detail snapshot when the title popover opens', () => {
        const detailsRef = {
            current: [{ key: 'path', label: 'Project path', value: '/workspace/old' }]
        }

        render(
            <I18nProvider>
                <SessionTitleDetails
                    title="hapi"
                    sessionId="title-details-stable-ref"
                    detailsRef={detailsRef}
                />
            </I18nProvider>
        )

        // A live session patch updates the ref but intentionally does not
        // re-render the title control before a direct user action.
        detailsRef.current = [{ key: 'path', label: 'Project path', value: '/workspace/latest' }]
        fireEvent.click(screen.getByRole('button', { name: 'hapi' }))

        expect(screen.getByText('/workspace/latest')).toBeInTheDocument()
        expect(screen.queryByText('/workspace/old')).not.toBeInTheDocument()
    })

    it('opens title details after a cancelled touch falls back to click', () => {
        render(
            <I18nProvider>
                <SessionTitleDetails title="hapi" sessionId="cancelled-title-touch" />
            </I18nProvider>
        )

        const titleButton = screen.getByRole('button', { name: 'hapi' })
        fireWebKitTouchPointerDown(titleButton)
        fireEvent.pointerCancel(titleButton)
        fireEvent.click(titleButton, { detail: 1 })

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
    })

    it('does not re-render the title control for an unrelated streaming refresh', () => {
        let detailReads = 0
        const detailsRef = {
            get current() {
                detailReads += 1
                return [{ key: 'path', label: 'Project path', value: '/workspace/hapi' }]
            }
        } as { current: readonly { key: string; label: string; value: string }[] }
        const TitleHarness = (props: { streamRevision: number }) => (
            <div data-stream-revision={props.streamRevision}>
                <SessionTitleDetails
                    title="hapi"
                    sessionId="title-details-memo-test"
                    detailsRef={detailsRef}
                    detailsRevision="stable-title-details"
                />
            </div>
        )
        const translations = {
            t: (key: string) => key,
            locale: 'en' as const,
            setLocale: () => {}
        }
        const I18nWrapper = (props: { children: ReactNode }) => (
            <I18nContext.Provider value={translations}>{props.children}</I18nContext.Provider>
        )
        const { rerender } = render(<TitleHarness streamRevision={0} />, { wrapper: I18nWrapper })
        const readsAfterMount = detailReads

        // Equivalent to `updatedAt` changing in the parent SessionHeader:
        // the surrounding header renders, but title-detail inputs do not.
        rerender(<TitleHarness streamRevision={1} />)

        expect(detailReads).toBe(readsAfterMount)
    })

    it('opens title details on one touch without closing it again on the follow-up click', () => {
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
        fireWebKitTouchPointerDown(titleButton)
        fireWebKitTouchPointerUp(titleButton)
        fireEvent.click(titleButton, { detail: 1 })

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
    })

    it('keeps title details open while streaming session state refreshes around it', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const session = createSession()
        const renderHeader = (nextSession: Session) => (
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={nextSession}
                            api={null}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )
        const { rerender } = render(renderHeader(session))

        const titleButton = screen.getByRole('button', { name: 'hapi' })
        fireWebKitTouchPointerDown(titleButton)
        fireWebKitTouchPointerUp(titleButton)
        fireEvent.click(titleButton, { detail: 1 })
        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()

        rerender(renderHeader({
            ...session,
            updatedAt: 1_700_000_000_000,
            thinking: true,
            thinkingAt: 1_700_000_000_000
        }))

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'hapi' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('closes title details on a second touch of the same title button', () => {
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
        fireWebKitTouchPointerDown(titleButton)
        fireWebKitTouchPointerUp(titleButton)
        fireEvent.click(titleButton, { detail: 1 })
        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()

        fireWebKitTouchPointerDown(titleButton)
        fireWebKitTouchPointerUp(titleButton)
        fireEvent.click(titleButton, { detail: 1 })

        expect(screen.queryByRole('dialog', { name: 'Session details' })).not.toBeInTheDocument()
    })

    it('keeps title details open when a delayed compatibility click arrives after a busy frame', () => {
        vi.useFakeTimers()
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
        vi.advanceTimersByTime(750)
        fireEvent.click(titleButton, { detail: 1 })

        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()
    })

    it('opens the top action menu from the touch pointer-up fallback', () => {
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

        fireWebKitTouchPointerUp(screen.getByTitle('More actions'))

        expect(screen.getByRole('menu')).toBeInTheDocument()
    })

    it('exposes the same refresh action when the detail page supplies one', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const onRefresh = vi.fn()

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={() => {}}
                            onRefresh={onRefresh}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByTitle('More actions'))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh' }))

        expect(onRefresh).toHaveBeenCalledTimes(1)
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

describe('SessionHeader connection recovery', () => {
    it('hides the connection control while live updates are healthy', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const recover = vi.fn(async () => {})

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionConnectionProvider value={{ health: 'connected', recover }}>
                            <SessionConnectionRecoveryControl />
                        </SessionConnectionProvider>
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        expect(screen.queryByTestId('session-connection-recovery')).not.toBeInTheDocument()
        expect(recover).not.toHaveBeenCalled()
    })

    it('shows the abnormal connection control in the former local-preview position and lets the operator recover', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })
        const recover = vi.fn(async () => {})

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionConnectionProvider value={{ health: 'degraded', recover }}>
                            <SessionConnectionRecoveryControl />
                        </SessionConnectionProvider>
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const button = screen.getByTestId('session-connection-recovery')
        expect(button).toHaveAttribute('title', 'Using backup live updates · Reconnect and refresh')
        expect(screen.getByTestId('session-connection-recovery-float')).toHaveClass(
            'fixed',
            'top-[calc(var(--app-safe-area-top)+4.75rem)]',
            'z-30'
        )
        fireEvent.click(button)

        expect(recover).toHaveBeenCalledTimes(1)
    })

    it('shows a non-clickable recovery state while the refresh is running', () => {
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
                        <SessionConnectionProvider value={{ health: 'recovering', recover: async () => {} }}>
                            <SessionConnectionRecoveryControl />
                        </SessionConnectionProvider>
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        expect(screen.getByTestId('session-connection-recovery')).toBeDisabled()
        expect(screen.getByTitle('Restoring live updates…')).toBeInTheDocument()
    })

    it('uses the intermittent-contact icon for a degraded connection', () => {
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
                        <SessionConnectionProvider value={{ health: 'degraded', recover: async () => {} }}>
                            <SessionConnectionRecoveryControl />
                        </SessionConnectionProvider>
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const signal = screen.getByTestId('session-connection-recovery').querySelector('svg')
        expect(signal).toHaveClass('lucide-plug-zap', 'h-5', 'w-5')
    })

    it('uses the unplug icon for a disconnected connection', () => {
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
                        <SessionConnectionProvider value={{ health: 'offline', recover: async () => {} }}>
                            <SessionConnectionRecoveryControl />
                        </SessionConnectionProvider>
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const icon = screen.getByTestId('session-connection-recovery').querySelector('svg')
        expect(icon).toHaveClass('lucide-unplug', 'h-5', 'w-5')
    })
})
