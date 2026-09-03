import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'
import type { ToolGroupExpansionState, ToolGroupExpansionStates } from '@/components/ToolCard/toolGroupExpansion'

export type HappyChatFileLinkTarget = {
    type: 'native-codex'
    sessionId: string
    machineId: string
}

export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    disabled: boolean
    onRefresh: () => void
    onRetryMessage?: (localId: string) => void
    hasMoreMessages: boolean
    isLoadingMoreMessages: boolean
    loadOlderMessagesPreservingScroll: () => Promise<boolean>
    /** Per-session expansion state for grouped tool cards. */
    toolGroupExpansionStates?: ToolGroupExpansionStates
    setToolGroupExpansionState?: (key: string, state: ToolGroupExpansionState) => void
    /** True from turn start until the current turn receives a completion event. */
    toolGroupRunActive?: boolean
    /** Route message file links through a non-SHAPI-session file source. */
    fileLinkTarget?: HappyChatFileLinkTarget
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return (
        <HappyChatContext.Provider value={props.value}>
            {props.children}
        </HappyChatContext.Provider>
    )
}

export function useOptionalHappyChatContext(): HappyChatContextValue | null {
    return useContext(HappyChatContext)
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useOptionalHappyChatContext()
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}
