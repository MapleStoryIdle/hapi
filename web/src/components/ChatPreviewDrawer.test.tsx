import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatPreview } from './ChatPreviewContext'
import { I18nProvider } from '@/lib/i18n-context'
import ChatPreviewDrawer from './ChatPreviewDrawer'

const copyPath = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copy: copyPath, copied: false }) }))

vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }))
vi.mock('@/components/CodeBlock', () => ({ CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function show(preview: ChatPreview, strict = false) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const content = <QueryClientProvider client={client}><I18nProvider><ChatPreviewDrawer preview={preview} open onOpenChange={() => {}} /></I18nProvider></QueryClientProvider>
    return render(strict ? <StrictMode>{content}</StrictMode> : content)
}

it('loads a native file from its source machine without managed-session APIs', async () => {
    const read = vi.fn().mockResolvedValue({ success: true, content: btoa('native content') })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'test.ts' })
    await screen.findByText('native content')
    expect(read).toHaveBeenCalledWith('n1', 'm1', 'test.ts')
    expect(screen.queryByRole('button', { name: 'Changes' })).not.toBeInTheDocument()
})

it('shows read failures and retries without leaving the conversation', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('Read failed (HTTP 403)')).mockResolvedValue({ success: true, content: btoa('retry succeeded') })
    show({ type: 'file', api: { readSessionFile: read } as unknown as ApiClient, source: { type: 'session', sessionId: 's1' }, path: 'test.ts' })
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('retry succeeded')
    expect(read).toHaveBeenCalledTimes(2)
})

it('honors the staged Git preview and lets the user return to source', async () => {
    const read = vi.fn().mockResolvedValue({ success: true, content: btoa('source content') })
    const diff = vi.fn().mockResolvedValue({ success: true, stdout: '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old content\n+new content' })
    show({ type: 'file', api: { readSessionFile: read, getGitDiffFile: diff } as unknown as ApiClient, source: { type: 'session', sessionId: 's1' }, path: 'test.ts', diff: true, staged: true })
    expect(await screen.findByText('+new content')).toHaveClass('bg-[var(--app-diff-added-bg)]')
    expect(screen.getByText('-old content')).toHaveClass('bg-[var(--app-diff-removed-bg)]')
    expect(screen.getByText('+++ b/test.ts')).not.toHaveClass('bg-[var(--app-diff-added-bg)]')
    expect(screen.getByText('--- a/test.ts')).not.toHaveClass('bg-[var(--app-diff-removed-bg)]')
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Copy$/ })).not.toBeInTheDocument()
    expect(diff).toHaveBeenCalledWith('s1', 'test.ts', true)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    await screen.findByText('source content')
})

it('sandboxes web content and always offers a separate browser fallback', () => {
    show({ type: 'url', url: 'https://example.com/' })
    const frame = screen.getByTitle('Web preview')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-same-origin|allow-top-navigation/)
    expect(screen.getByRole('link', { name: 'Open in browser' })).toHaveAttribute('rel', 'noopener noreferrer')
})

it('shows a recoverable error instead of leaving a failed web frame blank', async () => {
    vi.useFakeTimers()
    show({ type: 'url', url: 'https://example.com/broken' })
    expect(screen.getByTitle('Web preview')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load preview')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByTitle('Web preview')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
})


it('loads local services directly in a sandboxed frame through the authenticated API', async () => {
    const url = 'https://hapi.test/preview/' + 'a'.repeat(32) + '/__shapi_local/embed/' + 'b'.repeat(64) + '/app'
    const openLocalService = vi.fn().mockResolvedValue({ url, expiresAt: Date.now() + 60_000 })
    show({ type: 'url', url: '/local-service#source=fixture', localService: { api: { openLocalService } as unknown as ApiClient, request: { source: { type: 'session', sessionId: 's1' }, url: 'http://localhost:3000/' } } }, true)
    await waitFor(() => expect(document.querySelector('iframe')).toHaveAttribute('src', url))
    expect(openLocalService).toHaveBeenCalledTimes(1)
    expect(openLocalService).toHaveBeenCalledWith({ presentation: 'embed', source: { type: 'session', sessionId: 's1' }, url: 'http://localhost:3000/' })
    expect(document.querySelector('iframe')!.getAttribute('sandbox')).not.toContain('allow-same-origin')
})

it('shows local connection failures and retries inside the drawer', async () => {
    const url = 'https://preview.test/__shapi_local/embed/' + 'b'.repeat(64) + '/'
    const openLocalService = vi.fn().mockRejectedValueOnce(new Error('Runner offline')).mockResolvedValue({ url })
    show({ type: 'url', url: '/local-service#fixture', localService: { api: { openLocalService } as unknown as ApiClient, request: { source: { type: 'session', sessionId: 's1' }, url: 'http://localhost:3000/' } } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Runner offline')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(document.querySelector('iframe')).toHaveAttribute('src', url))
    expect(openLocalService).toHaveBeenCalledTimes(2)
})


it.each([
    ['src/example.ts', '/workspace/hapi', '/workspace/hapi/src/example.ts', 'example.ts'],
    ['/workspace/hapi/docs/guide.md', undefined, '/workspace/hapi/docs/guide.md', 'guide.md'],
    ['src/example.ts', 'C:\\work\\hapi', 'C:\\work\\hapi\\src\\example.ts', 'example.ts'],
])('shows only the filename for %s and copies its full path', async (path, workspacePath, fullPath, filename) => {
    copyPath.mockClear()
    const read = vi.fn().mockResolvedValue({ success: true, content: btoa('file content') })
    show({ type: 'file', api: { readSessionFile: read } as unknown as ApiClient,
        source: { type: 'session', sessionId: 's1' }, path, workspacePath })
    const heading = screen.getByRole('heading', { name: filename })
    expect(heading.closest('header')).not.toHaveTextContent(fullPath)
    const copyButton = screen.getByRole('button', { name: 'Copy path' })
    expect(copyButton.querySelector('svg')).toBeInTheDocument()
    expect(copyButton.textContent).toBe('')
    expect(heading.nextElementSibling).toContainElement(copyButton)
    expect(heading).not.toHaveClass('flex-1')
    fireEvent.click(copyButton)
    expect(copyPath).toHaveBeenCalledWith(fullPath)
    await screen.findByText('file content')
    expect(read).toHaveBeenCalledWith('s1', path)
})
