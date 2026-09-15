import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nContext, I18nProvider } from '@/lib/i18n-context'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'
import { SessionConnectionProvider } from '@/lib/session-connection-context'
import { ToastProvider } from '@/lib/toast-context'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { buildSessionHeaderDetails, CodexSubscriptionLimitsBadge, SessionConnectionRecoveryControl, SessionHeader, SessionTitleDetails } from './SessionHeader'

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
        serviceTier: null
    }
}

describe('mobile layout contract', () => {
    it('shows the native Codex ID separately for a managed Codex session', () => {
        const details = buildSessionHeaderDetails({
            title: 'Task',
            sessionId: 'shapi-session',
            codexSessionId: 'codex-thread'
        }, key => key)

        expect(details).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'session-id', value: 'shapi-session' }),
            expect.objectContaining({ key: 'codex-session-id', value: 'codex-thread' })
        ]))
    })

    it('keeps the quota badge hidden until quota data is available', () => {
        const { container } = render(<I18nProvider><CodexSubscriptionLimitsBadge limits={null} isFetching error={null} /></I18nProvider>)
        expect(container.querySelector('button')).toBeNull()
    })
    it('keeps group in title details and refreshes it without altering the title', () => {
        const onSetGroup = vi.fn()
        const detailsRef = { current: buildSessionHeaderDetails({ title: 'Task', sessionId: 's', group: { id: 'g', name: 'Release', emoji: '🚀' }, onSetGroup }, key => key) }
        const { rerender } = render(<I18nProvider><SessionTitleDetails title="Task" detailsRef={detailsRef} detailsRevision="Release" /></I18nProvider>)
        fireEvent.click(screen.getByTitle('Task'))
        expect(screen.getByRole('button', { name: '🚀 Release' })).toBeInTheDocument()
        detailsRef.current = buildSessionHeaderDetails({ title: 'Task', sessionId: 's', group: { id: 'g', name: 'Review', emoji: '🔎' }, onSetGroup }, key => key)
        rerender(<I18nProvider><SessionTitleDetails title="Task" detailsRef={detailsRef} detailsRevision="Review" /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: '🔎 Review' }))
        expect(onSetGroup).toHaveBeenCalledOnce()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByTitle('Task')).toHaveTextContent('Task')
    })

    it('opens rename from the title details popover', () => {
        const onRename = vi.fn()
        render(<I18nProvider><SessionTitleDetails title="Task" onRename={onRename} /></I18nProvider>)

        fireEvent.click(screen.getByTitle('Task'))
        expect(screen.queryByRole('button', { name: 'Copy Full name' })).toBeNull()
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Session details' })).getByRole('button', { name: 'Rename' }))

        expect(onRename).toHaveBeenCalledOnce()
        expect(screen.queryByRole('dialog', { name: 'Session details' })).toBeNull()
    })

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
        expect(shell).toHaveClass('pointer-events-none', 'z-40', 'isolate')

        const controls = screen.getByTestId('session-header-controls')
        expect(controls).toHaveClass('pointer-events-auto', 'h-11', 'gap-0', 'pl-1', 'pr-5', 'bg-[var(--app-bg)]')
        expect(screen.getByRole('button', { name: 'hapi' })).toHaveClass('px-1')
        expect(screen.getByTestId('session-header-row')).toHaveClass('h-14')
    })
})

