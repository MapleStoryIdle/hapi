import type { ComponentProps } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { HappyComposer } from './HappyComposer'

const blocks = [] as const

function Harness(props: ComponentProps<typeof HappyComposer>) {
    const runtime = useHappyRuntime({
        session: { active: true, thinking: false },
        blocks,
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {}
    })
    return <AssistantRuntimeProvider runtime={runtime}><HappyComposer {...props} /></AssistantRuntimeProvider>
}

function mount() {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <I18nProvider><Harness active showStatusBar={false} /></I18nProvider>
        </QueryClientProvider>
    )
}

afterEach(cleanup)

describe('composer expansion lifetime', () => {
    it('starts compact, stays expanded after first focus, and resets after leaving the page', () => {
        const first = mount()
        expect(screen.getByTestId('happy-composer')).toHaveAttribute('data-mobile-layout-state', 'compact')

        const input = screen.getByRole('textbox')
        fireEvent.focus(input)
        expect(screen.getByTestId('happy-composer')).toHaveAttribute('data-mobile-layout-state', 'expanded')

        fireEvent.blur(input)
        expect(screen.getByTestId('happy-composer')).toHaveAttribute('data-mobile-layout-state', 'expanded')

        first.unmount()
        mount()
        expect(screen.getByTestId('happy-composer')).toHaveAttribute('data-mobile-layout-state', 'compact')
    })
})
