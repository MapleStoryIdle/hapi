import { SquareTerminal } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { PluginSwitch } from '@/components/PluginSwitch'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { getTerminalFontSizeOptions, useTerminalFontSize } from '@/hooks/useTerminalFontSize'
import { useLocalPluginEnabled } from '@/hooks/useLocalPluginEnabled'
import { getTerminalToolDisplayModeOptions, useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useTranslation } from '@/lib/use-translation'

export default function TerminalPluginPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const plugin = useLocalPluginEnabled('terminal')
    const { terminalFontSize, setTerminalFontSize } = useTerminalFontSize()
    const { terminalToolDisplayMode, setTerminalToolDisplayMode } = useTerminalToolDisplayMode()

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-secondary-bg)] text-[var(--app-fg)]">
            <SessionDetailHeader title={t('plugins.terminal.title')} onBack={() => navigate({ to: '/plugins' })} />
            <main className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-[720px] space-y-4 px-3 pb-[max(var(--app-safe-area-bottom),1rem)] pt-4 sm:px-5">
                    <section className="flex min-h-16 items-center gap-3 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2 shadow-sm">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[color-mix(in_srgb,#5856d6_13%,transparent)] text-[#5856D6]">
                            <SquareTerminal className="h-6 w-6" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1 text-[16px] font-semibold">{t('plugins.terminal.enabled')}</span>
                        <PluginSwitch checked={plugin.enabled} label={t('plugins.terminal.toggle')} onChange={plugin.setEnabled} />
                    </section>

                    <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                        <label className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
                            <span className="text-[16px]">{t('settings.display.terminalFontSize')}</span>
                            <select
                                aria-label={t('settings.display.terminalFontSize')}
                                value={terminalFontSize}
                                onChange={(event) => setTerminalFontSize(Number(event.target.value) as Parameters<typeof setTerminalFontSize>[0])}
                                className="min-h-9 max-w-[55%] rounded-[10px] border-0 bg-[var(--app-subtle-bg)] px-3 text-right text-[15px] text-[var(--app-link)] outline-none"
                            >
                                {getTerminalFontSizeOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                        <label className="flex min-h-14 items-center justify-between gap-3 border-t border-[var(--app-divider)] px-4 py-3">
                            <span className="text-[16px]">{t('settings.chat.terminalToolDisplay')}</span>
                            <select
                                aria-label={t('settings.chat.terminalToolDisplay')}
                                value={terminalToolDisplayMode}
                                onChange={(event) => setTerminalToolDisplayMode(event.target.value as Parameters<typeof setTerminalToolDisplayMode>[0])}
                                className="min-h-9 max-w-[55%] rounded-[10px] border-0 bg-[var(--app-subtle-bg)] px-3 text-right text-[15px] text-[var(--app-link)] outline-none"
                            >
                                {getTerminalToolDisplayModeOptions().map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
                            </select>
                        </label>
                    </section>
                </div>
            </main>
        </div>
    )
}
