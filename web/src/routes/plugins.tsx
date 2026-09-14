import { useEffect, useMemo, useState } from 'react'
import { Bell, BrainCircuit, Mic2, Plug, SquareTerminal } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { PluginSwitch } from '@/components/PluginSwitch'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { useLocalPluginEnabled } from '@/hooks/useLocalPluginEnabled'
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
    const [savingNotifications, setSavingNotifications] = useState(false)
    const [barkStatus, setBarkStatus] = useState<{ configured: boolean; enabled: boolean } | null>(null)
    const voicePlugin = useLocalPluginEnabled('voice')
    const terminalPlugin = useLocalPluginEnabled('terminal')

    useEffect(() => {
        let active = true
        void api.getOpenVikingPluginSettings()
            .then((settings) => { if (active) setOpenVikingEnabled(settings.enabled) })
            .catch(() => { if (active) setOpenVikingEnabled(true) })
        return () => { active = false }
    }, [api])

    useEffect(() => {
        let active = true
        void api.getBarkSettings()
            .then((settings) => { if (active) setBarkStatus(settings) })
            .catch(() => { if (active) setBarkStatus({ configured: false, enabled: false }) })
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

    const toggleNotifications = async (enabled: boolean) => {
        if (!barkStatus?.configured || savingNotifications) return
        setSavingNotifications(true)
        setBarkStatus((current) => current ? { ...current, enabled } : current)
        try {
            const settings = await api.saveBarkSettings(undefined, enabled)
            setBarkStatus(settings)
        } catch {
            setBarkStatus((current) => current ? { ...current, enabled: !enabled } : current)
        } finally {
            setSavingNotifications(false)
        }
    }

    return <div className="flex h-full min-h-0 flex-col bg-[var(--app-secondary-bg)] text-[var(--app-fg)]">
        <SessionDetailHeader title={t('plugins.title')} onBack={() => navigate({ to: '/sessions' })} />
        <main className="app-scroll-y min-h-0 flex-1">
            <div className="mx-auto w-full max-w-[720px] px-3 pb-[max(var(--app-safe-area-bottom),1rem)] pt-4 sm:px-5">
                <div className="mb-2 px-1 text-[13px] font-medium uppercase tracking-wide text-[var(--app-hint)]">{t('plugins.available')}</div>
                {isLoading || openVikingEnabled === null ? <div className="session-list-skeleton h-24 rounded-[18px]" /> : <div className="space-y-3">
                <div className="flex min-h-24 w-full items-center gap-2 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-sm">
                    <button type="button" disabled={!machine} onClick={() => machine && navigate({ to: '/plugins/openviking', search: { machineId: machine.id } })} className="flex min-h-20 min-w-0 flex-1 touch-manipulation items-center gap-4 rounded-[14px] px-1 text-left transition-transform active:scale-[0.985] disabled:opacity-55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]">
                        <BrainCircuit className="h-7 w-7" aria-hidden="true" />
                        <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--app-bg)] ${machine && openVikingEnabled ? 'bg-emerald-500' : 'bg-[var(--app-hint)]'}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-[17px] font-semibold">OpenViking</span>
                        <span className="mt-0.5 block text-sm leading-5 text-[var(--app-hint)]">{!openVikingEnabled ? t('plugins.disabled') : machine ? t('plugins.openViking.ready') : t('plugins.openViking.offline')}</span>
                    </span>
                    </button>
                    <PluginSwitch checked={openVikingEnabled} label={t('plugins.openViking.toggle')} disabled={saving} onChange={() => void toggleOpenViking()} />
                </div>
                <div className="flex min-h-24 w-full items-center gap-2 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-sm">
                <button type="button" onClick={() => navigate({ to: '/plugins/voice' })} className="flex min-h-20 min-w-0 flex-1 touch-manipulation items-center gap-4 rounded-[14px] px-1 text-left transition-transform active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] bg-[color-mix(in_srgb,#af52de_13%,transparent)] text-[#AF52DE]">
                        <Mic2 className="h-7 w-7" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-[17px] font-semibold">{t('plugins.voice.title')}</span>
                        <span className="mt-0.5 block text-sm leading-5 text-[var(--app-hint)]">{voicePlugin.enabled ? t('plugins.voice.description') : t('plugins.disabled')}</span>
                    </span>
                </button>
                <PluginSwitch checked={voicePlugin.enabled} label={t('plugins.voice.toggle')} onChange={voicePlugin.setEnabled} />
                </div>
                <div className="flex min-h-24 w-full items-center gap-2 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-sm">
                <button type="button" onClick={() => navigate({ to: '/plugins/notifications' })} className="flex min-h-20 min-w-0 flex-1 touch-manipulation items-center gap-4 rounded-[14px] px-1 text-left transition-transform active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] bg-[color-mix(in_srgb,#ff9500_13%,transparent)] text-[#FF9500]">
                        <Bell className="h-7 w-7" aria-hidden="true" />
                        <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--app-bg)] ${barkStatus?.configured && barkStatus.enabled ? 'bg-emerald-500' : 'bg-[var(--app-hint)]'}`} />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block text-[17px] font-semibold">{t('plugins.notifications.title')}</span>
                        <span className="mt-0.5 block text-sm leading-5 text-[var(--app-hint)]">{barkStatus?.configured ? `Bark · ${t(barkStatus.enabled ? 'plugins.notifications.enabled' : 'plugins.notifications.disabled')}` : t('plugins.notifications.description')}</span>
                    </span>
                </button>
                <PluginSwitch checked={Boolean(barkStatus?.configured && barkStatus.enabled !== false)} label={t('plugins.notifications.toggle')} disabled={!barkStatus?.configured || savingNotifications} onChange={(enabled) => void toggleNotifications(enabled)} />
                </div>
                <div className="flex min-h-24 w-full items-center gap-2 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-sm">
                    <button type="button" onClick={() => navigate({ to: '/plugins/terminal' })} className="flex min-h-20 min-w-0 flex-1 touch-manipulation items-center gap-4 rounded-[14px] px-1 text-left transition-transform active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[13px] bg-[color-mix(in_srgb,#5856d6_13%,transparent)] text-[#5856D6]">
                            <SquareTerminal className="h-7 w-7" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[17px] font-semibold">{t('plugins.terminal.title')}</span>
                            <span className="mt-0.5 block text-sm leading-5 text-[var(--app-hint)]">{terminalPlugin.enabled ? t('plugins.terminal.description') : t('plugins.disabled')}</span>
                        </span>
                    </button>
                    <PluginSwitch checked={terminalPlugin.enabled} label={t('plugins.terminal.toggle')} onChange={terminalPlugin.setEnabled} />
                </div>
                </div>}
                <div className="mt-6 flex items-center justify-center gap-2 text-xs text-[var(--app-hint)]"><Plug className="h-4 w-4" aria-hidden="true" />{t('plugins.moreLater')}</div>
            </div>
        </main>
    </div>
}
