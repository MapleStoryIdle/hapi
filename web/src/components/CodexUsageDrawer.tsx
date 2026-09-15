import { ArrowDownToLine, ArrowUpFromLine, Database, RefreshCw, Server, UserRound } from 'lucide-react'
import {
    getCodexBlendedTotal,
    getCodexNonCachedInput,
    type CodexTokenUsage,
    type CodexUsageAccount
} from '@hapi/protocol/codexUsage'
import { BottomDrawer } from './ui/BottomDrawer'
import { AgentFlavorIcon } from './AgentFlavorIcon'
import { useTranslation } from '@/lib/use-translation'

export function formatCodexPlan(plan: string | null | undefined): string | null {
    if (!plan) return null
    const names: Record<string, string> = { pro: 'Pro', plus: 'Plus', free: 'Free', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu' }
    return names[plan.toLowerCase()] ?? plan
}

export function formatCodexAccountExpiry(expiresAt: number | null | undefined, locale: string): string | null {
    if (!expiresAt || !Number.isFinite(expiresAt)) return null
    const date = new Date(expiresAt)
    if (Number.isNaN(date.getTime())) return null
    return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    }).format(date)
}

function Bar({ value, color }: { value: number; color: string }) {
    return <div className="h-1.5 overflow-hidden rounded-full bg-[var(--app-border)]" aria-hidden="true">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
}

