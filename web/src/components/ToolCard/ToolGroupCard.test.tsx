import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import {
    ToolGroupCard,
    assignCodexSubagentCardColors,
    getCodexSubagentCardColor,
    getCodexSubagentCardIdentity,
    getCodexSubagentCardState
} from '@/components/ToolCard/ToolGroupCard'
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

        const toggle = within(view.container).getByRole('button', { name: /^查看本地会话$/i })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(view.container.innerHTML).not.toContain('bg-[var(--app-tool-group-bg)]')

        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(within(view.container).getAllByText('查看本地会话')).toHaveLength(2)
    })

    it('keeps native Codex subagent cards visible below a closed processed group', () => {
        const firstAgent = makeToolBlock('codex-agent-first', 'CodexAgent', {
            summary: 'Explore the codebase',
            model: 'gpt-5.3-codex',
            reasoning_effort: 'high',
            activity: 'Completed exploration'
        }, {
            createdAt: 10,
            startedAt: 10,
            completedAt: 11,
        })
        const modelFromBlockAgent: ToolCallBlock = {
            ...makeToolBlock('codex-agent-second', 'CodexAgent', {
                summary: 'Verify the changes',
                reasoning_effort: 'medium',
                agentStatus: 'completed'
            }, {
                createdAt: 20,
                startedAt: 20,
                completedAt: 21,
            }),
            createdAt: 20,
            model: 'gpt-5.4'
        }
        const fallbackAgent = makeToolBlock('codex-agent-third', 'CodexAgent', {
            summary: 'Report the result'
        }, {
            createdAt: 30,
            startedAt: 30,
            completedAt: 31,
        })
        const claudeTask = makeToolBlock('claude-task', 'Task', { description: 'Do not render as a Codex card' })
        const claudeAgent = makeToolBlock('claude-agent', 'Agent', { description: 'Do not render as a Codex card' })
        const view = renderCard(makeGroup({
            tools: [fallbackAgent, claudeTask, modelFromBlockAgent, claudeAgent, firstAgent],
            forceCompact: true,
            forceGenericCompactTitle: true,
        }))

        const processed = within(view.container).getByRole('button', { name: 'Processed' })
        expect(processed).toHaveAttribute('aria-expanded', 'false')

        const cards = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-codex-subagent-card]'))
        expect(cards.map((card) => card.dataset.toolId)).toEqual([
            'codex-agent-first',
            'codex-agent-second',
            'codex-agent-third'
        ])
        expect(view.container.querySelector('[data-tool-id="claude-task"]')).toBeNull()
        expect(view.container.querySelector('[data-tool-id="claude-agent"]')).toBeNull()
        expect(view.container.querySelector('[data-codex-subagent-cards]')).toHaveClass('flex', 'flex-wrap')
        expect(cards[0]).toHaveClass('min-h-11')
        expect(cards[0]).toHaveAttribute('aria-haspopup', 'dialog')
        expect(cards[0]).toHaveAccessibleName(/Explore the codebase/)
        expect(cards[0]).toHaveAccessibleName(/gpt-5\.3-codex · high/)
        expect(cards[0]).toHaveAccessibleName(/Completed/)
        expect(cards[0]).not.toHaveAccessibleName(/Agent:|Model:|Reasoning:|Status:/)

        expect(within(cards[0]).getByText('Explore the codebase')).toBeInTheDocument()
        expect(within(cards[0]).getByText('gpt-5.3-codex · high')).toBeInTheDocument()
        expect(within(cards[0]).getByRole('status', { name: 'Completed' })).toHaveClass('sr-only')
        expect(within(cards[0]).queryByText('Completed exploration')).toBeNull()
        expect(within(cards[1]).getByText('gpt-5.4 · medium')).toBeInTheDocument()
        expect(within(cards[2]).getByText('unavailable')).toBeInTheDocument()
    })

    it('uses explicit, child, then parent configuration for Codex subagent cards', () => {
        const explicitlyConfigured = makeToolBlock('explicit-agent', 'CodexAgent', {
            summary: 'Explicit configuration',
            model: 'gpt-explicit',
            reasoning_effort: 'max',
            hapiSubagentConfig: {
                childModel: 'gpt-child',
                childReasoningEffort: 'medium',
                parentModel: 'gpt-parent',
                parentReasoningEffort: 'high'
            }
        })
        const childConfigured: ToolCallBlock = {
            ...makeToolBlock('child-agent', 'CodexAgent', {
                summary: 'Child configuration',
                hapiSubagentConfig: {
                    childModel: 'gpt-child',
                    childReasoningEffort: 'medium',
                    parentModel: 'gpt-parent',
                    parentReasoningEffort: 'high'
                }
            }),
            model: 'gpt-parent-message'
        }
        const inheritedConfiguration = makeToolBlock('inherited-agent', 'CodexAgent', {
            summary: 'Inherited configuration',
            hapiSubagentConfig: {
                parentModel: 'gpt-parent',
                parentReasoningEffort: 'high'
            }
        })
        const view = renderCard(makeGroup({
            tools: [explicitlyConfigured, childConfigured, inheritedConfiguration],
            forceCompact: true,
            forceGenericCompactTitle: true,
        }))
        const cards = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-codex-subagent-card]'))

        expect(cards).toHaveLength(3)
        expect(cards[0]).toHaveTextContent('gpt-explicit · max')
        expect(cards[0]).not.toHaveTextContent('inherited')
        expect(cards[1]).toHaveTextContent('gpt-child · medium')
        expect(cards[1]).not.toHaveTextContent('inherited')
        expect(cards[2]).toHaveTextContent('gpt-parent · high')
        expect(cards[2]).not.toHaveTextContent('inherited')
        expect(cards[0]).toHaveClass('w-[calc((100%-0.5rem)/2)]', 'max-w-[calc((100%-0.5rem)/2)]')
        expect(cards[0]).not.toHaveClass('flex-1')
    })

    it('uses friendly card identities, deterministic colors, and icon-only tool states', () => {
        const named = makeToolBlock('agent-alpha', 'CodexAgent', {
            displayName: 'Ada',
            agentId: 'agent-id-must-not-leak',
            model: 'gpt-5.4',
            reasoning_effort: 'high'
        })
        const role = makeToolBlock('agent-beta', 'CodexAgent', {
            agent_type: 'reviewer',
            agentId: 'another-agent-id'
        }, { state: 'pending' })
        const summary = makeToolBlock('agent-gamma', 'CodexAgent', {
            summary: 'Check the test failures'
        }, { state: 'error' })
        const fallback = makeToolBlock('agent-delta', 'CodexAgent', {
            agentId: 'only-an-agent-id'
        })
        const spawnNickname = makeToolBlock('agent-epsilon', 'CodexAgent', {
            message: 'Implement the parser',
            agentId: 'result-agent-id'
        }, {
            result: JSON.stringify({ agent_id: 'result-agent-id', nickname: 'Raman' })
        })
        const disguisedId = makeToolBlock('agent-zeta', 'CodexAgent', {
            agentId: 'unsafe-agent-id',
            name: 'unsafe-agent-id'
        })
        const view = renderCard(makeGroup({
            tools: [named, role, summary, fallback, spawnNickname, disguisedId],
            forceCompact: true,
            forceGenericCompactTitle: true,
        }))
        const cards = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-codex-subagent-card]'))

        expect(getCodexSubagentCardIdentity(named)).toBe('Ada')
        expect(getCodexSubagentCardIdentity(role)).toBe('reviewer')
        expect(getCodexSubagentCardIdentity(summary)).toBe('Check the test failures')
        expect(getCodexSubagentCardIdentity(fallback)).toMatch(/^(Atlas|Nova|Orbit|Sage|Scout|Beacon|Harbor|Piper)$/)
        expect(getCodexSubagentCardIdentity(spawnNickname)).toBe('Raman')
        expect(getCodexSubagentCardIdentity(disguisedId)).toMatch(/^(Atlas|Nova|Orbit|Sage|Scout|Beacon|Harbor|Piper)$/)
        expect(cards.map((card) => card.textContent)).toEqual(expect.arrayContaining([
            expect.stringContaining('Ada'),
            expect.stringContaining('reviewer'),
            expect.stringContaining('Check the test failures'),
            expect.stringContaining(getCodexSubagentCardIdentity(fallback)),
            expect.stringContaining('Raman'),
            expect.stringContaining(getCodexSubagentCardIdentity(disguisedId))
        ]))
        expect(view.container).not.toHaveTextContent('agent-id-must-not-leak')
        expect(view.container).not.toHaveTextContent('another-agent-id')
        expect(view.container).not.toHaveTextContent('only-an-agent-id')
        expect(view.container).not.toHaveTextContent('result-agent-id')
        expect(view.container).not.toHaveTextContent('unsafe-agent-id')

        expect(getCodexSubagentCardColor('agent-alpha')).toBe(getCodexSubagentCardColor('agent-alpha'))
        expect(getCodexSubagentCardColor('agent-alpha')).not.toBe(getCodexSubagentCardColor('agent-beta'))
        const collisionColors = assignCodexSubagentCardColors(['summary-card', 'fallback-card'])
        const reversedCollisionColors = assignCodexSubagentCardColors(['fallback-card', 'summary-card'])
        expect(collisionColors.get('summary-card')).not.toBe(collisionColors.get('fallback-card'))
        expect(collisionColors.get('summary-card')).toBe(reversedCollisionColors.get('summary-card'))
        expect(collisionColors.get('fallback-card')).toBe(reversedCollisionColors.get('fallback-card'))
        expect(cards[0]).toHaveAttribute('data-codex-subagent-color', getCodexSubagentCardColor('agent-alpha'))
        expect(cards[1]).toHaveAttribute('data-codex-subagent-color', getCodexSubagentCardColor('agent-beta'))
        expect(cards[0].querySelector('[data-codex-subagent-icon] [title="Codex"]')).not.toBeNull()

        expect(cards[0]).toHaveTextContent('gpt-5.4 · high')
        expect(cards[0]).not.toHaveTextContent('Model:')
        expect(cards[0]).not.toHaveTextContent('Reasoning:')
        expect(cards[1]).toHaveAttribute('data-codex-subagent-status', 'pending')
        expect(cards[2]).toHaveAttribute('data-codex-subagent-status', 'error')
        expect(within(cards[1]).getByRole('status', { name: 'Waiting to run' })).toHaveClass('sr-only')
        expect(within(cards[2]).getByRole('status', { name: 'Failed' })).toHaveClass('sr-only')
        expect(getCodexSubagentCardState('failed')).toBe('error')
        expect(getCodexSubagentCardState('cancelled')).toBe('error')
        expect(getCodexSubagentCardState('not-found')).toBe('error')
    })

    it('resolves colliding palette slots across rendered Codex agent cards', () => {
        const first = makeToolBlock('summary-card', 'CodexAgent', { summary: 'First agent' })
        const second = makeToolBlock('fallback-card', 'CodexAgent', { summary: 'Second agent' })
        const view = renderCard(makeGroup({
            tools: [first, second],
            forceCompact: true,
            forceGenericCompactTitle: true,
        }))
        const cards = Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-codex-subagent-card]'))

        expect(getCodexSubagentCardColor(first.id)).toBe(getCodexSubagentCardColor(second.id))
        expect(cards[0]).toHaveAttribute('data-codex-subagent-color')
        expect(cards[1]).toHaveAttribute('data-codex-subagent-color')
        expect(cards[0].dataset.codexSubagentColor).not.toBe(cards[1].dataset.codexSubagentColor)
    })

    it('opens Codex subagent cards with activity first and basic information in the second tab', async () => {
        const agent = makeToolBlock('codex-agent-detail', 'CodexAgent', {
            summary: 'Inspect the implementation',
            model: 'gpt-5.3-codex',
            reasoning_effort: 'high',
            agentStatus: 'completed',
            agentId: 'dialog-agent-id'
        }, {
            createdAt: 10,
            startedAt: 10,
            completedAt: 11,
            result: undefined,
        })
        const read = makeToolBlock('read-1', 'Read', { file_path: 'repo/src/a.ts' })
        const view = renderCard(makeGroup({
            tools: [agent, read],
            detailBlocks: [agent, read],
            forceCompact: true,
            forceGenericCompactTitle: true,
        }))

        const card = within(view.container).getByRole('button', { name: /Inspect the implementation/i })
        const processed = within(view.container).getByRole('button', { name: 'Processed' })
        expect(card).not.toHaveTextContent('dialog-agent-id')
        expect(card).not.toHaveAccessibleName(/dialog-agent-id/)
        expect(card.innerHTML).not.toContain('dialog-agent-id')

        fireEvent.click(processed)

        expect(screen.getAllByText('Inspect the implementation')).toHaveLength(1)
        expect(screen.getByText('a.ts')).toBeInTheDocument()

        fireEvent.click(card)

        await waitFor(() => {
            expect(screen.getByRole('dialog')).toBeInTheDocument()
        })
        expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Agent: Inspect the implementation' })).toBeInTheDocument()
        const drawer = screen.getByRole('dialog')
        expect(drawer).toHaveAttribute('data-chat-detail-drawer', 'true')
        expect(within(drawer).getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
        expect(within(drawer).queryByText('dialog-agent-id')).not.toBeInTheDocument()
        fireEvent.click(within(drawer).getByRole('tab', { name: 'Information' }))
        expect(within(drawer).getByText('dialog-agent-id')).toBeVisible()
    })

    it('keeps the source launch order when Codex agents share a timestamp', () => {
        const firstAgent = makeToolBlock('z-agent', 'CodexAgent', { summary: 'First launch' }, {
            createdAt: 10,
            startedAt: 10,
            completedAt: 11,
        })
        const secondAgent = makeToolBlock('a-agent', 'CodexAgent', { summary: 'Second launch' }, {
            createdAt: 10,
            startedAt: 10,
            completedAt: 11,
        })
        const view = renderCard(makeGroup({
            tools: [firstAgent, secondAgent],
            forceCompact: true,
            forceGenericCompactTitle: true,
        }))

        expect(Array.from(view.container.querySelectorAll<HTMLButtonElement>('[data-codex-subagent-card]'))
            .map((card) => card.dataset.toolId)).toEqual(['z-agent', 'a-agent'])
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
        expect(screen.getByText('a.ts')).toBeInTheDocument()
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
        expect(within(dialog).getByRole('heading', { name: 'Read file' })).toBeInTheDocument()
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

        const toggle = within(view.container).getByRole('button', { name: /^run node\.js$/i })
        fireEvent.click(toggle)

        expect(within(view.container).getAllByText('Run Node.js')).toHaveLength(2)
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

        const singleToggle = within(singleView.container).getByRole('button', { name: /^read file · App\.tsx · L12–80$/i })
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

        const batchToggle = within(batchView.container).getByRole('button', { name: /^read a batch of files$/i })
        fireEvent.click(batchToggle)

        expect(within(batchView.container).getAllByText('Read a batch of files')).toHaveLength(2)
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

    it('uses the newest reasoning action while the native turn remains active', () => {
        const now = Date.now()
        const tool = makeToolBlock('read-1', 'Read', { file_path: 'src/old.ts' }, {
            createdAt: now - 8_000,
            startedAt: now - 8_000,
            completedAt: now - 7_000
        })
        const view = renderCard(makeGroup({
            createdAt: now - 8_000,
            invokedAt: now - 8_000,
            tools: [tool],
            detailBlocks: [tool, {
                kind: 'agent-reasoning',
                id: 'reasoning-1',
                localId: null,
                createdAt: now - 1_000,
                text: '**Inspecting files**\n\n**Verifying the final result**'
            }],
            forceGenericCompactTitle: true,
            forceCompact: true,
            showAgentIcon: true,
            turnActive: true,
            summary: {
                totalTools: 1,
                countsByKind: {
                    read: 1,
                    search: 0,
                    command: 0,
                    mutation: 0,
                    web: 0,
                    other: 0
                },
                fileTargets: ['src/old.ts'],
                commandTargets: [],
                searchTargets: [],
                urlTargets: [],
                otherTargets: [],
                errorCount: 0,
                runningCount: 0,
                pendingCount: 0
            }
        }), { terminalToolDisplayMode: 'compact' })

        const toggle = within(view.container)
            .getAllByRole('button', { name: /Verifying the final result \d+s/i })
            .find((button) => button.hasAttribute('aria-expanded'))
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(toggle?.querySelector('.motion-safe\\:animate-pulse')).not.toBeNull()
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

        expect(within(view.container).getByRole('button', { name: /^apply_patch$/i })).toBeInTheDocument()
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

        expect(within(view.container).getByRole('button', { name: /^modified src\/example\.ts$/i })).toBeInTheDocument()
    })

    it('opens a compact Modified row in a bounded dialog instead of a full-screen page', () => {
        const edit = makeToolBlock('edit-1', 'Edit', {
            file_path: 'src/example.ts',
            old_string: 'before',
            new_string: 'after'
        })
        const view = renderCard(makeGroup({
            tools: [edit],
            forceCompact: true,
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

        fireEvent.click(within(view.container).getByRole('button', { name: /^modified src\/example\.ts$/i }))
        const mutationRow = within(view.container)
            .getAllByRole('button', { name: /modified.*example\.ts/i })
            .find((button) => !button.hasAttribute('aria-expanded'))
        expect(mutationRow).toBeDefined()
        fireEvent.click(mutationRow!)

        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveAttribute('data-chat-detail-drawer', 'true')
        expect(dialog).toHaveClass('question-drawer', 'inset-x-0', 'rounded-t-[28px]')
        expect(dialog).not.toHaveClass('inset-0', 'h-[100dvh]', 'w-screen', 'rounded-none')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
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
