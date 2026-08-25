import { useEffect } from 'react'
import { useVoiceOptional } from '@/lib/voice-context'

export function VoiceErrorBanner({ offsetFromTitleBar = false }: { offsetFromTitleBar?: boolean }) {
    const voice = useVoiceOptional()

    const shouldShow = voice && voice.status === 'error' && voice.errorMessage

    useEffect(() => {
        if (!shouldShow || !voice) return

        const timer = setTimeout(() => {
            voice.setStatus('disconnected')
        }, 3000)

        return () => clearTimeout(timer)
    }, [shouldShow, voice])

    if (!shouldShow) {
        return null
    }

    return (
        <div
            className={`pointer-events-none fixed left-0 right-0 z-30 flex items-center justify-center border-b border-red-600 bg-red-500 py-2 text-center text-sm font-medium text-white ${offsetFromTitleBar ? 'top-[calc(var(--app-safe-area-top)+4.75rem)]' : 'top-0'}`}
            role="status"
            aria-live="polite"
        >
            {voice.errorMessage}
        </div>
    )
}
