import type { ComponentProps } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { HappyComposer } from './HappyComposer'

afterEach(cleanup)
const blocks = [] as const
function Harness(props: ComponentProps<typeof HappyComposer>) {
    const runtime = useHappyRuntime({ session: { active: true, thinking: true }, blocks,
        isSending: false, onSendMessage: () => {}, onAbort: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}><HappyComposer {...props} /></AssistantRuntimeProvider>
}
function tree(props: ComponentProps<typeof HappyComposer>) {
    return <QueryClientProvider client={new QueryClient()}><I18nProvider><Harness {...props} /></I18nProvider></QueryClientProvider>
}

describe('composer thinking independent of metadata bar', () => {
    it.each(['claude', 'codex', 'cursor'])('shows %s thinking with the same hidden metadata bar used by SessionChat', (agentFlavor) => {
        render(tree({ active: true, thinking: true, showStatusBar: false, agentFlavor }))
        const indicator = screen.getByTestId('session-thinking-indicator')
        expect(indicator.parentElement).toHaveClass('justify-start')
        expect(indicator).toHaveAttribute('data-tone', 'warm')
        expect(screen.getByRole('textbox')).toBeInTheDocument()
    })
    it('does not duplicate thinking when the full status bar is enabled', () => {
        render(tree({ active: true, thinking: true, showStatusBar: true, agentFlavor: 'codex' }))
        expect(screen.getAllByTestId('session-thinking-indicator')).toHaveLength(1)
    })
    it('removes thinking on permission wait, offline, voice connection, and idle', () => {
        const props = { active: true, thinking: true, showStatusBar: false }
        const view = render(tree(props))
        expect(screen.getByTestId('session-thinking-indicator')).toBeInTheDocument()
        for (const override of [
            { agentState: { requests: { q: { tool: 'AskUserQuestion', arguments: {}, createdAt: null } } } },
            { active: false }, { voiceStatus: 'connecting' as const }, { thinking: false }
        ]) {
            view.rerender(tree({ ...props, ...override }))
            expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
        }
    })
})