describe('SessionHeader back action', () => {
    it('truncates the title inside a shrinkable text element while keeping the full accessible name', () => {
        const title = '这里有什么新功能是我之前 fork 出来就脱离主版本的，需要继续确认完整标题'
        render(
            <I18nProvider>
                <SessionTitleDetails title={title} />
            </I18nProvider>
        )

        const button = screen.getByRole('button', { name: title })
        expect(button).toHaveClass('w-full', 'min-w-0')
        expect(button).toHaveAttribute('title', title)
        expect(button.querySelector('span')).toHaveClass('min-w-0', 'flex-1', 'truncate')
    })

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
        expect(screen.getByTestId(MOBILE_LAYOUT_CONTRACT.header.testId)).toHaveClass('pointer-events-none')
        fireEvent.click(backButton)

        expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('leaves touch arbitration to the browser instead of cancelling a slightly moved tap', () => {
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
        fireEvent.pointerDown(backButton, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 })
        fireEvent.pointerMove(backButton, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 16 })
        fireEvent.pointerUp(backButton, { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 16 })
        expect(onBack).not.toHaveBeenCalled()

        fireEvent.click(backButton)
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

    it('groups title metadata into compact iOS-style sections inside the safe area', () => {
        const onSetGroup = vi.fn()
        render(
            <I18nProvider>
                <SessionTitleDetails
                    title="Investigate production API latency"
                    sessionId="ios-grouped-details"
                    details={[
                        { key: 'title', label: 'Full name', value: 'Investigate production API latency' },
                        { key: 'group', label: 'Group', value: '🚀 Release', onSelect: onSetGroup },
                        { key: 'label', label: 'Label', value: 'Urgent' },
                        { key: 'path', label: 'Project path', value: '/workspace/hapi' },
                        { key: 'last-activity', label: 'Last activity', value: '9/13/2026, 7:30 PM' },
                        { key: 'agent', label: 'Agent', value: 'Codex · Model: gpt-5.6 · Reasoning: high', isAgentInfo: true },
                        { key: 'session-id', label: 'Session ID', value: 'ios-grouped-details' }
                    ]}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Investigate production API latency' }))

        const popover = screen.getByTestId('session-title-details-popover')
        expect(popover).toHaveClass(
            'overflow-y-auto',
            'session-title-popover'
        )
        expect(popover.querySelectorAll('[data-session-detail-group]')).toHaveLength(4)
        expect(screen.getByText('gpt-5.6')).toBeInTheDocument()
        expect(screen.queryByText('ios-grouped-details')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: 'Technical' }))
        expect(screen.getByText('ios-grouped-details')).toBeInTheDocument()
        expect(screen.queryByText('gpt-5.6')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))

        fireEvent.click(screen.getByRole('button', { name: '🚀 Release' }))
        expect(onSetGroup).toHaveBeenCalledOnce()
        expect(screen.queryByTestId('session-title-details-popover')).not.toBeInTheDocument()
    })

    it('opens title details after a cancelled touch falls back to click', () => {
        render(
            <I18nProvider>
                <SessionTitleDetails title="hapi" sessionId="cancelled-title-touch" />
            </I18nProvider>
        )

        const titleButton = screen.getByRole('button', { name: 'hapi' })
        fireEvent.pointerDown(titleButton, { pointerType: 'touch', pointerId: 1 })
        fireEvent.pointerCancel(titleButton)
        fireEvent.click(titleButton)

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
        fireEvent.click(titleButton)
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

    it('closes title details on a second browser click', () => {
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
        fireEvent.click(titleButton)
        expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument()

        fireEvent.click(titleButton)

        expect(screen.queryByRole('dialog', { name: 'Session details' })).not.toBeInTheDocument()
    })

    it('opens and closes the top action menu on consecutive native tap sequences', () => {
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

        const trigger = screen.getByTitle('More actions')
        fireEvent.pointerDown(trigger, { pointerType: 'touch', pointerId: 1 })
        fireEvent.click(trigger)

        expect(screen.getByRole('menu')).toBeInTheDocument()

        // The menu's document-level pointer-down listener closes outside
        // clicks. The trigger must stop only that event so a second tap
        // genuinely toggles the open menu closed rather than reopening it.
        fireEvent.pointerDown(trigger, { pointerType: 'touch', pointerId: 2 })
        fireEvent.click(trigger)

        expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('omits refresh, outline and export from the detail menu', () => {
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
        expect(screen.queryByRole('menuitem', { name: 'Refresh' })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: /outline/i })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: /export/i })).toBeNull()
        expect(onRefresh).not.toHaveBeenCalled()
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

    it('waits three seconds before showing the initial recovery state', () => {
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
                        <SessionConnectionProvider value={{ health: 'recovering', recover: async () => {} }}>
                            <SessionConnectionRecoveryControl />
                        </SessionConnectionProvider>
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        expect(screen.queryByTestId('session-connection-recovery')).not.toBeInTheDocument()
        act(() => vi.advanceTimersByTime(2_999))
        expect(screen.queryByTestId('session-connection-recovery')).not.toBeInTheDocument()
        act(() => vi.advanceTimersByTime(1))

        const button = screen.getByTestId('session-connection-recovery')
        expect(button).toBeDisabled()
        expect(button.querySelector('[data-motion-icon="refresh"]')).not.toBeNull()
        expect(screen.getByTitle('Restoring live updates…')).toBeInTheDocument()
    })

    it('uses the Wi-Fi state icon for a degraded connection', () => {
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

        const signal = screen.getByTestId('session-connection-recovery').querySelector('[data-motion-icon="wifi"]')
        expect(signal).toHaveClass('h-5', 'w-5')
    })

    it('uses the Wi-Fi-off state icon for a disconnected connection', () => {
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

        const icon = screen.getByTestId('session-connection-recovery').querySelector('[data-motion-icon="wifi-off"]')
        expect(icon).toHaveClass('h-5', 'w-5')
    })
})
