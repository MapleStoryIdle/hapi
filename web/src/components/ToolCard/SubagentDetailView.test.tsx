import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { ToolDetailDialogContent } from './ToolCard'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => <>{props.content}</>
}))
afterEach(cleanup)

function block(name = 'CodexAgent'): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'subagent-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'subagent-1', name, state: 'running', createdAt: 1000, startedAt: 1000,
            completedAt: null, description: null,
            input: {
                agentId: 'internal-agent-id', activity: 'Checking the drawer',
                prompt: 'Review keyboard and scrolling', agent_type: 'reviewer',
                hapiSubagentConfig: { childModel: 'test-model', childReasoningEffort: 'high' }
            }
        }
    }
}

function detail(value: ToolCallBlock) {
    return <I18nProvider><ToolDetailDialogContent block={value} metadata={null} /></I18nProvider>
}

describe('SubagentDetailView', () => {
    it.each(['CodexAgent', 'Task', 'Agent'])('opens %s on progress, not configuration', (name) => {
        render(detail(block(name)))
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Activity', 'Information'])
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Checking the drawer')
        expect(screen.queryByText('Review keyboard and scrolling')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('tab', { name: 'Information' }))
        expect(screen.getByText('Review keyboard and scrolling')).toBeVisible()
        expect(screen.getByText('internal-agent-id')).toBeVisible()
        expect(screen.getByText('test-model')).toBeVisible()
        expect(screen.getByText('high')).toBeVisible()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('uses the same resolved model and reasoning values as the compact subagent card', () => {
        const value = block()
        value.model = 'parent-model'
        value.tool.input = {
            ...(value.tool.input as Record<string, unknown>),
            hapiSubagentConfig: {
                childModel: 'child-model',
                childReasoningEffort: 'medium',
                parentModel: 'parent-model',
                parentReasoningEffort: 'high'
            }
        }

        render(detail(value))
        fireEvent.click(screen.getByRole('tab', { name: 'Information' }))

        expect(screen.getByText('child-model')).toBeVisible()
        expect(screen.getByText('medium')).toBeVisible()
        expect(screen.queryByText('parent-model')).not.toBeInTheDocument()
    })

    it('supports keyboard tabs and displays live results without resetting the tab', () => {
        const initial = block()
        const view = render(detail(initial))
        fireEvent.keyDown(screen.getByRole('tab', { name: 'Activity' }), { key: 'ArrowRight' })
        expect(screen.getByRole('tab', { name: 'Information' })).toHaveFocus()
        view.rerender(detail({ ...initial, tool: { ...initial.tool, state: 'completed', result: 'Review passed' } }))
        expect(screen.getByRole('tab', { name: 'Information' })).toHaveAttribute('aria-selected', 'true')
        fireEvent.keyDown(screen.getByRole('tab', { name: 'Information' }), { key: 'Home' })
        expect(screen.getByRole('status')).toHaveTextContent('Completed')
        expect(within(screen.getByRole('tabpanel')).getByText('Review passed')).toBeVisible()
    })

    it('leaves drawer scrolling to the shared surface instead of adding a fixed trace viewport', () => {
        const parent = block()
        parent.children = [{ ...block('Read'), id: 'child-1', tool: { ...block('Read').tool, id: 'child-1', input: { file_path: 'a.ts' } } }]
        const view = render(detail(parent))
        expect(screen.getByRole('button', { name: /Activity log/ })).toHaveAttribute('aria-expanded', 'true')
        expect(view.container.querySelector('[class*="min-h-[260px]"]')).toBeNull()
        expect(view.container.querySelector('[class*="max-h-[45vh]"]')).toBeNull()
    })
})
