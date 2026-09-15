import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionFilesDrawer } from './SessionFilesDrawer'

vi.mock('@/components/ChatPreviewDrawer', () => ({ FilePreview: ({ preview }: { preview: { path: string } }) => <p>Preview: {preview.path}</p> }))
afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})
const copy = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copy, copied: false }) }))
function show(api: Partial<ApiClient>, native = true, open = true) {
    return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}><I18nProvider>
        <SessionFilesDrawer api={api as ApiClient} source={native ? { type: 'native-codex', sessionId: 'n1', machineId: 'm1' } : { type: 'session', sessionId: 's1' }} cwd="/workspace/project" open={open} onOpenChange={() => {}} />
    </I18nProvider></QueryClientProvider>)
}
it('starts with changes and only loads native directories when selected', async () => {
    const browse = vi.fn().mockResolvedValue({ success: true, isGitRepository: true, status: '? note.md\n', entries: [{ name: 'src', type: 'directory' }] })
    show({ browseCodexSessionFiles: browse })
    const drawer = screen.getByTestId('session-files-drawer')
    expect(drawer).not.toHaveAttribute('data-keyboard-safe-dialog')
    expect(drawer.querySelector('[data-question-drawer-handle]')).not.toBeNull()
    await screen.findByRole('button', { name: /note.md/ })
    expect(screen.getByRole('button', { name: 'Changes 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(browse).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Directories' }))
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    await waitFor(() => expect(browse).toHaveBeenCalledWith('n1', 'm1', { action: 'directory', path: 'src' }))
})

it('uses the available viewport height for the desktop file browser', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
    })))
    show({ browseCodexSessionFiles: vi.fn().mockResolvedValue({ success: true, isGitRepository: false, entries: [] }) })
    const drawer = screen.getByTestId('session-files-drawer')
    expect(drawer).toHaveAttribute('data-desktop-dialog', 'true')
    expect(drawer).toHaveStyle({ height: 'calc(100dvh - 3rem)' })
})
it('hides tabs for non-Git directories and returns from preview in the same sheet', async () => {
    const browse = vi.fn().mockResolvedValue({ success: true, isGitRepository: false, entries: [{ name: 'note.md', type: 'file' }] })
    show({ browseCodexSessionFiles: browse })
    fireEvent.click(await screen.findByRole('button', { name: 'note.md' }))
    await screen.findByText('Preview: note.md')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    await screen.findByRole('button', { name: 'note.md' })
    expect(screen.queryByRole('button', { name: 'Directories' })).toBeNull()
})
it('uses managed-session APIs for managed sessions', async () => {
    const status = vi.fn().mockResolvedValue({ success: true, stdout: '' })
    const numstat = vi.fn().mockResolvedValue({ success: true, stdout: '' })
    show({ getGitStatus: status, getGitDiffNumstat: numstat }, false)
    await screen.findByText('No file changes')
    expect(status).toHaveBeenCalledWith('s1')
    expect(numstat).toHaveBeenCalledTimes(2)
})
it('does not request any data while closed', () => {
    const browse = vi.fn()
    show({ browseCodexSessionFiles: browse }, true, false)
    expect(browse).not.toHaveBeenCalled()
})
it('counts individual changed files, searches filenames and previews the complete path', async () => {
    const browse = vi.fn().mockResolvedValue({ success: true, isGitRepository: true, status: '? src/one.md\n? src/two.md\n' })
    show({ browseCodexSessionFiles: browse })
    await screen.findByRole('button', { name: 'Changes 2' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search changed files' }), { target: { value: 'two.md' } })
    expect(screen.queryByRole('button', { name: /one.md/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /two.md/ }))
    await screen.findByText('Preview: src/two.md')
})

it('uses one breadcrumb row and copies its complete directory path', async () => {
    const browse = vi.fn().mockResolvedValue({ success: true, isGitRepository: false, entries: [{ name: 'src', type: 'directory' }] })
    show({ browseCodexSessionFiles: browse })
    fireEvent.click(await screen.findByRole('button', { name: 'src' }))
    const nav = screen.getByRole('navigation', { name: 'Directory navigation' })
    expect(screen.getAllByRole('navigation', { name: 'Directory navigation' })).toHaveLength(1)
    expect(nav).toHaveAttribute('title', '/workspace/project/src')
    expect(screen.queryByText('/workspace/project/src')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy directory' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith('/workspace/project/src'))
    fireEvent.click(screen.getByRole('button', { name: 'project' }))
    expect(nav).toHaveAttribute('title', '/workspace/project')
})

it('does not show changes before Git detection completes', () => {
    show({ browseCodexSessionFiles: vi.fn(() => new Promise<never>(() => {})) })
    expect(screen.queryByRole('button', { name: /Changes/ })).toBeNull()
    expect(screen.queryByRole('group', { name: 'View' })).toBeNull()
})

it('retains branch and staged/unstaged summary in the changes tab', async () => {
    show({ browseCodexSessionFiles: vi.fn().mockResolvedValue({ success: true, isGitRepository: true, status: '# branch.head feature/files\n? note.md\n' }) })
    expect(await screen.findByRole('region', { name: 'Git' })).toHaveTextContent('feature/files')
    expect(screen.getByRole('region', { name: 'Git' })).toHaveTextContent('0 staged, 1 unstaged')
})
