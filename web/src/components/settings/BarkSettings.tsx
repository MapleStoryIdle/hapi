import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import { MonitorEnabledSwitch } from '@/monitoring/MonitorEnabledSwitch'

export function BarkSettings() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { addToast } = useToast()
    const client = useQueryClient()
    const [url, setUrl] = useState('')
    const queryKey = ['bark-settings'] as const
    const status = useQuery({ queryKey, queryFn: () => api.getBarkSettings(), staleTime: 60000 })
    const save = useMutation({
        mutationFn: (value: { url?: string; enabled?: boolean }) => api.saveBarkSettings(value.url, value.enabled),
        onSuccess: (data) => { client.setQueryData(queryKey, data); setUrl(''); addToast({ kind: 'success', title: t('settings.bark.saved') }) },
        onError: () => addToast({ kind: 'error', title: t('settings.bark.failed'), body: t('settings.bark.invalid') })
    })
    const test = useMutation({
        mutationFn: () => api.testBarkPush(),
        onSuccess: () => addToast({ kind: 'success', title: t('settings.bark.testSent') }),
        onError: () => addToast({ kind: 'error', title: t('settings.bark.testFailed') })
    })
    const busy = save.isPending || test.isPending
    return <section className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Bell size={18} aria-hidden="true" />{t('settings.bark.title')}</h2>
        <p className="mt-2 text-xs text-[var(--app-hint)]">{t('settings.bark.description')}</p>
        <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (url.trim() && !busy) save.mutate({ url: url.trim() }) }}>
            <label className="block text-xs text-[var(--app-hint)]">{t('settings.bark.url')}
                <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={url} onChange={event => setUrl(event.target.value)} maxLength={2048}
                    placeholder={t(status.data?.configured ? 'settings.bark.configured' : 'settings.bark.placeholder')}
                    className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" />
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <div className="mr-auto min-w-32">
                    <MonitorEnabledSwitch enabled={Boolean(status.data?.configured && status.data?.enabled !== false)} disabled={!status.data?.configured || busy || Boolean(url.trim()) || status.isPending} label={t('settings.bark.enabled')} onChange={enabled => save.mutate({ enabled })} />
                </div>
                <button type="button" disabled={!status.data?.configured || Boolean(url.trim()) || busy || status.isPending}
                    title={url.trim() ? t('settings.bark.saveFirst') : undefined} onClick={() => test.mutate()}
                    className="min-h-11 rounded-xl border border-[var(--app-border)] px-4 text-sm text-[var(--app-link)] disabled:opacity-50">
                    {t(test.isPending ? 'settings.bark.testing' : 'settings.bark.test')}
                </button>
                <button type="submit" disabled={!url.trim() || busy || status.isPending} className="min-h-11 rounded-xl bg-[var(--app-button)] px-4 text-sm font-medium text-[var(--app-button-text)] disabled:opacity-50">{t('settings.bark.save')}</button>
            </div>
        </form>
    </section>
}
