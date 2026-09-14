import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from './useTelegram'
import type { AuthSource } from './useAuth'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

function getTelegramInitData(): string | null {
    const tg = getTelegramWebApp()
    if (tg?.initData) {
        return tg.initData
    }

    // Fallback: check URL parameters (for testing or alternative flows)
    const query = new URLSearchParams(window.location.search)
    const tgWebAppData = query.get('tgWebAppData')
    if (tgWebAppData) {
        return tgWebAppData
    }

    const initData = query.get('initData')
    return initData || null
}

function getTokenFromUrlParams(): string | null {
    if (typeof window === 'undefined') return null
    const query = new URLSearchParams(window.location.search)
    return query.get('token')
}

function isLocalDevBrowser(): boolean {
    if (!import.meta.env.DEV) return false
    if (typeof window === 'undefined') return false
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
}

function getDevAccessToken(): string | null {
    if (!isLocalDevBrowser()) return null
    const token = import.meta.env.VITE_HAPI_DEV_ACCESS_TOKEN?.trim()
    return token || null
}

function shouldClearStoredLoginFromUrl(): boolean {
    if (!isLocalDevBrowser()) return false
    return new URLSearchParams(window.location.search).get('clearAuth') === '1'
}

function getAccessTokenKey(baseUrl: string): string {
    return `${ACCESS_TOKEN_PREFIX}${baseUrl}`
}

function getStoredAccessToken(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function storeAccessToken(key: string, token: string): void {
    try {
        localStorage.setItem(key, token)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredAccessToken(key: string): void {
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function clearAllStoredAccessTokens(): void {
    try {
        const keys: string[] = []
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index)
            if (key?.startsWith(ACCESS_TOKEN_PREFIX)) {
                keys.push(key)
            }
        }
        for (const key of keys) {
            localStorage.removeItem(key)
        }
    } catch {
        // Ignore storage errors
    }
}

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    setAccessToken: (token: string) => void
    setCookieSession: () => void
    clearAuth: () => void
} {
    const [authSource, setAuthSource] = useState<AuthSource | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isTelegram, setIsTelegram] = useState(false)
    const retryCountRef = useRef(0)
    const accessTokenKey = useMemo(() => getAccessTokenKey(baseUrl), [baseUrl])

    // Initialize auth source on mount, with retry for delayed Telegram initData
    useEffect(() => {
        let cancelled = false
        let retryTimer: ReturnType<typeof setInterval> | null = null
        retryCountRef.current = 0
        setAuthSource(null)
        setIsTelegram(false)
        setIsLoading(true)

        if (shouldClearStoredLoginFromUrl()) {
            clearAllStoredAccessTokens()
            setIsLoading(false)
            return
        }

        const telegramInitData = getTelegramInitData()

        if (telegramInitData) {
            // Telegram Mini App environment
            setAuthSource({ type: 'telegram', initData: telegramInitData })
            setIsTelegram(true)
            setIsLoading(false)
            return
        }

        const activateBrowserCredential = async (token: string, persistLegacy: boolean): Promise<void> => {
            const sameOrigin = new URL(baseUrl, window.location.origin).origin === window.location.origin
            if (sameOrigin) {
                try {
                    const response = await fetch(new URL('/api/v2/web-sessions', baseUrl).toString(), {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ webToken: token })
                    })
                    if (response.ok && !cancelled) {
                        clearStoredAccessToken(accessTokenKey)
                        setAuthSource({ type: 'cookie' })
                        setIsLoading(false)
                        return
                    }
                } catch {
                    // Legacy credentials may still use the old JWT bridge.
                }
            }
            if (cancelled) return
            if (token.startsWith('spw')) {
                setIsLoading(false)
                return
            }
            if (persistLegacy) storeAccessToken(accessTokenKey, token)
            setAuthSource({ type: 'accessToken', token })
            setIsLoading(false)
        }

        const finishLegacyBootstrap = async () => {
            const urlToken = getTokenFromUrlParams()
            if (urlToken) {
                await activateBrowserCredential(urlToken, true)
                return
            }

            const devToken = getDevAccessToken()
            if (devToken) {
                await activateBrowserCredential(devToken, true)
                return
            }

            const storedToken = getStoredAccessToken(accessTokenKey)
            if (storedToken) {
                await activateBrowserCredential(storedToken, false)
                return
            }

        // Check if we're in a Telegram environment before polling
            if (!isTelegramEnvironment()) {
                setIsLoading(false)
                return
            }

        // Telegram environment detected - poll for delayed initData
        // Telegram WebApp SDK may initialize slightly after page mount
            const maxRetries = 20
            const retryInterval = 250

            retryTimer = setInterval(() => {
                retryCountRef.current += 1
                const initData = getTelegramInitData()

                if (initData) {
                    setAuthSource({ type: 'telegram', initData })
                    setIsTelegram(true)
                    setIsLoading(false)
                    if (retryTimer) clearInterval(retryTimer)
                } else if (retryCountRef.current >= maxRetries) {
                    setIsLoading(false)
                    if (retryTimer) clearInterval(retryTimer)
                }
            }, retryInterval)
        }

        const probeCookieSession = async () => {
            if (new URL(baseUrl, window.location.origin).origin !== window.location.origin) {
                await finishLegacyBootstrap()
                return
            }
            try {
                const response = await fetch(new URL('/api/v2/web-sessions/current', baseUrl).toString(), {
                    credentials: 'include',
                    headers: { accept: 'application/json' }
                })
                if (!cancelled && response.ok) {
                    setAuthSource({ type: 'cookie' })
                    setIsLoading(false)
                    return
                }
            } catch {
                // Fall through to credential migration/bootstrap.
            }
            if (!cancelled) await finishLegacyBootstrap()
        }

        void probeCookieSession()
        return () => {
            cancelled = true
            if (retryTimer) clearInterval(retryTimer)
        }
    }, [accessTokenKey, baseUrl])

    const setAccessToken = useCallback((token: string) => {
        storeAccessToken(accessTokenKey, token)
        setAuthSource({ type: 'accessToken', token })
    }, [accessTokenKey])

    const setCookieSession = useCallback(() => {
        clearStoredAccessToken(accessTokenKey)
        setAuthSource({ type: 'cookie' })
    }, [accessTokenKey])

    const clearAuth = useCallback(() => {
        clearStoredAccessToken(accessTokenKey)
        setAuthSource(null)
    }, [accessTokenKey])

    return {
        authSource,
        isLoading,
        isTelegram,
        setAccessToken,
        setCookieSession,
        clearAuth
    }
}
