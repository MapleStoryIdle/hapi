import { useSyncExternalStore } from 'react'

const query = '(min-width: 640px)'
function subscribe(callback: () => void) {
    const media = window.matchMedia(query)
    media.addEventListener('change', callback)
    return () => media.removeEventListener('change', callback)
}

/** Same breakpoint as the existing sm: dialog layouts. */
export function useMobileSheet(): boolean {
    return useSyncExternalStore(subscribe, () => !window.matchMedia(query).matches, () => false)
}
