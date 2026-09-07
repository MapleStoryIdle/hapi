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

describe('thinking belongs to the thread, not the composer', () => {
    it.each(['claude', 'codex', 'cursor'])('does not reserve thinking space for %s', (agentFlavor) => {
        render(tree({ active: true, thinking: true, showStatusBar: false, agentFlavor }))
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
        expect(screen.queryByTestId('composer-thinking-slot')).toBeNull()
        expect(screen.getByRole('textbox')).toBeInTheDocument()
    })
    it('does not duplicate thinking when the full status bar is enabled', () => {
        render(tree({ active: true, thinking: true, showStatusBar: true, agentFlavor: 'codex' }))
        expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
    })
    it('does not add a slot on permission wait, offline, voice connection, or idle', () => {
        const props = { active: true, thinking: true, showStatusBar: false }
        const view = render(tree(props))
        expect(screen.queryByTestId('composer-thinking-slot')).toBeNull()
        for (const override of [
            { agentState: { requests: { q: { tool: 'AskUserQuestion', arguments: {}, createdAt: null } } } },
            { active: false }, { voiceStatus: 'connecting' as const }, { thinking: false }
        ]) {
            view.rerender(tree({ ...props, ...override }))
            expect(screen.queryByTestId('session-thinking-indicator')).toBeNull()
            expect(screen.queryByTestId('composer-thinking-slot')).toBeNull()
        }
    })
})
