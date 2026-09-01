import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { I18nProvider } from '@/lib/i18n-context'

function makeToolBlock(id: string, name: string, input: unknown = {}, toolOverrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: { content: 'done' },
            permission: undefined,
            ...toolOverrides,
        },
        children: [],
    }
}

function makeGroup(overrides: Partial<ToolGroupBlock> = {}): ToolGroupBlock {
    const tools = overrides.tools ?? [
        makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
        makeToolBlock('bash-1', 'Bash', { command: 'bun test' })
    ]
    return {
        kind: 'tool-group',
        id: 'tool-group:read-1',
        createdAt: 1,
        invokedAt: null,
        firstToolId: tools[0].id,
        lastToolId: tools[tools.length - 1].id,
        tools,
        defaultOpen: false,
        historyState: 'complete',
        needsOlderHistory: false,
        summary: {
            totalTools: tools.length,
            countsByKind: {
                read: 1,
                search: 0,
                command: 1,
                mutation: 0,
                web: 0,
                other: 0,
            },
            fileTargets: ['repo/src/a.ts'],
            commandTargets: ['bun test'],
            searchTargets: [],
            urlTargets: [],
            otherTargets: [],
            errorCount: 0,
            runningCount: 0,
            pendingCount: 0,
        },
        ...overrides,
    }
}

function renderCard(block: ToolGroupBlock, options?: {
    loadOlder?: () => Promise<boolean>
    hasMore?: boolean
    isLoadingMore?: boolean
    terminalToolDisplayMode?: TerminalToolDisplayMode
}) {
    const loadOlderMessagesPreservingScroll = options?.loadOlder ?? vi.fn(async () => false)
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: {} as never,
                sessionId: 'session-1',
                metadata: { path: 'repo', host: 'local' },
                terminalToolDisplayMode: options?.terminalToolDisplayMode ?? 'detailed',
                disabled: false,
                onRefresh: vi.fn(),
                hasMoreMessages: options?.hasMore ?? false,
                isLoadingMoreMessages: options?.isLoadingMore ?? false,
                loadOlderMessagesPreservingScroll,
            }}>
                <ToolGroupCard block={block} metadata={{ path: 'repo', host: 'local' }} />
            </HappyChatProvider>
        </I18nProvider>
    )
}

