import { useEffect, useMemo, useState } from 'react'
import { BrainCircuit, ChevronRight, Plug } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { useMachines } from '@/hooks/queries/useMachines'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

export default function PluginsPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { machines, isLoading } = useMachines(api, true)
    const machine = useMemo(() => machines.find((item) => item.active) ?? null, [machines])
    const [openVikingEnabled, setOpenVikingEnabled] = useState<boolean | null>(null)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        let active = true
        void api.getOpenVikingPluginSettings()
            .then((settings) => { if (active) setOpenVikingEnabled(settings.enabled) })
            .catch(() => { if (active) setOpenVikingEnabled(true) })
        return () => { active = false }
    }, [api])

    const toggleOpenViking = async () => {
        if (openVikingEnabled === null || saving) return
        const next = !openVikingEnabled
        setOpenVikingEnabled(next)
        setSaving(true)
        try {
            const settings = await api.setOpenVikingPluginEnabled(next)
            setOpenVikingEnabled(settings.enabled)
        } catch {
            setOpenVikingEnabled(!next)
        } finally {
            setSaving(false)
        }
    }

    return <div className="flex h-full min-h-0 flex-col bg-[var(--app-secondary-bg)] text-[var(--app-fg)]">
        <SessionDetailHeader title={t('plugins.title')} onBack={() => navigate({ to: '/sessions' })} />
        <main className="app-scroll-y min-h-0 flex-1">
            <div className="mx-auto w-full max-w-content px-3 pb-[max(var(--app-safe-area-bottom),1rem)] pt-4 sm:px-5">
                <div className="mb-2 px-1 text-[13px] font-medium uppercase tracking-wide text-[var(--app-hint)]">{t('plugins.available')}</div>
                {isLoading || openVikingEnabled === null ? <div className="session-list-skeleton h-24 rounded-[18px]" /> : <div className="flex min-h-24 w-full items-center gap-2 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-sm">
                    <button type="button" disabled={!machine || !openVikingEnabled} onClick={() => machine && navigate({ to: '/plugins/openviking', search: { machineId: machine.id } })} className="flex min-h-20 min-w-0 flex-1 touch-manipulation items-center gap-4 rounded-[14px] px-1 text-left transition-transform active:scale-[0.985] disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]">
                        <BrainCircuit className="h-7 w-7" aria-hidden="true" />
                        <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--app-bg)] ${machine && openVikingEnabled ? 'bg-emerald-500' : 'bg-[var(--app-hint)]'}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-[17px] font-semibold">OpenViking</span>
                        <span className="mt-0.5 block text-sm leading-5 text-[var(--app-hint)]">{!openVikingEnabled ? t('plugins.disabled') : machine ? t('plugins.openViking.ready') : t('plugins.openViking.offline')}</span>
                    </span>
                    {openVikingEnabled ? <ChevronRight className="h-5 w-5 shrink-0 text-[var(--app-hint)]" aria-hidden="true" /> : null}
                    </button>
                    <button type="button" role="switch" aria-checked={openVikingEnabled} aria-label={t('plugins.openViking.toggle')} disabled={saving} onClick={() => void toggleOpenViking()} className={`relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-60 ${openVikingEnabled ? 'bg-emerald-500' : 'bg-[var(--app-border)]'}`}><span className={`absolute top-0.5 h-[27px] w-[27px] rounded-full bg-white shadow transition-transform duration-200 ${openVikingEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} /></button>
                </div>}
                <div className="mt-6 flex items-center justify-center gap-2 text-xs text-[var(--app-hint)]"><Plug className="h-4 w-4" aria-hidden="true" />{t('plugins.moreLater')}</div>
            </div>
        </main>
    </div>
}
