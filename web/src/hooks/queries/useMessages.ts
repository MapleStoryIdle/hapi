import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    fetchLatestMessages,
    fetchNewerMessages,
    fetchOlderMessages,
    flushPendingMessages,
    getMessageWindowState,
    setAtBottom as setMessageWindowAtBottom,
    subscribeMessageWindow,
    type MessageWindowState,
} from '@/lib/message-window-store'

export const EMPTY_STATE: MessageWindowState = {
    sessionId: 'unknown',
    messages: [],
    pending: [],
    pendingCount: 0,
    hasMore: false,
    hasNewer: false,
    oldestSeq: null,
    newestSeq: null,
    isLoading: false,
    isLoadingMore: false,
    isLoadingNewer: false,
    warning: null,
    atBottom: true,
    messagesVersion: 0,
}

export function useMessages(api: ApiClient | null, sessionId: string | null): {
    messages: DecryptedMessage[]
    pendingMessages: DecryptedMessage[]
    warning: string | null
    isLoading: boolean
    isLoadingMore: boolean
    isLoadingNewer: boolean
    hasMore: boolean
    hasNewer: boolean
    pendingCount: number
    messagesVersion: number
    loadMore: () => Promise<unknown>
    loadNewer: () => Promise<unknown>
    refetch: () => Promise<unknown>
    flushPending: () => Promise<void>
    setAtBottom: (atBottom: boolean) => void
} {
    const state = useSyncExternalStore(
        useCallback((listener) => {
            if (!sessionId) {
                return () => {}
            }
            return subscribeMessageWindow(sessionId, listener)
        }, [sessionId]),
        useCallback(() => {
            if (!sessionId) {
                return EMPTY_STATE
            }
            return getMessageWindowState(sessionId)
        }, [sessionId]),
        () => EMPTY_STATE
    )

    useEffect(() => {
        if (!api || !sessionId) {
            return
        }
        void fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    const loadMore = useCallback(async () => {
        if (!api || !sessionId) return
        if (!state.hasMore || state.isLoadingMore) return
        await fetchOlderMessages(api, sessionId)
    }, [api, sessionId, state.hasMore, state.isLoadingMore])

    const refetch = useCallback(async () => {
        if (!api || !sessionId) return
        await fetchLatestMessages(api, sessionId)
    }, [api, sessionId])

    const loadNewer = useCallback(async () => {
        if (!api || !sessionId) return
        if (!state.hasNewer || state.isLoadingNewer) return
        await fetchNewerMessages(api, sessionId)
    }, [api, sessionId, state.hasNewer, state.isLoadingNewer])

    const flushPending = useCallback(async () => {
        if (!sessionId) return
        const needsRefresh = flushPendingMessages(sessionId)
        if (needsRefresh && api) {
            await fetchLatestMessages(api, sessionId)
        }
    }, [api, sessionId])

    const setAtBottom = useCallback((atBottom: boolean) => {
        if (!sessionId) return
        setMessageWindowAtBottom(sessionId, atBottom)
    }, [sessionId])

    return {
        messages: state.messages,
        pendingMessages: state.pending,
        warning: state.warning,
        isLoading: state.isLoading,
        isLoadingMore: state.isLoadingMore,
        isLoadingNewer: state.isLoadingNewer,
        hasMore: state.hasMore,
        hasNewer: state.hasNewer,
        pendingCount: state.pendingCount,
        messagesVersion: state.messagesVersion,
        loadMore,
        loadNewer,
        refetch,
        flushPending,
        setAtBottom,
    }
}
