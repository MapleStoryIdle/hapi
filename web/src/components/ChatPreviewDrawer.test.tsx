import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatPreview } from './ChatPreviewContext'
import { I18nProvider } from '@/lib/i18n-context'
import ChatPreviewDrawer from './ChatPreviewDrawer'

vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }))
vi.mock('@/components/CodeBlock', () => ({ CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

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
    const diff = vi.fn().mockResolvedValue({ success: true, stdout: '+new content' })
    show({ type: 'file', api: { readSessionFile: read, getGitDiffFile: diff } as unknown as ApiClient, source: { type: 'session', sessionId: 's1' }, path: 'test.ts', diff: true, staged: true })
    await screen.findByText('+new content')
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
