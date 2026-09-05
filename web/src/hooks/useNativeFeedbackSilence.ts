import { useEffect, useState } from 'react'

export const NATIVE_FEEDBACK_SILENCE_MS = 15_000

/** Local observation time, not a remote timestamp or the last HTTP poll. */
export function useNativeFeedbackSilence(activityKey: string, now: number): boolean {
    const [activity, setActivity] = useState(() => ({ key: activityKey, at: Date.now() }))
    useEffect(() => {
        setActivity((current) => current.key === activityKey
            ? current
            : { key: activityKey, at: Date.now() })
    }, [activityKey])

    // Hide immediately on new evidence, before the effect records its time.
    return activity.key === activityKey && now - activity.at >= NATIVE_FEEDBACK_SILENCE_MS
}
