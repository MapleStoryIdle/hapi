import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

export function SyncingBanner({ isSyncing, offsetFromTitleBar = false }: { isSyncing: boolean; offsetFromTitleBar?: boolean }) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()

    // Don't show syncing banner when offline (OfflineBanner takes precedence)
    if (!isSyncing || !isOnline) {
        return null
    }

    return (
        <div
            className={`pointer-events-none fixed left-0 right-0 z-30 flex items-center justify-center gap-2 border-b border-[var(--app-divider)] bg-[var(--app-banner-bg)] py-2 text-center text-sm font-medium text-[var(--app-banner-text)] ${offsetFromTitleBar ? 'top-[calc(var(--app-safe-area-top)+4.75rem)]' : 'top-0'}`}
            role="status"
            aria-live="polite"
        >
            <Spinner size="sm" label={null} className="text-[var(--app-banner-text)]" />
            {t('syncing.title')}
        </div>
    )
}
