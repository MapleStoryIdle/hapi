import { useEffect, useState } from 'react'

/** Keep the owner alive through the 400ms exit, plus a 20ms render margin. */
export function useDrawerExitPresence(visible: boolean): boolean {
    const [retained, setRetained] = useState(visible)
    useEffect(() => {
        if (visible) { setRetained(true); return }
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            setRetained(false)
            return
        }
        const timer = setTimeout(() => setRetained(false), 420)
        return () => clearTimeout(timer)
    }, [visible])
    return visible || retained
}
