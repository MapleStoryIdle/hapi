import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { openLocalServiceInTab } from './open-local-service'

const input = { source: { type: 'native-codex' as const, sessionId: 'native', machineId: 'runner' }, url: 'http://localhost:8317/settings' }
const labels = { title: 'Local service', opening: 'Connecting…', retry: 'Retry', error: (key: string) => key }

function popup() {
    const tab = { document: document.implementation.createHTMLDocument(), opener: { secret: 'not for the service' } as unknown, closed: false, location: { replace: vi.fn() }, close: vi.fn() }
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window)
    return { tab, open }
}

afterEach(() => vi.restoreAllMocks())

describe('authenticated local service handoff', () => {
    it('opens during the tap and authenticates in the original chat without a second login', async () => {
        const { tab, open } = popup()
        let finish!: (result: { url: string; expiresAt: number }) => void
        const api = { openLocalService: vi.fn(() => new Promise<{ url: string; expiresAt: number }>((resolve) => { finish = resolve })) }
        expect(openLocalServiceInTab(api, input, labels)).toBe(true)
        expect(open).toHaveBeenCalledWith('about:blank', '_blank')
        expect(open.mock.invocationCallOrder[0]).toBeLessThan(api.openLocalService.mock.invocationCallOrder[0])
        expect(api.openLocalService).toHaveBeenCalledWith(input)
        expect(tab.opener).toBeNull()
        expect(tab.document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
        expect(tab.document.body.textContent).toContain('Connecting…')
        expect(tab.document.querySelector('button')?.hidden).toBe(true)
        const url = 'https://abc.preview.example/__shapi_local/open#single-use-ticket'
        finish({ url, expiresAt: Date.now() + 1_000 })
        await vi.waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(url))
    })

    it('returns to normal navigation when new windows are blocked, with no stray tunnel request', () => {
        vi.spyOn(window, 'open').mockReturnValue(null)
        const api = { openLocalService: vi.fn() }
        expect(openLocalServiceInTab(api, input, labels)).toBe(false)
        expect(api.openLocalService).not.toHaveBeenCalled()
    })

    it('shows a safe error and retries in the same tab, preventing repeated submissions', async () => {
        const { tab, open } = popup()
        const api = { openLocalService: vi.fn().mockRejectedValueOnce(new ApiError('sensitive diagnostics', 503, 'local_service_not_configured')).mockReturnValue(new Promise(() => {})) }
        openLocalServiceInTab(api, input, labels)
        await vi.waitFor(() => expect(tab.document.querySelector('[role="alert"]')?.textContent).toBe('localService.notConfigured'))
        expect(tab.document.body.textContent).not.toContain('sensitive diagnostics')
        const retry = tab.document.querySelector('button')!
        expect(retry.hidden).toBe(false)
        retry.click()
        retry.click()
        expect(api.openLocalService).toHaveBeenCalledTimes(2)
        expect(open).toHaveBeenCalledTimes(1)
        expect(retry.disabled).toBe(true)
    })

    it('does not navigate a tab the user has already closed', async () => {
        const { tab } = popup()
        const api = { openLocalService: vi.fn().mockResolvedValue({ url: 'https://preview.example/', expiresAt: 1 }) }
        openLocalServiceInTab(api, input, labels)
        tab.closed = true
        await Promise.resolve()
        expect(tab.location.replace).not.toHaveBeenCalled()
    })

    it('rejects non-web redirect URLs', async () => {
        const { tab } = popup()
        openLocalServiceInTab({ openLocalService: vi.fn().mockResolvedValue({ url: 'javascript:alert(1)', expiresAt: 1 }) }, input, labels)
        await vi.waitFor(() => expect(tab.document.querySelector('[role="alert"]')).not.toBeNull())
        expect(tab.location.replace).not.toHaveBeenCalled()
    })
})
