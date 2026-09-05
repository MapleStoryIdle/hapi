import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@/chat/types'

const state = vi.hoisted(() => ({
    event: null as unknown
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')

    return {
        MessagePrimitive: {
            Root: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('div', props, children)
        },
        useAssistantState: (selector: (value: unknown) => unknown) => selector({
            message: {
                role: 'system',
                id: 'message-1',
                createdAt: new Date('2026-08-31T01:23:00Z'),
                content: [{ type: 'text', text: '' }],
                metadata: { custom: { kind: 'event', event: state.event } }
            }
        })
    }
})

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { HappySystemMessage } from './SystemMessage'

function renderEvent(event: AgentEvent) {
    state.event = event
    return render(<HappySystemMessage />)
}

afterEach(() => cleanup())

describe('HappySystemMessage — quota events', () => {
    it('shows the quota reason and its settings action', () => {
        renderEvent({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'usage_limit',
            message: "You've hit your usage limit.",
            recoverable: false,
            actionUrl: 'https://chatgpt.com/codex/settings/usage',
            resetAtText: 'Sep 7th, 2026 10:26 AM'
        })

        expect(screen.getByText('taskStatus.usage.title')).toBeInTheDocument()
        expect(screen.getByText('taskStatus.usage.bodyWithReset')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'taskStatus.usage.action' })).toHaveAttribute(
            'href',
            'https://chatgpt.com/codex/settings/usage'
        )
        expect(screen.getByRole('link', { name: 'taskStatus.usage.action' })).toHaveClass('message-content-link', 'no-underline')
    })

    it('uses the compact context-divider treatment for Codex usage updates', () => {
        const rawMessage = 'Codex usage updated · GPT-5.3-Codex-Spark: primary 0% / 300 min, secondary 0% / 10080 min'
        renderEvent({ type: 'codex-usage-updated', message: rawMessage })

        const divider = screen.getByTestId('usage-limit-event')
        expect(divider).toHaveAttribute('data-event-style', 'divider')
        expect(divider).toHaveTextContent('Codex usage updated')
        expect(divider).toHaveAttribute('aria-label', `Codex usage updated. ${rawMessage}`)
    })

    it('uses the same compact treatment for other quota notices', () => {
        renderEvent({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour'
        })

        expect(screen.getByTestId('usage-limit-event')).toHaveTextContent('Usage limit 90% (5-hour)')
    })

    it('keeps non-quota task failures as alert cards', () => {
        renderEvent({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'model_capacity',
            message: 'Selected model is at capacity.',
            recoverable: false
        })

        expect(screen.queryByTestId('usage-limit-event')).not.toBeInTheDocument()
        expect(screen.getByText('taskStatus.modelCapacity.title')).toBeInTheDocument()
    })

    it('shows a network-specific task failure card', () => {
        renderEvent({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'unknown',
            message: 'Network error: request timed out',
            recoverable: false
        })

        expect(screen.getByText('taskStatus.network.title')).toBeInTheDocument()
        expect(screen.getByText('taskStatus.network.body')).toBeInTheDocument()
    })
})
