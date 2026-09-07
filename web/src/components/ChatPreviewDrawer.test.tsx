import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { ChatPreview } from './ChatPreviewContext'
import { I18nProvider } from '@/lib/i18n-context'
import { localServiceLaunchHref, parseLocalServiceLaunchHash } from '@/lib/local-service-links'
import ChatPreviewDrawer from './ChatPreviewDrawer'

const copyPath = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copy: copyPath, copied: false }) }))

vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }))
vi.mock('@/components/CodeBlock', () => ({ CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre> }))
afterEach(() => { cleanup(); copyPath.mockClear(); vi.useRealTimers(); vi.restoreAllMocks() })

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
    expect(screen.queryByRole('button', { name: 'Source' })).not.toBeInTheDocument()
    expect(document.querySelector('.chat-detail-tabs')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Changes' })).not.toBeInTheDocument()
})

it.each(['png', 'JPG', 'webp', 'svg'])('previews native %s images as blobs and releases the URL on close', async (extension) => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:native-image')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const read = vi.fn().mockResolvedValue({ success: true, content: btoa('\x89PNG\0\xff') })
    const managed = vi.fn()
    const path = `picture.${extension}`
    const view = show({ type: 'file', api: { readCodexSessionFile: read, getSessionFileBlob: managed } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path })
    expect(await screen.findByRole('img', { name: path })).toHaveAttribute('src', 'blob:native-image')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('n1', 'm1', path)
    expect(managed).not.toHaveBeenCalled()
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob)
    expect((create.mock.calls[0][0] as Blob).size).toBe(6)
    expect((create.mock.calls[0][0] as Blob).type).toMatch(/^image\//)
    expect(document.querySelector('.chat-detail-tabs')).toBeNull()
    view.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:native-image')
})

it('reports image decode failure and permits retry', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:broken-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const read = vi.fn().mockResolvedValue({ success: true, content: btoa('broken') })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'broken.png' })
    fireEvent.error(await screen.findByRole('img'))
    expect(screen.getByRole('alert')).toHaveTextContent('File cannot be displayed')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
})

it('rejects oversized native images before creating a blob URL', async () => {
    const read = vi.fn().mockResolvedValue({ success: true, content: 'A'.repeat(Math.ceil(10 * 1024 * 1024 / 3) * 4 + 4) })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'large.png' })
    expect(await screen.findByRole('alert')).toHaveTextContent('10 MB')
    expect(screen.queryByRole('img')).toBeNull()
})

it('hides a single source tab even when the native file no longer exists', async () => {
    const read = vi.fn().mockResolvedValue({ success: false, error: 'ENOENT: no such file or directory' })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'missing.png' })
    expect(await screen.findByRole('alert')).toHaveTextContent('File not found')
    expect(screen.getByRole('alert')).not.toHaveTextContent('ENOENT')
    expect(document.querySelector('.chat-detail-tabs')).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
})

it('keeps multiple native Markdown views available', async () => {
    const read = vi.fn().mockResolvedValue({ success: true, content: btoa('# document') })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'test.md' })
    await screen.findByText('# document')
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelectorAll('.chat-detail-tabs button')).toHaveLength(2)
})

it.each([
    { error: 'EACCES: permission denied /private/secret.ts', title: 'File access unavailable', retry: false },
    { error: 'EISDIR: /private/folder', title: 'Preview not supported', retry: false },
    { error: 'EFBIG: /private/huge.bin', title: 'File too large to preview', retry: false },
    { error: 'Runner offline /private/session', title: 'Cannot reach the source computer', retry: true },
    { error: 'Unknown failure /private/internal-details', title: 'Preview temporarily unavailable', retry: true },
])('shows a safe state for $title without raw backend details', async ({ error, title, retry }) => {
    const read = vi.fn().mockResolvedValue({ success: false, error })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'file.ts' })
    const state = await screen.findByRole('alert')
    expect(state).toHaveTextContent(title)
    expect(state).not.toHaveTextContent('/private/')
    expect(state.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(Boolean(screen.queryByRole('button', { name: 'Try again' }))).toBe(retry)
    expect(document.querySelector('.chat-detail-tabs')).toBeNull()
})

