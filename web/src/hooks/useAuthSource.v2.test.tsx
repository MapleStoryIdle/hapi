import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthSource } from './useAuthSource'

afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
})

describe('useAuthSource cookie migration', () => {
    it('uses an existing HttpOnly Web session without a browser credential', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
        vi.stubGlobal('fetch', fetcher)
        const { result } = renderHook(() => useAuthSource(window.location.origin))

        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'cookie' }))
        expect(localStorage.length).toBe(0)
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('exchanges a stored legacy credential for a cookie and removes it', async () => {
        const baseUrl = window.location.origin
        const storageKey = `hapi_access_token::${baseUrl}`
        localStorage.setItem(storageKey, 'legacy-secret')
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(new Response('{}', { status: 201 }))
        vi.stubGlobal('fetch', fetcher)
        const { result } = renderHook(() => useAuthSource(baseUrl))

        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'cookie' }))
        expect(localStorage.getItem(storageKey)).toBeNull()
        const migrationRequest = fetcher.mock.calls[1]
        expect(migrationRequest?.[1]).toMatchObject({
            method: 'POST',
            credentials: 'include',
            body: JSON.stringify({ webToken: 'legacy-secret' })
        })
    })
})