describe('ToolGroupCard', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders a collapsed target-first header', () => {
        const view = renderCard(makeGroup())

        expect(screen.getByRole('button', { name: /inspect project files/i })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText('Run 1 · Read 1')).toBeInTheDocument()
        expect(screen.getByText('2 actions')).toBeInTheDocument()
        expect(screen.queryByText('src/a.ts')).not.toBeInTheDocument()
        expect(screen.queryByText('bun test')).not.toBeInTheDocument()

        expect(view.container.innerHTML).toContain('bg-[var(--app-tool-group-bg)]')
    })

    it('uses a transparent compact row for every forced tool group and retains an MCP title', () => {
        const mcp = makeToolBlock('mcp-1', 'mcp__node_repl__js', {
            title: '查看本地会话',
            code: 'nodeRepl.write("ok")'
        })
        const view = renderCard(makeGroup({
            tools: [mcp],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 0,
                    mutation: 0,
                    web: 0,
                    other: 1,
                },
                fileTargets: [],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: ['mcp__node_repl__js'],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
            forceCompact: true
        }))

        const toggle = within(view.container).getByRole('button', { name: /查看本地会话 0s/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(view.container.innerHTML).not.toContain('bg-[var(--app-tool-group-bg)]')

        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('查看本地会话')).toBeInTheDocument()
    })

    it('keeps forced compact activity collapsed while a tool is running', () => {
        const startedAt = Date.now() - 3_000
        const running = makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
            state: 'running',
            createdAt: startedAt,
            startedAt,
            completedAt: null,
        })
        const view = renderCard(makeGroup({
            tools: [running],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 1,
                pendingCount: 0,
            },
            forceCompact: true
        }))

        const toggle = within(view.container).getByRole('button')
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('bun test')).not.toBeInTheDocument()

        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('bun test')).toBeInTheDocument()
    })

    it('expands to show compact rows and opens a detail dialog per row', async () => {
        const view = renderCard(makeGroup())
        const groupToggle = within(view.container).getByRole('button', { name: /inspect project files/i })

        expect(view.container.querySelector('svg[data-state="closed"]')).toBeInTheDocument()
        fireEvent.click(groupToggle)
        expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
        expect(view.container.querySelector('svg[data-state="open"]')).toBeInTheDocument()
        expect(screen.getByText('2 actions')).toBeInTheDocument()
        expect(screen.getByText('src/a.ts')).toBeInTheDocument()
        expect(screen.getByText('Terminal')).toBeInTheDocument()
        expect(screen.getByText('bun test')).toBeInTheDocument()

        const firstRowButton = within(view.container)
            .getAllByRole('button')
            .find((button) => button !== groupToggle)

        expect(firstRowButton).toBeDefined()
        fireEvent.click(firstRowButton!)

        await waitFor(() => {
            expect(screen.getByRole('dialog')).toBeInTheDocument()
        })
        const dialog = screen.getByRole('dialog')
        expect(screen.getAllByText('src/a.ts')[0]).toBeInTheDocument()
        expect(within(dialog).getAllByText('Input').length).toBeGreaterThan(0)
        expect(within(dialog).getAllByText('Result').length).toBeGreaterThan(0)
    })

    it('opens terminal command rows in the command modal', async () => {
        const view = renderCard(makeGroup())
        const groupToggle = within(view.container).getByRole('button', { name: /inspect project files/i })

        fireEvent.click(groupToggle)

        const commandRow = Array.from(view.container.querySelectorAll<HTMLButtonElement>('button'))
            .find((button) => button.textContent?.includes('Terminal') && button.textContent.includes('bun test'))
        expect(commandRow).toBeDefined()

        fireEvent.click(commandRow!)

        await waitFor(() => {
            expect(screen.getByTestId('terminal-execution-drawer')).toBeInTheDocument()
        })
        const drawer = screen.getByRole('dialog')
        expect(drawer).toHaveAttribute('data-testid', 'terminal-execution-drawer')
        expect(within(drawer).getAllByText('bun test').length).toBeGreaterThan(0)
    })

    it('uses a neutral header for all-generic tool groups without duplicate counters', () => {
        const tools = Array.from({ length: 25 }, (_, index) => makeToolBlock(`tool-${index + 1}`, 'Tool', { name: `Tool ${index + 1}` }))
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: tools.length,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 0,
                    mutation: 0,
                    web: 0,
                    other: tools.length,
                },
                fileTargets: [],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: tools.map((tool) => tool.tool.name),
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }))

        expect(screen.getByRole('button', { name: /tool activity/i })).toBeInTheDocument()
        expect(screen.getByText('25 actions')).toBeInTheDocument()
        expect(screen.queryByText('Use tool +24')).not.toBeInTheDocument()
        expect(screen.queryByText('Tool 25')).not.toBeInTheDocument()

        fireEvent.click(within(view.container).getByRole('button', { name: /tool activity/i }))

        expect(screen.getAllByText('Tool').length).toBeGreaterThan(0)
        expect(screen.getByText('Tool 1')).toBeInTheDocument()
    })

    it('renders completed compact groups with their aggregate duration', () => {
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                createdAt: 0,
                startedAt: 0,
                completedAt: 125_000,
            }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun run build' }, {
                createdAt: 126_000,
                startedAt: 126_000,
                completedAt: 205_000,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: tools.length,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 2,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test', 'bun run build'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container).getByRole('button', { name: /processed 3m 25s/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(toggle).toHaveClass('min-h-9', 'text-[13px]')
        expect(screen.queryByText('Ran')).not.toBeInTheDocument()

        fireEvent.click(toggle)

        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('bun test')).toBeInTheDocument()
        expect(screen.getByText('bun run build')).toBeInTheDocument()
    })

    it('shows a failed terminal status inline without a result or duration', () => {
        const terminal = makeToolBlock('bash-1', 'CodexBash', {
            command: '/bin/zsh -lc "ls /definitely-not-exists"',
            cwd: '/workspace/hapi'
        }, {
            startedAt: 0,
            completedAt: 1_250,
            result: {
                exit_code: 1,
                status: 'failed'
            }
        })
        const view = renderCard(makeGroup({
            tools: [terminal],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['/bin/zsh -lc "ls /definitely-not-exists"'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 1,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        fireEvent.click(within(view.container).getByRole('button'))

        expect(within(view.container).queryByText('Failed')).not.toBeInTheDocument()
        expect(within(view.container).getByRole('button', { name: /ls \/definitely-not-exists 1s/i })).toHaveAttribute('aria-expanded', 'true')
        expect(within(view.container).queryByText('1.3s')).not.toBeInTheDocument()
        expect(within(view.container).queryByText('exit 1')).not.toBeInTheDocument()
        expect(within(view.container).queryByText('The agent did not return terminal output for this command.')).not.toBeInTheDocument()
        const terminalRow = within(view.container)
            .getAllByRole('button', { name: /^ls \/definitely-not-exists$/i })
            .find((button) => !button.hasAttribute('aria-expanded'))
        expect(terminalRow).toHaveClass('flex', 'items-center')
        expect(terminalRow?.firstElementChild).toHaveClass('text-red-600')
    })

    it('uses a safe runtime title when a compact terminal row runs inline code', () => {
        const terminal = makeToolBlock('bash-unknown', 'CodexBash', {
            command: '/bin/zsh -lc "node -e \'process.exit(0)\'"'
        })
        const view = renderCard(makeGroup({
            tools: [terminal],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container).getByRole('button', { name: /run node\.js 0s/i })
        fireEvent.click(toggle)

        expect(within(view.container).getByText('Run Node.js')).toBeInTheDocument()
        expect(within(view.container).queryByText(/node -e/i)).not.toBeInTheDocument()
    })

    it('shows one requested file directly and collapses batch read targets', () => {
        const singleRead = makeToolBlock('single-read', 'CodexBash', {
            command: "/bin/zsh -lc \"sed -n '12,80p' web/src/App.tsx\""
        })
        const singleView = renderCard(makeGroup({
            tools: [singleRead],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 1,
                    search: 0,
                    command: 0,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: ['web/src/App.tsx'],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const singleToggle = within(singleView.container).getByRole('button', { name: /read file · App\.tsx · L12–80 0s/i })
        fireEvent.click(singleToggle)

        expect(within(singleView.container).getByText('Read file')).toBeInTheDocument()
        expect(within(singleView.container).getByText('App.tsx · L12–80')).toBeInTheDocument()
        expect(singleView.container.querySelector('[data-tool-group-timeline]')).toHaveClass('left-0')
        const singleRow = within(singleView.container)
            .getAllByRole('button', { name: /read file App\.tsx/i })
            .find((button) => !button.hasAttribute('aria-expanded'))
        expect(singleRow).toHaveClass('-ml-[7px]', 'px-0')

        const batchRead = makeToolBlock('batch-read', 'CodexBash', {
            command: "/bin/zsh -lc \"cat web/src/a.ts; sed -n '1,20p' web/src/b.ts\""
        })
        const batchView = renderCard(makeGroup({
            id: 'tool-group:batch-read',
            tools: [batchRead],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 1,
                    search: 0,
                    command: 0,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: ['web/src/a.ts', 'web/src/b.ts'],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const batchToggle = within(batchView.container).getByRole('button', { name: /read a batch of files 0s/i })
        fireEvent.click(batchToggle)

        expect(within(batchView.container).getByText('Read a batch of files')).toBeInTheDocument()
        expect(within(batchView.container).queryByText('web/src/a.ts')).not.toBeInTheDocument()
        expect(within(batchView.container).queryByText('web/src/b.ts · L1–20')).not.toBeInTheDocument()
    })

    it('uses action-specific compact titles for single tool groups', () => {
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                createdAt: 0,
                startedAt: 0,
                completedAt: 2_000,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        expect(within(view.container).getByRole('button', { name: /bun test 2s/i })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('Processed 2s')).not.toBeInTheDocument()
    })

    it('shows duration only in the compact group header', () => {
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                createdAt: 0,
                startedAt: 0,
                completedAt: 6_000,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container).getByRole('button', { name: /bun test 6s/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')

        fireEvent.click(toggle)

        const terminalRow = within(view.container)
            .getAllByRole('button', { name: /^bun test$/i })
            .find((button) => !button.hasAttribute('aria-expanded'))
        expect(terminalRow).not.toHaveTextContent('6s')
    })

    it('prefers persisted CLI duration for a completed compact tool group', () => {
        const tool = makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
            startedAt: 1,
            completedAt: 2,
        })
        tool.tool.durationMs = 9_000
        const view = renderCard(makeGroup({
            tools: [tool],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        expect(within(view.container).getByRole('button', { name: /bun test 9s/i })).toHaveAttribute('aria-expanded', 'false')
    })

    it('uses action-specific processing titles for active single tool groups', () => {
        const startedAt = Date.now() - 8_000
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                state: 'running',
                createdAt: startedAt,
                startedAt,
                completedAt: null,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 1,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container)
            .getAllByRole('button', { name: /bun test \d+s/i })
            .find((button) => button.hasAttribute('aria-expanded'))
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.queryByText(/Processing \d+s/i)).not.toBeInTheDocument()
    })

    it('uses the latest active action instead of Processing for aggregated groups', () => {
        const now = Date.now()
        const tools = [
            makeToolBlock('read-1', 'Read', { file_path: 'src/old.ts' }, {
                createdAt: now - 10_000,
                startedAt: now - 10_000,
                completedAt: now - 8_000,
            }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                state: 'running',
                createdAt: now - 4_000,
                startedAt: now - 4_000,
                completedAt: null,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            forceGenericCompactTitle: true,
            summary: {
                totalTools: 2,
                countsByKind: {
                    read: 1,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: ['src/old.ts'],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 1,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container)
            .getAllByRole('button', { name: /bun test \d+s/i })
            .find((button) => button.hasAttribute('aria-expanded'))
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.queryByText(/Processing \d+s/i)).not.toBeInTheDocument()
    })

    it('treats running tools as active even when summary counts are stale', () => {
        const startedAt = Date.now() - 8_000
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                state: 'running',
                createdAt: startedAt,
                startedAt,
                completedAt: null,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container)
            .getAllByRole('button', { name: /bun test \d+s/i })
            .find((button) => button.hasAttribute('aria-expanded'))
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.queryByText(/Processing \d+s/i)).not.toBeInTheDocument()
    })

    it('uses the raw command when a mutation has no parsed file target', () => {
        const view = renderCard(makeGroup({
            tools: [makeToolBlock('patch-1', 'Bash', { command: 'apply_patch <<PATCH\n*** Begin Patch' })],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 0,
                    mutation: 1,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        expect(within(view.container).getByRole('button', { name: /apply_patch 0s/i })).toBeInTheDocument()
    })

    it('uses the parsed file target for a mutation when available', () => {
        const view = renderCard(makeGroup({
            tools: [makeToolBlock('edit-1', 'Edit', { file_path: 'src/example.ts' })],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 0,
                    mutation: 1,
                    web: 0,
                    other: 0,
                },
                fileTargets: ['src/example.ts'],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        expect(within(view.container).getByRole('button', { name: /modified src\/example\.ts 0s/i })).toBeInTheDocument()
    })

    it('uses a generic compact title and renders detail blocks for result detail groups', () => {
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                createdAt: 0,
                startedAt: 0,
                completedAt: 2_000,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            forceGenericCompactTitle: true,
            detailBlocks: [{
                kind: 'agent-text',
                id: 'detail-1',
                localId: null,
                createdAt: 1,
                text: 'Collected process notes',
            }],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container).getByRole('button', { name: /processed 2s/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('Ran 2s')).not.toBeInTheDocument()

        fireEvent.click(toggle)

        const processNote = screen.getByText('Collected process notes')
        expect(processNote).toBeInTheDocument()
        expect(processNote.className).not.toContain('bg-[var(--app-subtle-bg)]')
    })

    it('labels compact result detail groups when the process text names a skill', () => {
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                createdAt: 0,
                startedAt: 0,
                completedAt: 2_000,
            }),
        ]
        const view = renderCard(makeGroup({
            tools,
            forceGenericCompactTitle: true,
            detailBlocks: [{
                kind: 'agent-text',
                id: 'detail-1',
                localId: null,
                createdAt: 1,
                text: '我会用 imagegen：这是纯效果图预览，不改代码。',
            }],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        expect(within(view.container).getByRole('button', { name: /used imagegen 2s/i })).toBeInTheDocument()
        expect(screen.queryByText(/Processed 2s/i)).not.toBeInTheDocument()
    })

    it('renders result detail blocks in chronological order', () => {
        const tool = makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
            createdAt: 2,
            startedAt: 2,
            completedAt: 3_000,
        })
        const view = renderCard(makeGroup({
            tools: [tool],
            forceGenericCompactTitle: true,
            detailBlocks: [
                {
                    kind: 'agent-text',
                    id: 'detail-1',
                    localId: null,
                    createdAt: 1,
                    text: 'First process note',
                },
                tool,
                {
                    kind: 'agent-text',
                    id: 'detail-2',
                    localId: null,
                    createdAt: 4,
                    text: 'Second process note',
                }
            ],
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 0,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: [],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        fireEvent.click(within(view.container).getByRole('button', { name: /processed 2s/i }))

        const text = view.container.textContent ?? ''
        expect(text.indexOf('First process note')).toBeGreaterThanOrEqual(0)
        expect(text.indexOf('bun test')).toBeGreaterThan(text.indexOf('First process note'))
        expect(text.indexOf('Second process note')).toBeGreaterThan(text.indexOf('bun test'))
    })

    it('lets users collapse compact groups while tools are still active', () => {
        const startedAt = Date.now() - 8_000
        const tools = [
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                state: 'running',
                createdAt: startedAt,
                startedAt,
                completedAt: null,
            }),
            makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }),
        ]
        const view = renderCard(makeGroup({
            tools,
            summary: {
                totalTools: tools.length,
                countsByKind: {
                    read: 1,
                    search: 0,
                    command: 1,
                    mutation: 0,
                    web: 0,
                    other: 0,
                },
                fileTargets: ['repo/src/a.ts'],
                commandTargets: ['bun test'],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 1,
                pendingCount: 0,
            },
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container)
            .getAllByRole('button', { name: /bun test/i })
            .find((button) => button.hasAttribute('aria-expanded'))
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('bun test')).toBeInTheDocument()

        fireEvent.click(toggle!)

        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('bun test')).not.toBeInTheDocument()
    })

    it('keeps an auto-open compact group open until an explicit turn completion', async () => {
        const startedAt = Date.now() - 10_000

        function makeActiveGroup(active: boolean): ToolGroupBlock {
            const tools = [
                makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
                    state: active ? 'running' : 'completed',
                    createdAt: startedAt,
                    startedAt,
                    completedAt: active ? null : startedAt + 10_000,
                }),
                makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' }, {
                    createdAt: startedAt + 1000,
                    startedAt: startedAt + 1000,
                    completedAt: startedAt + 2000,
                }),
            ]
            return makeGroup({
                tools,
                summary: {
                    totalTools: tools.length,
                    countsByKind: {
                        read: 1,
                        search: 0,
                        command: 1,
                        mutation: 0,
                        web: 0,
                        other: 0,
                    },
                    fileTargets: ['repo/src/a.ts'],
                    commandTargets: ['bun test'],
                    searchTargets: [],
                    urlTargets: [],
                    otherTargets: [],
                    errorCount: 0,
                    runningCount: active ? 1 : 0,
                    pendingCount: 0,
                },
            })
        }

        function Harness() {
            const [active, setActive] = useState(true)
            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'compact',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: false,
                        isLoadingMoreMessages: false,
                        loadOlderMessagesPreservingScroll: vi.fn(async () => false),
                    }}>
                        <button type="button" onClick={() => setActive(false)}>finish</button>
                        <ToolGroupCard block={makeActiveGroup(active)} metadata={{ path: 'repo', host: 'local' }} />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        let toggle = within(view.container)
            .getAllByRole('button', { name: /bun test/i })
            .find((button) => button.hasAttribute('aria-expanded'))!
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('bun test')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'finish' }))

        await waitFor(() => {
            toggle = within(view.container).getByRole('button', { name: /processed/i })
            expect(toggle).toHaveAttribute('aria-expanded', 'true')
        })
        expect(screen.getByText('bun test')).toBeInTheDocument()
    })

    it('auto-loads older history after expand when the group is incomplete', async () => {
        const loadOlder = vi.fn()

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return false
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: false,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /inspect project files/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('continues hydrating incomplete history across multiple page loads', async () => {
        let loadCount = 0

        function Harness() {
            const [isLoadingMore, setIsLoadingMore] = useState(false)
            const [hasMore, setHasMore] = useState(true)
            const loadOlderMessagesPreservingScroll = useCallback(() => {
                const shouldContinue = loadCount === 0
                loadCount += 1
                setIsLoadingMore(true)
                return new Promise<boolean>((resolve) => {
                    setTimeout(() => {
                        setIsLoadingMore(false)
                        if (!shouldContinue) {
                            setHasMore(false)
                        }
                        resolve(shouldContinue)
                    }, 0)
                })
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /inspect project files/i })

        fireEvent.click(groupToggle)

        await waitFor(() => {
            expect(loadCount).toBe(2)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })

    it('waits for an in-flight thread pagination to finish before retrying hydration', async () => {
        const loadOlder = vi.fn(async () => false)
        let releaseThreadLoad: (() => void) | null = null

        function Harness() {
            const [hasMore, setHasMore] = useState(true)
            const [isLoadingMore, setIsLoadingMore] = useState(true)

            releaseThreadLoad = () => setIsLoadingMore(false)

            const loadOlderMessagesPreservingScroll = useCallback(async () => {
                loadOlder()
                setHasMore(false)
                return false
            }, [])

            return (
                <I18nProvider>
                    <HappyChatProvider value={{
                        api: {} as never,
                        sessionId: 'session-1',
                        metadata: { path: 'repo', host: 'local' },
                        terminalToolDisplayMode: 'detailed',
                        disabled: false,
                        onRefresh: vi.fn(),
                        hasMoreMessages: hasMore,
                        isLoadingMoreMessages: isLoadingMore,
                        loadOlderMessagesPreservingScroll,
                    }}>
                        <ToolGroupCard
                            block={makeGroup({
                                id: 'tool-group:bash-1',
                                historyState: 'needs-older-history',
                                needsOlderHistory: true,
                            })}
                            metadata={{ path: 'repo', host: 'local' }}
                        />
                    </HappyChatProvider>
                </I18nProvider>
            )
        }

        const view = render(<Harness />)
        const groupToggle = within(view.container).getByRole('button', { name: /inspect project files/i })

        fireEvent.click(groupToggle)

        expect(loadOlder).not.toHaveBeenCalled()
        expect(screen.queryByText('Earlier tool activity is unavailable.')).not.toBeInTheDocument()

        await act(async () => {
            releaseThreadLoad?.()
        })

        await waitFor(() => {
            expect(loadOlder).toHaveBeenCalledTimes(1)
        })
        await waitFor(() => {
            expect(screen.getByText('Earlier tool activity is unavailable.')).toBeInTheDocument()
        })
    })
})