it.each([
    { content: '', title: 'This file is empty' },
    { content: btoa('binary\0data'), title: 'Preview not supported' },
    { content: '%invalid-base64', title: 'File cannot be displayed' },
])('handles $title as a dedicated state', async ({ content, title }) => {
    const read = vi.fn().mockResolvedValue({ success: true, content })
    show({ type: 'file', api: { readCodexSessionFile: read } as unknown as ApiClient, source: { type: 'native-codex', sessionId: 'n1', machineId: 'm1' }, path: 'file.bin' })
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
})

it('classifies managed image errors from the response body without exposing it', async () => {
    const blob = vi.fn().mockRejectedValue(new ApiError('HTTP 502', 502, undefined, JSON.stringify({ error: 'ENOENT: no such file /private/missing.png' })))
    show({ type: 'file', api: { getSessionFileBlob: blob } as unknown as ApiClient, source: { type: 'session', sessionId: 's1' }, path: 'missing.png' })
    expect(await screen.findByRole('alert')).toHaveTextContent('File not found')
    expect(screen.getByRole('alert')).not.toHaveTextContent(/ENOENT|502|private/)
})

it('shows read failures and retries without leaving the conversation', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('Network error')).mockResolvedValue({ success: true, content: btoa('retry succeeded') })
    show({ type: 'file', api: { readSessionFile: read } as unknown as ApiClient, source: { type: 'session', sessionId: 's1' }, path: 'test.ts' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the source computer')
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

it('shows web content with a copy icon instead of a permanent browser fallback prompt', () => {
    show({ type: 'url', url: 'https://example.com/' })
    expect(screen.getByRole('heading', { name: 'https://example.com/' })).toBeInTheDocument()
    const frame = screen.getByTitle('Web preview')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame.getAttribute('sandbox')).not.toMatch(/allow-same-origin|allow-top-navigation/)
    expect(screen.queryByRole('link', { name: 'Open in browser' })).toBeNull()
    expect(screen.queryByText(/Some sites do not allow/)).toBeNull()
    const copy = screen.getByRole('button', { name: 'Copy link' })
    expect(copy.closest('header')).not.toBeNull()
    expect(copy.textContent).toBe('')
    expect(copy.querySelector('svg')).not.toBeNull()
    fireEvent.click(copy)
    expect(copyPath).toHaveBeenCalledWith('https://example.com/')
    fireEvent.load(frame)
    expect(screen.queryByRole('alert')).toBeNull()
})

it('uses metadata from its own opaque local frame, with safe icon and URL fallbacks', async () => {
    const scope = 'https://hapi.test/preview/' + 'a'.repeat(32) + '/__shapi_local/embed/' + 'b'.repeat(64)
    const openLocalService = vi.fn().mockResolvedValue({ url: scope + '/studio/' })
    show({ type: 'url', url: '/local-service#fixture', localService: { api: { openLocalService } as unknown as ApiClient,
        request: { source: { type: 'session', sessionId: 's1' }, url: 'http://127.0.0.1:1933' } } })
    expect(screen.getByRole('heading', { name: 'http://127.0.0.1:1933' })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('iframe')).toHaveAttribute('src', scope + '/studio/'))
    const frame = document.querySelector('iframe')!
    const send = (data: unknown, source: MessageEventSource | null = frame.contentWindow, origin = 'null') => {
        act(() => { window.dispatchEvent(new MessageEvent('message', { data, source, origin })) })
    }
    const metadata = { type: 'shapi:preview-metadata', title: 'OpenViking Studio', icon: scope + '/studio/favicon-32.png' }
    send(metadata, window)
    send(metadata, frame.contentWindow, 'https://evil.test')
    expect(screen.queryByRole('heading', { name: 'OpenViking Studio' })).toBeNull()
    send(metadata)
    expect(screen.getByRole('heading', { name: 'OpenViking Studio' })).toHaveClass('truncate')
    const icon = document.querySelector('header img')!
    expect(icon).toHaveAttribute('src', metadata.icon)
    expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer')
    fireEvent.error(icon)
    expect(document.querySelector('header img')).toBeNull()
    send({ ...metadata, title: '', icon: 'https://hapi.test/api/auth' })
    expect(screen.getByRole('heading', { name: 'http://127.0.0.1:1933' })).toBeInTheDocument()
    expect(document.querySelector('header img')).toBeNull()
    send({ ...metadata, icon: 'https://evil.test/favicon.png' })
    expect(document.querySelector('header img')).toBeNull()
})

