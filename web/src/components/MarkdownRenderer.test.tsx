import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AssistantRuntimeProvider, ThreadPrimitive, useLocalRuntime } from '@assistant-ui/react'
import { MarkdownRenderer } from './MarkdownRenderer'

function InThreadMarkdownHarness() {
    const runtime = useLocalRuntime(
        { run: async () => ({ content: [] }) },
        { initialMessages: [{ role: 'assistant', content: 'placeholder' }] }
    )

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root>
                <ThreadPrimitive.Messages
                    components={{
                        AssistantMessage: () => <MarkdownRenderer content={'**下一步：**先定位'} />,
                        UserMessage: () => null
                    }}
                />
            </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
    )
}

describe('MarkdownRenderer', () => {
    it('renders standalone markdown outside assistant message context', () => {
        render(
            <MarkdownRenderer
                standalone
                content={'# README\n\nInline `code`\n\n```ts\nconst ok = true\n```'}
            />
        )

        expect(screen.getByRole('heading', { name: 'README' })).toBeInTheDocument()
        expect(screen.getByText('const ok = true')).toBeInTheDocument()
    })

    it('renders inline strong text in the in-message renderer', () => {
        const view = render(<InThreadMarkdownHarness />)

        expect(view.container.querySelector('strong')).toHaveTextContent('下一步：')
        expect(view.container).not.toHaveTextContent('**下一步：**先定位')
    })
})
