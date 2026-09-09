import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { BarkSettings } from './BarkSettings'

const api = { getBarkSettings: vi.fn(), saveBarkSettings: vi.fn(), testBarkPush: vi.fn() }
const addToast = vi.fn()
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api }) }))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast }) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Bark settings', () => {
    it('tests saved settings, blocks unsaved edits and duplicate clicks, and reports acceptance', async () => {
        api.getBarkSettings.mockResolvedValue({ configured: true })
        let finish!: () => void
        api.testBarkPush.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
        render(<QueryClientProvider client={new QueryClient()}><I18nProvider><BarkSettings /></I18nProvider></QueryClientProvider>)
        const button = screen.getByRole('button', { name: 'Test' })
        await waitFor(() => expect(button).not.toBeDisabled())
        const input = screen.getByLabelText('Bark URL')
        fireEvent.change(input, { target: { value: 'https://api.day.app/NEW_DEVICE_KEY' } })
        expect(button).toBeDisabled()
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.click(button)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled())
        expect(screen.getByRole('switch', { name: 'Enabled' })).toBeDisabled()
        fireEvent.click(button)
        expect(api.testBarkPush).toHaveBeenCalledTimes(1)
        finish()
        await waitFor(() => expect(addToast).toHaveBeenCalledWith({ kind: 'success', title: 'Test notification sent. Check your phone.' }))
        expect(api.saveBarkSettings).not.toHaveBeenCalled()
    })
    it('shows a safe error toast when testing fails', async () => {
        api.getBarkSettings.mockResolvedValue({ configured: true })
        api.testBarkPush.mockRejectedValue(new Error('secret transport details'))
        render(<QueryClientProvider client={new QueryClient()}><I18nProvider><BarkSettings /></I18nProvider></QueryClientProvider>)
        const button = screen.getByRole('button', { name: 'Test' })
        await waitFor(() => expect(button).not.toBeDisabled())
        fireEvent.click(button)
        await waitFor(() => expect(addToast).toHaveBeenCalledWith({ kind: 'error', title: 'Could not send. Check your Bark settings and try again.' }))
    })
    it('loads only configuration status, saves an explicit URL, and can disable', async () => {
        api.getBarkSettings.mockResolvedValue({ configured: false })
        api.saveBarkSettings.mockResolvedValue({ configured: true })
        render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><BarkSettings /></I18nProvider></QueryClientProvider>)
        await waitFor(() => expect(api.getBarkSettings).toHaveBeenCalled())
        expect(api.saveBarkSettings).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
        const input = screen.getByLabelText('Bark URL')
        fireEvent.change(input, { target: { value: 'https://api.day.app/TEST_DEVICE_KEY/title/body' } })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled())
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(screen.getByRole('switch', { name: 'Enabled' })).toBeInTheDocument())
        expect(api.saveBarkSettings).toHaveBeenCalledWith('https://api.day.app/TEST_DEVICE_KEY/title/body', undefined)
        expect(input).toHaveValue('')
        api.saveBarkSettings.mockResolvedValue({ configured: true, enabled: false })
        fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
        await waitFor(() => expect(screen.getByRole('switch', { name: 'Enabled' })).not.toBeChecked())
        expect(api.saveBarkSettings).toHaveBeenLastCalledWith(undefined, false)
    })
})
