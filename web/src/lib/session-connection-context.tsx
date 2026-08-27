import { createContext, useContext, type ReactNode } from 'react'

export type SessionConnectionHealth = 'connected' | 'recovering' | 'degraded' | 'offline'

export type SessionConnectionContextValue = {
    health: SessionConnectionHealth
    recover: () => Promise<void>
}

const SessionConnectionContext = createContext<SessionConnectionContextValue | null>(null)

/**
 * Current-session stream health and the explicit recovery action.  This stays
 * separate from AppContext because it only exists while the app owns a live
 * session detail route.
 */
export function SessionConnectionProvider(props: {
    value: SessionConnectionContextValue
    children: ReactNode
}) {
    return (
        <SessionConnectionContext.Provider value={props.value}>
            {props.children}
        </SessionConnectionContext.Provider>
    )
}

export function useSessionConnection(): SessionConnectionContextValue | null {
    return useContext(SessionConnectionContext)
}
