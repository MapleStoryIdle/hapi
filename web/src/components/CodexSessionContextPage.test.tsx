import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import { buildReadOnlyCodexBlocks, CodexSessionContextPage } from './CodexSessionContextPage'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function createApi() {
    return {
        getCodexSessionContext: vi.fn(async () => ({
            success: true as const,
            session: {
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                cwd: '/workspace/project',
                modifiedAt: Date.now()
            },
            page: { limit: 50, nextBefore: null, hasMore: false },
            messages: [
                {
                    id: 'codex-local:codex-thread-1:0',
                    createdAt: 0,
                    content: {
                        role: 'user' as const,
                        content: { type: 'text', text: 'Original prompt' }
                    }
                },
                {
                    id: 'codex-local:codex-thread-1:1',
                    createdAt: 1,
                    content: {
                        role: 'agent' as const,
                        content: { type: 'codex', data: { type: 'message', message: 'Original response' } }
                    }
                }
            ]
        })),
        forkCodexSession: vi.fn(async () => ({
            type: 'success' as const,
            sessionId: 'new-hapi-session'
        }))
    } as unknown as ApiClient
}

function renderPage(props: {
    api?: ApiClient
    onBack?: () => void
    onForked?: (sessionId: string) => void
} = {}) {
    const api = props.api ?? createApi()
    const onBack = props.onBack ?? vi.fn()
    const onForked = props.onForked ?? vi.fn()
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    })

    render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <CodexSessionContextPage
                    api={api}
                    sessionId="codex-thread-1"
                    machineId="machine-1"
                    onBack={onBack}
                    onForked={onForked}
                />
            </I18nProvider>
        </QueryClientProvider>
    )

    return { api, onBack, onForked }
}

