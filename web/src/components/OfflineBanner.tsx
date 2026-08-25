import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useTranslation } from '@/lib/use-translation'

export function OfflineBanner({ offsetFromTitleBar = false }: { offsetFromTitleBar?: boolean }) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    if (isOnline) {
        return null
    }

    return (
        <div
            className={`pointer-events-none fixed left-0 right-0 z-30 bg-amber-500 py-2 text-center text-sm font-medium text-white ${offsetFromTitleBar ? 'top-[calc(var(--app-safe-area-top)+4.75rem)]' : 'top-0'}`}
            role="status"
            aria-live="polite"
        >
            {t('offline.message')}
        </div>
    )
}
