import { useEffect, useState } from 'react'
import { localDateKey } from '@/lib/shareTimeline'

const systemNow = (): Date => new Date()

export function useLocalDayKey(now: () => Date = systemNow): string {
    const [dayKey, setDayKey] = useState(() => localDateKey(now()))

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined

        const refresh = (): void => {
            if (timer !== undefined) clearTimeout(timer)
            const current = now()
            setDayKey(localDateKey(current))
            const nextMidnight = new Date(
                current.getFullYear(),
                current.getMonth(),
                current.getDate() + 1
            )
            timer = setTimeout(refresh, Math.max(1, nextMidnight.getTime() - current.getTime() + 50))
        }
        const refreshWhenVisible = (): void => {
            if (document.visibilityState === 'visible') refresh()
        }

        refresh()
        document.addEventListener('visibilitychange', refreshWhenVisible)
        return () => {
            if (timer !== undefined) clearTimeout(timer)
            document.removeEventListener('visibilitychange', refreshWhenVisible)
        }
    }, [now])

    return dayKey
}
