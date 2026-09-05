import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { localServiceLaunchHref } from '@/lib/local-service-links'
import LocalServicePage from './local-service'

const state = vi.hoisted(() => ({ hash: '', api: { openLocalService: vi.fn() } }))
vi.mock('@tanstack/react-router', () => ({ useLocation: () => state.hash }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: state.api }) }))

beforeEach(() => {
    state.hash = new URL(localServiceLaunchHref('http://localhost:8317/', { type: 'session', sessionId: 'a' })!, 'https://shapi.example').hash
    state.api.openLocalService.mockReset()
})
afterEach(cleanup)

describe('automatic local service opening page', () => {
    it('opens once even under StrictMode, without any confirmation button', () => {
        state.api.openLocalService.mockReturnValue(new Promise(() => {}))
        render(<StrictMode><I18nProvider><LocalServicePage /></I18nProvider></StrictMode>)
        expect(state.api.openLocalService).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('status')).toBeInTheDocument()
        expect(screen.queryByRole('button')).toBeNull()
    })

    it('shows a useful setup error and allows an explicit retry', async () => {
        state.api.openLocalService.mockRejectedValue(new ApiError('setup', 503, 'local_service_not_configured'))
        render(<I18nProvider><LocalServicePage /></I18nProvider>)
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        fireEvent.click(screen.getByRole('button'))
        await waitFor(() => expect(state.api.openLocalService).toHaveBeenCalledTimes(2))
    })

    it('does not call the API for malformed links', async () => {
        state.hash = '#invalid'
        render(<I18nProvider><LocalServicePage /></I18nProvider>)
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(state.api.openLocalService).not.toHaveBeenCalled()
    })
})
