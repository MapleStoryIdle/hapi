import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useTranslation } from '@/lib/use-translation'

function getReasonLabel(reason: string, t: (key: string) => string): string {
    if (reason === 'heartbeat-timeout') {
        return t('reconnecting.reason.heartbeatTimeout')
    }
    if (reason === 'visibility-recovery') {
        return t('reconnecting.reason.visibilityRecovery')
    }
    if (reason === 'closed') {
        return t('reconnecting.reason.closed')
    }
    if (reason === 'error') {
        return t('reconnecting.reason.error')
    }
    return reason
}

export function ReconnectingBanner({
    isReconnecting,
    reason,
    offsetFromTitleBar = false
}: {
    isReconnecting: boolean
    reason?: string | null
    offsetFromTitleBar?: boolean
}) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()
    const reasonLabel = reason ? getReasonLabel(reason, t) : null

    // Don't show if offline (OfflineBanner takes precedence) or if not reconnecting
    if (!isReconnecting || !isOnline) {
        return null
    }

    return (
        <div
            className={`pointer-events-none fixed left-0 right-0 z-30 flex items-center justify-center gap-2 bg-amber-500 py-2 text-center text-sm font-medium text-white ${offsetFromTitleBar ? 'top-[calc(var(--app-safe-area-top)+4.75rem)]' : 'top-0'}`}
            role="status"
            aria-live="polite"
        >
            <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
            {t('reconnecting.message')}
            {reasonLabel ? <span className="opacity-90">({reasonLabel})</span> : null}
        </div>
    )
}
