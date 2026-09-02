import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AssistantRuntimeProvider, ThreadPrimitive, useLocalRuntime } from '@assistant-ui/react'
import { useEffect } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { useMarkdownRemarkPlugins } from '@/components/assistant-ui/markdown-text'

const routerMocks = vi.hoisted(() => ({
    navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => routerMocks.navigate,
}))

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

function renderInChat(content: string, preserveSingleLineBreaks = false) {
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: {} as never,
                sessionId: 'session-1',
                metadata: { path: '/workspace/project', host: 'local' },
                terminalToolDisplayMode: 'compact',
                disabled: false,
                onRefresh: vi.fn(),
                hasMoreMessages: false,
                isLoadingMoreMessages: false,
                loadOlderMessagesPreservingScroll: vi.fn(async () => false),
            }}>
                <MarkdownRenderer standalone content={content} preserveSingleLineBreaks={preserveSingleLineBreaks} />
            </HappyChatProvider>
        </I18nProvider>
    )
}

function RemarkPluginIdentityProbe(props: {
    onPlugins: (plugins: ReturnType<typeof useMarkdownRemarkPlugins>) => void
}) {
    const { onPlugins } = props
    const plugins = useMarkdownRemarkPlugins()

    useEffect(() => {
        onPlugins(plugins)
    }, [onPlugins, plugins])

    return null
}

function chatProviderProbe(onPlugins: (plugins: ReturnType<typeof useMarkdownRemarkPlugins>) => void) {
    return (
        <HappyChatProvider value={{
            api: {} as never,
            sessionId: 'session-1',
            metadata: { path: '/workspace/project', host: 'local' },
            terminalToolDisplayMode: 'compact',
            disabled: false,
            onRefresh: vi.fn(),
            hasMoreMessages: false,
            isLoadingMoreMessages: false,
            loadOlderMessagesPreservingScroll: vi.fn(async () => false),
        }}>
            <RemarkPluginIdentityProbe onPlugins={onPlugins} />
        </HappyChatProvider>
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

    it('keeps no-chat explicit file Markdown links as ordinary anchors', () => {
        render(<MarkdownRenderer standalone content={'[README](README.md)'} />)

        expect(screen.getByRole('link', { name: 'README' })).toHaveAttribute('href', 'README.md')
    })

    it.each([false, true])('autolinks workspace absolute paths in chat (%s with breaks)', (preserveSingleLineBreaks) => {
        const view = renderInChat('Open /workspace/project/docs/README.md:42', preserveSingleLineBreaks)

        const link = view.container.querySelector<HTMLAnchorElement>('a[data-hapi-file-link]')
        expect(link).not.toBeNull()
        expect(link).toHaveAttribute('data-hapi-file-link', 'true')
        expect(link).toHaveAttribute('title', '/workspace/project/docs/README.md:42')
        expect(link).toHaveClass('text-[var(--app-link)]')
        expect(link?.querySelector('[data-markdown-link-icon="file"]')).not.toBeNull()
    })

    it('shows external Markdown links with a link icon and theme-link color', () => {
        renderInChat('[HAPI docs](https://hapi.run/docs)')

        const link = screen.getByRole('link', { name: 'HAPI docs' })
        expect(link).toHaveAttribute('data-hapi-external-link', 'true')
        expect(link).toHaveClass('text-[var(--app-link)]')
        expect(link.querySelector('[data-markdown-link-icon="external"]')).not.toBeNull()
    })

    it('keeps remark plugins stable when the chat provider value is recreated', () => {
        const onPlugins = vi.fn()
        const view = render(chatProviderProbe(onPlugins))

        expect(onPlugins).toHaveBeenCalledTimes(1)
        view.rerender(chatProviderProbe(onPlugins))
        expect(onPlugins).toHaveBeenCalledTimes(1)
    })

    it('renders inline strong text in the in-message renderer', () => {
        const view = render(<InThreadMarkdownHarness />)

        expect(view.container.querySelector('strong')).toHaveTextContent('下一步：')
        expect(view.container).not.toHaveTextContent('**下一步：**先定位')
    })
})
