import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { randomId } from '@/lib/randomId'

export type ToastKind = 'success' | 'info' | 'warning' | 'error'

export type Toast = {
    id: string
    title: string
    body: string
    sessionId: string
    url: string
    kind: ToastKind
    durationMs: number | null
}

export type ToastInput = Omit<Toast, 'id' | 'body' | 'sessionId' | 'url' | 'kind' | 'durationMs'> & {
    body?: string
    sessionId?: string
    url?: string
    kind?: ToastKind
    durationMs?: number | null
}

export type ToastContextValue = {
    toasts: Toast[]
    addToast: (toast: ToastInput) => void
    removeToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)
const TOAST_DURATION_MS: Record<ToastKind, number | null> = {
    success: 3000,
    info: 4000,
    warning: 6000,
    error: null
}

function createToastId(): string {
    return randomId()
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([])
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

    const clearTimers = useCallback(() => {
        for (const timer of timersRef.current.values()) {
            clearTimeout(timer)
        }
        timersRef.current.clear()
    }, [])

    useEffect(() => {
        return () => {
            clearTimers()
        }
    }, [clearTimers])

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id))
        const timer = timersRef.current.get(id)
        if (timer) {
            clearTimeout(timer)
            timersRef.current.delete(id)
        }
    }, [])

    const addToast = useCallback((input: ToastInput) => {
        const id = createToastId()
        const kind = input.kind ?? 'info'
        const durationMs = input.durationMs === undefined ? TOAST_DURATION_MS[kind] : input.durationMs
        const toast: Toast = {
            id,
            title: input.title,
            body: input.body ?? '',
            sessionId: input.sessionId ?? '',
            url: input.url ?? '',
            kind,
            durationMs
        }

        // Toast is a single contextual surface, not a notification history.
        // Replacing the old card prevents repeated SSE/API events from piling
        // up over the session header on a phone.
        clearTimers()
        setToasts([toast])
        if (durationMs !== null) {
            timersRef.current.set(id, setTimeout(() => {
                removeToast(id)
            }, durationMs))
        }
    }, [clearTimers, removeToast])

    const value = useMemo<ToastContextValue>(() => ({
        toasts,
        addToast,
        removeToast
    }), [toasts, addToast, removeToast])

    return (
        <ToastContext.Provider value={value}>
            {children}
        </ToastContext.Provider>
    )
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext)
    if (!ctx) {
        throw new Error('useToast must be used within ToastProvider')
    }
    return ctx
}
