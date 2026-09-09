import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { DirectoryPickerDrawer } from './DirectoryPickerDrawer'

afterEach(cleanup)
it('filters directories and returns the selected path without creating a session', async () => {
    const list = vi.fn().mockResolvedValue({ success: true, entries: [{ name: 'src', type: 'directory' }, { name: 'docs', type: 'directory' }, { name: 'README.md', type: 'file' }] })
    const select = vi.fn()
    const close = vi.fn()
    const machines = [{ id: 'm1', active: true, metadata: { host: 'Mac', workspaceRoots: ['/workspace'] } }] as Machine[]
    render(<QueryClientProvider client={new QueryClient()}><I18nProvider><DirectoryPickerDrawer open onOpenChange={close} onSelect={select} api={{ listMachineDirectory: list } as unknown as ApiClient} machines={machines} machinesLoading={false} initialMachineId="m1" /></I18nProvider></QueryClientProvider>)
    await screen.findByRole('button', { name: 'src' })
    expect(screen.queryByRole('button', { name: 'README.md' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this directory' }), { target: { value: 'src' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'docs' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    await screen.findByText('/workspace/src')
    fireEvent.click(screen.getByRole('button', { name: 'Use this directory' }))
    expect(select).toHaveBeenCalledWith('m1', '/workspace/src')
    expect(close).toHaveBeenCalledWith(false)
})
