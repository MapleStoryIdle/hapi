import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { usePlatform } from '@/hooks/usePlatform'
import { usePwaUpdateContext } from '@/lib/pwa-update-context'
import { useTranslation } from '@/lib/use-translation'
import { useVoiceOptional } from '@/lib/voice-context'

const TITLE_BAR_ANCHORED_TOP_CLASS = 'top-[calc(env(safe-area-inset-top)+4.75rem)]'
const TITLE_BAR_ANCHORED_STATUS_TOP_CLASS = 'top-[calc(env(safe-area-inset-top)+7.25rem)]'

function getDefaultTopClass(isOnline: boolean, offsetFromTitleBar: boolean): string {
    if (offsetFromTitleBar) {
        return isOnline ? TITLE_BAR_ANCHORED_TOP_CLASS : TITLE_BAR_ANCHORED_STATUS_TOP_CLASS
    }
    return isOnline ? 'top-2' : 'top-10'
}

export function PwaUpdateBanner({
    topClassName,
    offsetFromTitleBar = false,
}: {
    topClassName?: string
    offsetFromTitleBar?: boolean
} = {}) {
    const { t } = useTranslation()
    const { needRefresh, reload } = usePwaUpdateContext()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()

    if (!needRefresh) {
        return null
    }

    const topClass = topClassName ?? getDefaultTopClass(isOnline, offsetFromTitleBar)

    return (
        <div
            data-testid="pwa-update-banner"
            className={`fixed left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50 ${topClass}`}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--app-fg)]">
                        {t('pwa.update.title')}
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        {t('pwa.update.body')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        haptic.impact('light')
                        reload()
                    }}
                    className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80"
                >
                    {t('pwa.update.reload')}
                </button>
            </div>

            <details className="mt-3 border-t border-[var(--app-border)] pt-2">
                <summary className="cursor-pointer text-xs text-[var(--app-link)] active:opacity-60 list-none [&::-webkit-details-marker]:hidden">
                    {t('pwa.update.whyToggle')}
                </summary>
                <p className="mt-2 text-xs text-[var(--app-hint)] leading-relaxed">
                    {t('pwa.update.whyBody')}
                </p>
            </details>
        </div>
    )
}

export function PwaUpdateBannerWithStatusOffset({
    isSyncing,
    isReconnecting,
    offsetFromTitleBar = false,
}: {
    isSyncing: boolean
    isReconnecting: boolean
    offsetFromTitleBar?: boolean
}) {
    const voice = useVoiceOptional()
    const hasTopStatusBanner =
        isSyncing ||
        isReconnecting ||
        Boolean(voice && voice.status === 'error' && voice.errorMessage)

    return (
        <PwaUpdateBanner
            topClassName={hasTopStatusBanner
                ? offsetFromTitleBar ? TITLE_BAR_ANCHORED_STATUS_TOP_CLASS : 'top-12'
                : undefined
            }
            offsetFromTitleBar={offsetFromTitleBar}
        />
    )
}
