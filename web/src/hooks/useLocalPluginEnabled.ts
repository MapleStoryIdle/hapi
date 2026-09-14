import { useCallback, useEffect, useState } from 'react'

export type LocalPluginId = 'voice' | 'terminal'

const EVENT_NAME = 'hapi:local-plugin-enabled'

function storageKey(plugin: LocalPluginId): string {
    return `hapi-plugin-${plugin}-enabled`
}

export function getLocalPluginEnabled(plugin: LocalPluginId): boolean {
    if (typeof window === 'undefined') return true
    try {
        return localStorage.getItem(storageKey(plugin)) !== 'false'
    } catch {
        return true
    }
}

export function useLocalPluginEnabled(plugin: LocalPluginId): {
    enabled: boolean
    setEnabled: (enabled: boolean) => void
} {
    const [enabled, setEnabledState] = useState(() => getLocalPluginEnabled(plugin))

    useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key === storageKey(plugin)) {
                setEnabledState(event.newValue !== 'false')
            }
        }
        const handleLocalChange = (event: Event) => {
            const detail = (event as CustomEvent<{ plugin: LocalPluginId; enabled: boolean }>).detail
            if (detail?.plugin === plugin) setEnabledState(detail.enabled)
        }
        window.addEventListener('storage', handleStorage)
        window.addEventListener(EVENT_NAME, handleLocalChange)
        return () => {
            window.removeEventListener('storage', handleStorage)
            window.removeEventListener(EVENT_NAME, handleLocalChange)
        }
    }, [plugin])

    const setEnabled = useCallback((next: boolean) => {
        setEnabledState(next)
        try {
            localStorage.setItem(storageKey(plugin), String(next))
        } catch {
            // The current page still keeps the selected state.
        }
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { plugin, enabled: next } }))
    }, [plugin])

    return { enabled, setEnabled }
}
