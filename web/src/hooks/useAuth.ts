import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient, ApiError } from '@/api/client'
import type { AuthResponse } from '@/types/api'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }
    | { type: 'cookie' }

function getAuthSourceKey(authSource: AuthSource | null, baseUrl: string): string | null {
    if (!authSource) return null
    if (authSource.type === 'cookie') return `${baseUrl}\u0000cookie`
    return authSource.type === 'telegram'
        ? `${baseUrl}\u0000telegram\u0000${authSource.initData}`
        : `${baseUrl}\u0000access-token\u0000${authSource.token}`
}

function decodeJwtExpMs(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const binary = globalThis.atob(payloadBase64)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown }
        if (typeof payload.exp !== 'number') return null
        return payload.exp * 1000
    } catch {
        return null
    }
}

function getAuthPayload(source: AuthSource): { initData: string } | { accessToken: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    if (source.type === 'accessToken') return { accessToken: source.token }
    throw new Error('Cookie sessions do not use the legacy auth endpoint')
}

function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    bind: (accessToken: string) => Promise<void>
} {
    const [token, setToken] = useState<string | null>(null)
    const [user, setUser] = useState<AuthResponse['user'] | null>(null)
    const [authenticatedSourceKey, setAuthenticatedSourceKey] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [needsBinding, setNeedsBinding] = useState<boolean>(false)
    const refreshPromiseRef = useRef<Promise<string | null> | null>(null)
    const tokenRef = useRef<string | null>(null)
    const lastRefreshAttemptRef = useRef<number>(0)
    const authenticatedSourceKeyRef = useRef<string | null>(null)
    const sourceKey = getAuthSourceKey(authSource, baseUrl)
    const sourceKeyRef = useRef(sourceKey)

    // Stable reference for auth source to use in effects
    const authSourceRef = useRef(authSource)
    authSourceRef.current = authSource
    tokenRef.current = token
    sourceKeyRef.current = sourceKey

    const hasCurrentSourceToken = token !== null && sourceKey !== null && authenticatedSourceKey === sourceKey
    const currentToken = hasCurrentSourceToken ? token : null
    const currentUser = hasCurrentSourceToken ? user : null

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
    }): Promise<string | null> => {
        const currentSource = authSourceRef.current
        const currentToken = tokenRef.current
        const currentSourceKey = sourceKeyRef.current
        if (!currentSource) {
            return null
        }

        const expMs = currentToken ? decodeJwtExpMs(currentToken) : null
        const minTtlMs = options?.minTtlMs ?? 0
        const now = Date.now()
        const ttlMs = expMs ? expMs - now : null
        const needsRefreshForTtl = ttlMs !== null && ttlMs <= minTtlMs
        const tokenBelongsToCurrentSource = authenticatedSourceKeyRef.current === currentSourceKey
        if (!options?.force && tokenBelongsToCurrentSource && ttlMs !== null && ttlMs > minTtlMs) {
            return currentToken
        }
        if (!options?.force && tokenBelongsToCurrentSource && !needsRefreshForTtl && now - lastRefreshAttemptRef.current < 15_000) {
            return currentToken
        }
        if (refreshPromiseRef.current) {
            return await refreshPromiseRef.current
        }

        const run = async () => {
            lastRefreshAttemptRef.current = now

            try {
                const client = new ApiClient('', { baseUrl })
                const auth = currentSource.type === 'cookie'
                    ? await client.authenticateWebSession()
                    : await client.authenticate(getAuthPayload(currentSource))
                if (sourceKeyRef.current !== currentSourceKey) {
                    return null
                }
                const effectiveToken = currentSource.type === 'cookie' ? '__cookie_session__' : auth.token
                tokenRef.current = effectiveToken
                setToken(effectiveToken)
                setUser(auth.user)
                authenticatedSourceKeyRef.current = currentSourceKey
                setAuthenticatedSourceKey(currentSourceKey)
                setError(null)
                setNeedsBinding(false)
                return auth.token
            } catch (error) {
                if (currentSource.type === 'telegram' && isNotBoundError(error)) {
                    if (sourceKeyRef.current !== currentSourceKey) {
                        return null
                    }
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    authenticatedSourceKeyRef.current = null
                    setAuthenticatedSourceKey(null)
                    setError(null)
                    setNeedsBinding(true)
                    return null
                }
                const isExpired = expMs ? Date.now() >= expMs : false
                if (options?.hardFail || isExpired) {
                    if (sourceKeyRef.current !== currentSourceKey) {
                        return null
                    }
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    authenticatedSourceKeyRef.current = null
                    setAuthenticatedSourceKey(null)
                    const msg = currentSource.type === 'telegram'
                        ? 'Session expired. Reopen the Mini App from Telegram.'
                        : 'Session expired. Please login again.'
                    setError(msg)
                }
                return null
            }
        }

        const refreshPromise = run()
        refreshPromiseRef.current = refreshPromise

        try {
            return await refreshPromise
        } finally {
            if (refreshPromiseRef.current === refreshPromise) {
                refreshPromiseRef.current = null
            }
        }
    }, [baseUrl])

    const bind = useCallback(async (accessToken: string) => {
        const currentSource = authSourceRef.current
        const currentSourceKey = sourceKeyRef.current
        if (!currentSource || currentSource.type !== 'telegram') {
            setError('Binding is only supported in Telegram.')
            return
        }

        setIsLoading(true)
        setError(null)
        try {
            const client = new ApiClient('', { baseUrl })
            const auth = await client.bind({ initData: currentSource.initData, accessToken })
            if (sourceKeyRef.current !== currentSourceKey) {
                return
            }
            tokenRef.current = auth.token
            setToken(auth.token)
            setUser(auth.user)
            authenticatedSourceKeyRef.current = currentSourceKey
            setAuthenticatedSourceKey(currentSourceKey)
            setNeedsBinding(false)
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Binding failed')
            throw error
        } finally {
            setIsLoading(false)
        }
    }, [baseUrl])

    // Keep the ApiClient referentially stable across token *refreshes*: the client always reads
    // the live token via getToken (tokenRef), so it never needs rebuilding when the token value
    // changes — only when auth presence toggles (login/logout). Rebuilding on every refresh churns
    // `api`'s identity, which remounts everything keyed on it (VoiceBackendSession `[props.api]`,
    // GeneratedImageCard `[ctx.api, ...]`) and drives the remount/refetch storm. Issue #927.
    const hasToken = currentToken !== null
    const api = useMemo(() => (
        hasToken
            ? new ApiClient(authSource?.type === 'cookie' ? '' : tokenRef.current ?? '', {
                baseUrl,
                getToken: () => tokenRef.current,
                onUnauthorized: () => refreshAuth({ force: true }),
                useCookieSession: authSource?.type === 'cookie'
            })
            : null
    ), [authSource?.type, baseUrl, refreshAuth, hasToken])

    useEffect(() => {
        let isCancelled = false

        async function run() {
            if (!authSource) {
                // No auth source - waiting for login
                tokenRef.current = null
                setToken(null)
                setUser(null)
                authenticatedSourceKeyRef.current = null
                setAuthenticatedSourceKey(null)
                setNeedsBinding(false)
                return
            }

            setIsLoading(true)
            setError(null)
            setNeedsBinding(false)
            tokenRef.current = null
            setToken(null)
            setUser(null)
            authenticatedSourceKeyRef.current = null
            setAuthenticatedSourceKey(null)
            try {
                const client = new ApiClient('', { baseUrl }) // temporary for auth call
                const auth = authSource.type === 'cookie'
                    ? await client.authenticateWebSession()
                    : await client.authenticate(getAuthPayload(authSource))
                if (isCancelled) return
                if (sourceKeyRef.current !== sourceKey) return
                const effectiveToken = authSource.type === 'cookie' ? '__cookie_session__' : auth.token
                tokenRef.current = effectiveToken
                setToken(effectiveToken)
                setUser(auth.user)
                authenticatedSourceKeyRef.current = sourceKey
                setAuthenticatedSourceKey(sourceKey)
                setNeedsBinding(false)
            } catch (e) {
                if (isCancelled) return
                if (authSource.type === 'telegram' && isNotBoundError(e)) {
                    tokenRef.current = null
                    setToken(null)
                    setUser(null)
                    authenticatedSourceKeyRef.current = null
                    setAuthenticatedSourceKey(null)
                    setError(null)
                    setNeedsBinding(true)
                    return
                }
                setNeedsBinding(false)
                setError(e instanceof Error ? e.message : 'Auth failed')
            } finally {
                if (!isCancelled) {
                    setIsLoading(false)
                }
            }
        }

        run()

        return () => {
            isCancelled = true
        }
    }, [authSource, baseUrl, sourceKey])

    useEffect(() => {
        tokenRef.current = null
        refreshPromiseRef.current = null
        lastRefreshAttemptRef.current = 0
        setToken(null)
        setUser(null)
        authenticatedSourceKeyRef.current = null
        setAuthenticatedSourceKey(null)
        setError(null)
        setNeedsBinding(false)
    }, [baseUrl])

    useEffect(() => {
        if (!currentToken || !authSource) {
            return
        }

        const expMs = decodeJwtExpMs(currentToken)
        if (!expMs) {
            return
        }

        let isCancelled = false
        let timeout: ReturnType<typeof setTimeout> | null = null

        const schedule = (delayMs: number) => {
            if (timeout) {
                clearTimeout(timeout)
            }
            timeout = setTimeout(() => void refresh(), Math.max(0, delayMs))
        }

        const refresh = async () => {
            if (isCancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (isCancelled) return
            if (!refreshed && Date.now() < expMs) {
                schedule(15_000)
            }
        }

        schedule(expMs - 60_000 - Date.now())

        return () => {
            isCancelled = true
            if (timeout) {
                clearTimeout(timeout)
            }
        }
    }, [authSource, currentToken, refreshAuth])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const handleActive = () => {
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                handleActive()
            }
        }

        window.addEventListener('focus', handleActive)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleActive)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    return { token: currentToken, user: currentUser, api, isLoading, error, needsBinding, bind }
}
