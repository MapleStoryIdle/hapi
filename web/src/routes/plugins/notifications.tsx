import { Bell, Check } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { BarkSettings } from '@/components/settings/BarkSettings'
import { useTranslation } from '@/lib/use-translation'

export default function NotificationsPluginPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-secondary-bg)] text-[var(--app-fg)]">
            <SessionDetailHeader title={t('plugins.notifications.title')} onBack={() => navigate({ to: '/plugins' })} />
            <main className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-[720px] space-y-4 px-3 pb-[max(var(--app-safe-area-bottom),1rem)] pt-4 sm:px-5">
                    <section>
                        <h2 className="mb-2 px-1 text-[13px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                            {t('plugins.notifications.channels')}
                        </h2>
                        <button type="button" aria-pressed="true" className="flex min-h-14 w-full touch-manipulation items-center gap-3 rounded-[16px] border border-[var(--app-link)] bg-[var(--app-bg)] px-4 py-3 text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]">
                                <Bell className="h-5 w-5" aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1 text-[16px] font-medium">Bark</span>
                            <Check className="h-5 w-5 shrink-0 text-[var(--app-link)]" aria-label={t('plugins.notifications.selected')} />
                        </button>
                    </section>
                    <BarkSettings />
                </div>
            </main>
        </div>
    )
}