export function CodexUsageDrawer(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    account?: CodexUsageAccount | null
    usage?: CodexTokenUsage | null
    rows: { label: string; remaining: number | null; resetAt: string | null }[]
    updatedAt: string | null
    isFetching: boolean
    error: string | null
    onRefresh?: () => void
}) {
    const { t, locale } = useTranslation()
    const usage = props.usage
    const mode = props.account?.mode ?? 'unknown'
    const plan = mode === 'oauth' ? formatCodexPlan(props.account?.plan) : null
    const expiry = formatCodexAccountExpiry(props.account?.expiresAt, locale)
    const modeLabel = t(`usage.connection.${mode}`)
    const AccountIcon = mode === 'api' ? Server : UserRound
    const accountLabel = props.account?.label ?? t('usage.account')
    const accountDetails = [
        plan,
        modeLabel,
        mode === 'oauth' && expiry ? `${t('usage.expiresAt')} · ${expiry}` : null
    ].filter(Boolean).join(' · ')
    const number = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
    const exact = (value: number | null | undefined) => value == null ? undefined : new Intl.NumberFormat(locale).format(value)
    const ratio = usage?.input && usage.cachedInput != null ? usage.cachedInput / usage.input * 100 : null
    const nonCachedInput = usage ? getCodexNonCachedInput(usage) : null
    const blendedTotal = usage ? getCodexBlendedTotal(usage) : null
    const displayedInput = nonCachedInput ?? usage?.input
    const displayedTotal = blendedTotal ?? usage?.total
    const usesBlendedUsage = blendedTotal !== null
    const percent = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value) + '%'
    const group = 'rounded-2xl bg-[var(--app-bg)] p-4'
    const heading = 'mb-2 px-1 text-[13px] font-semibold text-[var(--app-hint)]'
    return <BottomDrawer open={props.open} onOpenChange={props.onOpenChange} title={t('session.header.codexLimits.title')} density="compact" bodyClassName="px-4 pb-4">
        <div className="space-y-4 text-[15px] text-[var(--app-fg)]" data-testid="codex-usage-details">
            <section className={`${group} space-y-2.5`} aria-label={t('usage.account')}>
                <div className="flex min-w-0 items-center gap-2" data-testid="codex-usage-account-email-row">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-link)]"><AccountIcon className="h-3.5 w-3.5" aria-hidden="true" /></div>
                    <span className="min-w-0 flex-1 truncate font-semibold" title={accountLabel}>{accountLabel}</span>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-[13px] text-[var(--app-hint)]" data-testid="codex-usage-account-plan-row">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center" aria-hidden="true">
                        <AgentFlavorIcon flavor="codex" className="h-4 w-4" />
                    </div>
                    <span className="min-w-0 flex-1 truncate" title={accountDetails}>{accountDetails}</span>
                </div>
            </section>
            {mode !== 'api' && props.rows.length > 0 ? <section aria-label={t('usage.remaining')}>
                <h3 className={heading}>{t('usage.remaining')}</h3>
                <div className={`${group} space-y-3`}>
                    {props.rows.map((row, index) => <div key={`${row.label}-${index}`} className={index ? 'border-t border-[var(--app-border)] pt-3' : ''}>
                        <div className="mb-2 flex justify-between gap-3"><span>{row.label}</span><span className="font-semibold tabular-nums">{row.remaining === null ? '—' : percent(row.remaining)}</span></div>
                        {row.remaining !== null ? <Bar value={row.remaining} color={row.remaining <= 10 ? 'bg-red-500' : row.remaining <= 25 ? 'bg-amber-500' : 'bg-[var(--app-link)]'} /> : null}
                        <p className="mt-2 text-[13px] text-[var(--app-hint)]">{row.resetAt ? t('session.header.codexLimits.resetAt', { time: row.resetAt }) : t('session.header.codexLimits.resetUnknown')}</p>
                    </div>)}
                </div>
            </section> : null}
            <section aria-label={t('usage.session')}>
                <h3 className={heading}>{t('usage.session')}</h3>
                <div className={group}>
                    {usage ? <>
                        {usage.scope === 'lastTurn' ? <p className="mb-3 text-[13px] text-[var(--app-hint)]">{t('usage.partial')}</p> : null}
                        <div className="flex items-baseline justify-between gap-3"><span>{t(usesBlendedUsage ? 'usage.effectiveTotal' : 'usage.total')}</span><span className="text-2xl font-semibold tabular-nums" title={exact(displayedTotal)}>{number(displayedTotal)}</span></div>
                        <div className="my-4 grid grid-cols-2 gap-4">
                            <div className="flex min-w-0 flex-col items-start text-left" data-testid="codex-usage-input-metric"><div className="flex items-center gap-1.5 text-[13px] text-[var(--app-link)]"><ArrowDownToLine className="h-4 w-4" aria-hidden="true" />{t(nonCachedInput !== null ? 'usage.uncachedInput' : 'usage.input')}</div><div className="mt-1 text-xl font-semibold tabular-nums" title={exact(displayedInput)}>{number(displayedInput)}</div></div>
                            <div className="flex min-w-0 flex-col items-end text-right" data-testid="codex-usage-output-metric"><div className="flex items-center justify-end gap-1.5 text-[13px] text-purple-700 dark:text-purple-300"><ArrowUpFromLine className="h-4 w-4" aria-hidden="true" />{t('usage.output')}</div><div className="mt-1 text-xl font-semibold tabular-nums" title={exact(usage.output)}>{number(usage.output)}</div></div>
                        </div>
                        <div className="space-y-2 border-t border-[var(--app-border)] pt-3">
                            <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-1.5"><Database className="h-4 w-4 text-teal-700 dark:text-teal-300" aria-hidden="true" />{t('usage.cacheRatio')}</span><span className="font-semibold tabular-nums">{ratio === null ? '—' : percent(ratio)}</span></div>
                            {ratio !== null ? <Bar value={ratio} color="bg-teal-600 dark:bg-teal-400" /> : null}
                            <div className="flex justify-between gap-3 text-[13px] text-[var(--app-hint)]"><span>{t('usage.cachedInput')}</span><span className="tabular-nums" title={exact(usage.cachedInput)}>{number(usage.cachedInput)}</span></div>
                        </div>
                    </> : <p className="text-[var(--app-hint)]">{t('usage.empty')}</p>}
                </div>
            </section>
            <div className="flex min-h-11 items-center justify-between gap-3 px-1 text-[13px] text-[var(--app-hint)]">
                <span>{props.error ? t('usage.refreshFailed') : props.isFetching ? t('session.header.codexLimits.updating') : props.updatedAt ? t('session.header.codexLimits.updatedAt', { time: props.updatedAt }) : ''}</span>
                {props.onRefresh ? <button type="button" aria-label={t('usage.refresh')} disabled={props.isFetching} onClick={props.onRefresh} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-link)] disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${props.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" /></button> : null}
            </div>
        </div>
    </BottomDrawer>
}