it('shows a recoverable error instead of leaving a failed web frame blank', async () => {
    vi.useFakeTimers()
    show({ type: 'url', url: 'https://example.com/broken' })
    expect(screen.getByTitle('Web preview')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toHaveAttribute('role', 'status')
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load preview')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByTitle('Web preview')).toBeInTheDocument()
    expect(screen.getByText('Loading…')).toHaveAttribute('role', 'status')
})


it.each([
    { type: 'session' as const, sessionId: 's1' },
    { type: 'native-codex' as const, sessionId: 'n1', machineId: 'm1' },
])('loads local services directly and copies the reconnectable $type route, not its embed grant', async (source) => {
    const url = 'https://hapi.test/preview/' + 'a'.repeat(32) + '/__shapi_local/embed/' + 'b'.repeat(64) + '/app'
    const openLocalService = vi.fn().mockResolvedValue({ url, expiresAt: Date.now() + 60_000 })
    const request = { source, url: 'http://localhost:3000/app?q=1#section' }
    const launchHref = localServiceLaunchHref(request.url, source)!
    show({ type: 'url', url: launchHref, localService: { api: { openLocalService } as unknown as ApiClient, request } }, true)
    const copy = screen.getByRole('button', { name: 'Copy link' })
    fireEvent.click(copy)
    const copied = new URL(launchHref, window.location.href)
    expect(copyPath).toHaveBeenCalledWith(copied.href)
    expect(parseLocalServiceLaunchHash(copied.hash)).toEqual(request)
    await waitFor(() => expect(document.querySelector('iframe')).toHaveAttribute('src', url))
    expect(openLocalService).toHaveBeenCalledTimes(1)
    expect(openLocalService).toHaveBeenCalledWith({ presentation: 'embed', ...request })
    expect(document.querySelector('iframe')!.getAttribute('sandbox')).not.toContain('allow-same-origin')
    fireEvent.load(document.querySelector('iframe')!)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Connected to the service/)).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open in browser' })).toBeNull()
    fireEvent.click(copy)
    expect(copyPath).not.toHaveBeenCalledWith(url)
    expect(openLocalService).toHaveBeenCalledTimes(1)
})

it('shows local connection failures and retries inside the drawer', async () => {
    const url = 'https://preview.test/__shapi_local/embed/' + 'b'.repeat(64) + '/'
    const openLocalService = vi.fn().mockRejectedValueOnce(new Error('Runner offline')).mockResolvedValue({ url })
    show({ type: 'url', url: '/local-service#fixture', localService: { api: { openLocalService } as unknown as ApiClient, request: { source: { type: 'session', sessionId: 's1' }, url: 'http://localhost:3000/' } } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to connect to the server')
    expect(screen.queryByText('Runner offline')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(document.querySelector('iframe')).toHaveAttribute('src', url))
    expect(openLocalService).toHaveBeenCalledTimes(2)
})

it.each([
    ['local_service_offline', 'This session’s computer is offline'],
    ['local_service_not_configured', 'Local service access is not enabled'],
    ['local_service_connect_failed', 'Unable to connect to the server'],
])('localizes %s without showing raw transport errors or browser guidance', async (code, message) => {
    const openLocalService = vi.fn().mockRejectedValue(new ApiError('raw internal error', 502, code))
    show({ type: 'url', url: '/local-service#fixture', localService: { api: { openLocalService } as unknown as ApiClient,
        request: { source: { type: 'session', sessionId: 's1' }, url: 'http://localhost:3000/' } } })
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText(/raw internal error|HTTP 502|browser/)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
})

it('keeps failed local frames in the drawer and reconnects even when the grant URL is reused', async () => {
    vi.useFakeTimers()
    const url = 'https://preview.test/__shapi_local/embed/' + 'b'.repeat(64) + '/'
    const openLocalService = vi.fn().mockResolvedValue({ url })
    show({ type: 'url', url: '/local-service#fixture', localService: { api: { openLocalService } as unknown as ApiClient,
        request: { source: { type: 'session', sessionId: 's1' }, url: 'http://localhost:3000/' } } })
    await act(async () => {})
    expect(document.querySelector('iframe')).toHaveAttribute('src', url)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to connect to the server')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })) })
    expect(document.querySelector('iframe')).toHaveAttribute('src', url)
    fireEvent.load(document.querySelector('iframe')!)
    expect(screen.queryByRole('alert')).toBeNull()
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
