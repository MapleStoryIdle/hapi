import { useSyncExternalStore } from 'react'

const query = '(min-width: 1024px), (min-width: 640px) and (hover: hover) and (pointer: fine)'
function subscribe(callback: () => void) {
    const media = window.matchMedia(query)
    media.addEventListener('change', callback)
    return () => media.removeEventListener('change', callback)
}

/** Phones keep sheets in landscape; large screens and wide precise-pointer viewports are desktop. */
export function shouldUseMobileSheet(matchMedia: typeof window.matchMedia): boolean {
    return !matchMedia(query).matches
}

export function useMobileSheet(): boolean {
    return useSyncExternalStore(subscribe, () => shouldUseMobileSheet(window.matchMedia), () => false)
}