describe('CodexSessionContextPage', () => {
    it('renders the transcript through the normal conversation thread without a composer', async () => {
        const { api, onBack } = renderPage()

        await waitFor(() => {
            expect(screen.getByText('Original response')).toBeInTheDocument()
        })

        // 验证详情页读取 runner 上的原始上下文，而不会渲染可编辑的会话输入框。
        expect(api.getCodexSessionContext).toHaveBeenCalledWith('codex-thread-1', 'machine-1', { limit: 50 })
        expect(screen.getByText('Original prompt')).toBeInTheDocument()
        expect(screen.queryByRole('textbox')).toBeNull()
        expect(screen.getByRole('button', { name: 'Fork to new session' })).toBeInTheDocument()
        // 正常会话也以 user-text / agent-text 线程节点渲染两端消息。
        expect(screen.getByText('Original prompt').closest('[id^="hapi-message-user-text:"]')).not.toBeNull()
        expect(screen.getByText('Original response').closest('[id^="hapi-message-agent-text:"]')).not.toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
        expect(onBack).toHaveBeenCalledTimes(1)
    })


    it('centers the loading indicator while the first context page is loading', () => {
        const api = createApi()
        let resolveContext: (() => void) | undefined
        const getContext = api.getCodexSessionContext as ReturnType<typeof vi.fn>
        getContext.mockImplementationOnce(() => new Promise((resolve) => {
            resolveContext = () => resolve({
                success: true,
                session: { id: 'codex-thread-1', title: 'Recent Codex task', cwd: '/workspace/project', modifiedAt: Date.now() },
                messages: [],
                page: { limit: 50, nextBefore: null, hasMore: false }
            })
        }))

        renderPage({ api })

        expect(screen.getByTestId('codex-session-context-loading')).toHaveClass('items-center', 'justify-center')
        resolveContext?.()
    })

    it('loads the previous context page when scrolling above the transcript', async () => {
        const clock = vi.spyOn(Date, 'now')
        clock.mockReturnValue(0)
        const api = {
            getCodexSessionContext: vi.fn(async (_sessionId: string, _machineId: string, options: { before?: number; limit?: number }) => (
                options.before === 1
                    ? {
                        success: true as const,
                        session: { id: 'codex-thread-1', title: 'Recent Codex task', cwd: '/workspace/project', modifiedAt: 1 },
                        messages: [{
                            id: 'codex-local:codex-thread-1:0',
                            createdAt: 0,
                            content: { role: 'user' as const, content: { type: 'text', text: 'Older prompt' } }
                        }],
                        page: { limit: 50, nextBefore: null, hasMore: false }
                    }
                    : {
                        success: true as const,
                        session: { id: 'codex-thread-1', title: 'Recent Codex task', cwd: '/workspace/project', modifiedAt: 1 },
                        messages: [{
                            id: 'codex-local:codex-thread-1:1',
                            createdAt: 1,
                            content: { role: 'agent' as const, content: { type: 'codex', data: { type: 'message', message: 'Newest response' } } }
                        }],
                        page: { limit: 50, nextBefore: 1, hasMore: true }
                    }
            )),
            forkCodexSession: vi.fn()
        } as unknown as ApiClient

        renderPage({ api })
        await screen.findByText('Newest response')
        clock.mockReturnValue(2_000)

        const viewport = document.querySelector<HTMLElement>('.app-scroll-y')
        expect(viewport).not.toBeNull()
        Object.defineProperty(viewport!, 'scrollTop', { configurable: true, value: 0, writable: true })
        fireEvent.wheel(viewport!, { deltaY: -20 })

        await waitFor(() => {
            expect(api.getCodexSessionContext).toHaveBeenCalledWith('codex-thread-1', 'machine-1', { limit: 50, before: 1 })
            expect(screen.getByText('Older prompt')).toBeInTheDocument()
        })
    })

    it('forks the read-only Codex transcript into a normal HAPI session', async () => {
        const { api, onForked } = renderPage()

        await screen.findByText('Original response')
        fireEvent.click(screen.getByRole('button', { name: 'Fork to new session' }))

        await waitFor(() => {
            expect(api.forkCodexSession).toHaveBeenCalledWith('codex-thread-1', { machineId: 'machine-1' })
            expect(onForked).toHaveBeenCalledWith('new-hapi-session')
        })
    })

    it('normalizes local Codex messages through the normal chat reducer', () => {
        const blocks = buildReadOnlyCodexBlocks([
            {
                id: 'codex-local:1:0',
                createdAt: 0,
                content: { role: 'user', content: { type: 'text', text: 'Visible user message' } }
            },
            {
                id: 'codex-local:1:1',
                createdAt: 1,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'tool-call', callId: 'call-1', name: 'Read', input: { file_path: 'README.md' } }
                    }
                }
            },
            {
                id: 'codex-local:1:2',
                createdAt: 2,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: { type: 'tool-call-result', callId: 'call-1', output: 'contents' }
                    }
                }
            },
            {
                id: 'codex-local:1:3',
                createdAt: 3,
                content: {
                    role: 'agent',
                    content: { type: 'codex', data: { type: 'reasoning', message: 'Inspecting the file' } }
                }
            }
        ])

        expect(blocks).toMatchObject([
            { kind: 'user-text', text: 'Visible user message' },
            { kind: 'tool-call', tool: { id: 'call-1', name: 'Read', result: 'contents' } },
            { kind: 'agent-reasoning', text: 'Inspecting the file' }
        ])
        expect(blocks).toHaveLength(3)
    })

    it('renders local automation heartbeats as status events', () => {
        const blocks = buildReadOnlyCodexBlocks([
            {
                id: 'codex-local:1:0',
                createdAt: 0,
                content: {
                    role: 'agent',
                    content: {
                        type: 'codex',
                        data: {
                            type: 'message',
                            message: '<heartbeat> <automation_id>bug</automation_id> <decision>DONT_NOTIFY</decision> <message>No new or updated bugs require action.</message> </heartbeat>'
                        }
                    }
                }
            },
            {
                id: 'codex-local:1:1',
                createdAt: 1,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: '<heartbeat> <automation_id>bug</automation_id> <current_time_iso>2026-08-15T00:54:47.781Z</current_time_iso> <instructions>自动改bug</instructions> </heartbeat>'
                    }
                }
            }
        ])

        expect(blocks).toMatchObject([
            {
                kind: 'agent-event',
                event: {
                    type: 'automation-heartbeat',
                    automationId: 'bug',
                    decision: 'DONT_NOTIFY',
                    message: 'No new or updated bugs require action.'
                }
            },
            {
                kind: 'agent-event',
                event: {
                    type: 'automation-heartbeat',
                    automationId: 'bug',
                    message: '自动改bug',
                    currentTimeIso: '2026-08-15T00:54:47.781Z'
                }
            }
        ])
    })

    it('opens the read-only thread at its latest message', async () => {
        const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
        const setScrollTop = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
            configurable: true,
            get: () => 0,
            set(value: number) {
                setScrollTop(value)
            }
        })

        try {
            renderPage()

            await screen.findByText('Original response')
            await waitFor(() => {
                expect(setScrollTop).toHaveBeenCalled()
            })
        } finally {
            if (originalScrollTop) {
                Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop)
            } else {
                delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop
            }
        }
    })
})
