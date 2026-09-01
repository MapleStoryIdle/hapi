import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function makeMcpBlock(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'mcp-1',
        localId: null,
        createdAt: 1_000,
        children: [],
        tool: {
            id: 'mcp-1',
            name: 'mcp__node_repl__js',
            state: 'completed',
            input: { title: '检查浏览器连接', code: 'browser.status()' },
            createdAt: 1_000,
            startedAt: 1_000,
            completedAt: 2_250,
            description: null,
            result: { ok: true },
            ...overrides,
        }
    }
}

function makeSkillBlock(): ToolCallBlock {
    const block = makeMcpBlock()
    return {
        ...block,
        id: 'skill-1',
        tool: {
            ...block.tool,
            id: 'skill-1',
            name: 'Skill',
            input: { skill: 'imagegen' },
        }
    }
}

function makeTerminalReadBlock(): ToolCallBlock {
    const block = makeMcpBlock()
    return {
        ...block,
        id: 'terminal-read-1',
        tool: {
            ...block.tool,
            id: 'terminal-read-1',
            name: 'CodexBash',
            input: { command: "sed -n '12,80p' web/src/App.tsx" },
        }
    }
}

function renderMcpCard(block: ToolCallBlock) {
    return render(
        <I18nProvider>
            <ToolCard
                api={{} as ApiClient}
                sessionId="session-1"
                metadata={null}
                terminalToolDisplayMode="compact"
                disabled={false}
                onDone={vi.fn()}
                block={block}
            />
        </I18nProvider>
    )
}

describe('Activity tool timing', () => {
    afterEach(() => {
        cleanup()
        vi.useRealTimers()
    })

    it('shows only the final duration and a completed icon', () => {
        const view = renderMcpCard(makeMcpBlock())

        const timing = view.container.querySelector('[data-activity-tool-timing]')
        expect(timing).not.toHaveTextContent('Completed')
        expect(timing).toHaveTextContent('1.3s')
        expect(timing).toHaveAttribute('aria-label', 'Completed 1.3s')
        expect(timing?.lastElementChild).toHaveClass('text-emerald-600')
    })

    it('shows a live duration and running icon while active', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2_250))
        const view = renderMcpCard(makeMcpBlock({
            state: 'running',
            completedAt: null,
        }))

        const timing = view.container.querySelector('[data-activity-tool-timing]')
        expect(timing).not.toHaveTextContent('Running')
        expect(timing).toHaveTextContent('1.3s')
        expect(timing).toHaveAttribute('aria-label', 'Running 1.3s')
        expect(timing?.lastElementChild).toHaveClass('text-[var(--app-hint)]')
    })

    it('prefers the completed duration recorded by the CLI', () => {
        const block = makeMcpBlock()
        block.tool.durationMs = 7_650
        const view = renderMcpCard(block)

        const timing = view.container.querySelector('[data-activity-tool-timing]')
        expect(timing).toHaveTextContent('7.7s')
        expect(timing).toHaveAttribute('aria-label', 'Completed 7.7s')
    })

    it('uses the same duration and icon treatment for Skill cards', () => {
        const view = renderMcpCard(makeSkillBlock())

        expect(view.getByText('Skill: imagegen')).toBeInTheDocument()
        const timing = view.container.querySelector('[data-activity-tool-timing]')
        expect(timing).not.toHaveTextContent('Completed')
        expect(timing).toHaveTextContent('1.3s')
        expect(timing).toHaveAttribute('aria-label', 'Completed 1.3s')
        expect(timing?.lastElementChild).toHaveClass('text-emerald-600')
    })

    it('keeps explicit terminal read requests timed with their requested file target', () => {
        const view = renderMcpCard(makeTerminalReadBlock())

        expect(view.getByText('Read file')).toBeInTheDocument()
        expect(view.getByText('App.tsx · L12–80')).toBeInTheDocument()
        const timing = view.container.querySelector('[data-activity-tool-timing]')
        expect(timing).toHaveTextContent('1.3s')
        expect(timing).toHaveAttribute('aria-label', 'Completed 1.3s')
    })
})
