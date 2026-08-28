import { createContext, useContext, type ReactNode } from 'react'

export type NativeCodexRealtimeContextValue = {
    /** The app-wide SSE connection that carries native transcript invalidations. */
    connected: boolean
}

const NativeCodexRealtimeContext = createContext<NativeCodexRealtimeContextValue | null>(null)

export function NativeCodexRealtimeProvider(props: {
    value: NativeCodexRealtimeContextValue
    children: ReactNode
}) {
    return (
        <NativeCodexRealtimeContext.Provider value={props.value}>
            {props.children}
        </NativeCodexRealtimeContext.Provider>
    )
}

export function useNativeCodexRealtime(): NativeCodexRealtimeContextValue | null {
    return useContext(NativeCodexRealtimeContext)
}
